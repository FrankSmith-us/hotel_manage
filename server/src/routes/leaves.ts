import { Router } from 'express';
import { z } from 'zod';
import { getDb } from '../../db';
import { AppError, asyncHandler, authenticate, getScopeFilter } from '../middleware/auth';
import { logApprovalAction } from '../services/auditService';
import { buildLeaveRoute, canUserActOnStep, replaceApprovalSteps } from '../services/workflowEngine';
import { UserRole } from '../types';
import { generateCode, nowIso } from '../utils/numbers';

const router = Router();
router.use(authenticate);

router.get(
  '/',
  asyncHandler(async (req, res) => {
    const db = getDb();
    const user = req.user!;
    const tab = String(req.query.tab || 'all');
    const scope = await getScopeFilter(user);

    const conditions: string[] = ['1=1'];
    const params: unknown[] = [];

    if (tab === 'mine') {
      if (user.employee_id) {
        conditions.push('l.employee_id = ?');
        params.push(user.employee_id);
      } else {
        res.json({ leaves: [] });
        return;
      }
    } else if (tab !== 'pending') {
      if (scope.type === 'REGION') {
        if (scope.hotelIds.length === 0) {
          res.json({ leaves: [] });
          return;
        }
        conditions.push(`l.hotel_id IN (${scope.hotelIds.map(() => '?').join(',')})`);
        params.push(...scope.hotelIds);
      } else if (scope.type === 'HOTEL') {
        conditions.push('l.hotel_id = ?');
        params.push(scope.hotelId);
      } else if (scope.type === 'SELF') {
        conditions.push('l.employee_id = ?');
        params.push(scope.employeeId);
      }
    }

    if (req.query.status) {
      conditions.push('l.status = ?');
      params.push(String(req.query.status));
    }
    if (req.query.leaveType) {
      conditions.push('l.leave_type = ?');
      params.push(String(req.query.leaveType));
    }

    const rows = await db.query<{
      id: number;
      request_no: string;
      employee_id: number;
      hotel_id: number;
      leave_type: string;
      start_date: string;
      end_date: string;
      days: number;
      hours: number;
      reason: string;
      status: string;
      current_step: number;
      approval_remark: string | null;
      created_at: string;
      emp_name: string;
      emp_no: string;
      position: string;
      hotel_name: string;
      applicant_user_id: number | null;
    }>(
      `SELECT l.*, e.name AS emp_name, e.emp_no, e.position, h.name AS hotel_name, u.id AS applicant_user_id
       FROM leave_requests l
       JOIN employees e ON e.id = l.employee_id
       JOIN hotels h ON h.id = l.hotel_id
       LEFT JOIN users u ON u.employee_id = e.id
       WHERE ${conditions.join(' AND ')}
       ORDER BY l.id DESC`,
      params
    );

    const enriched = [];
    for (const row of rows) {
      const pendingStep =
        row.status === 'PENDING_APPROVAL'
          ? await db.queryOne<{ step_name: string; approver_role: UserRole }>(
              `SELECT step_name, approver_role FROM approval_steps
               WHERE biz_type = 'LEAVE' AND biz_id = ? AND status = 'PENDING'
               ORDER BY step_order ASC LIMIT 1`,
              [row.id]
            )
          : null;

      const canApprove = pendingStep
        ? await canUserActOnStep(db, user, pendingStep.approver_role, row.hotel_id, row.applicant_user_id ?? -1)
        : false;

      if (tab === 'pending' && !canApprove) continue;

      enriched.push({
        ...row,
        current_step_name: pendingStep?.step_name ?? null,
        canApprove,
      });
    }

    res.json({ leaves: enriched });
  })
);

const createLeaveSchema = z.object({
  leave_type: z.enum(['ANNUAL', 'SICK', 'PERSONAL', 'COMP_OFF', 'OVERTIME']),
  start_date: z.string().min(8),
  end_date: z.string().min(8),
  days: z.number().min(0).default(0),
  hours: z.number().min(0).default(0),
  reason: z.string().min(2, '请填写事由'),
});

router.post(
  '/',
  asyncHandler(async (req, res) => {
    const body = createLeaveSchema.parse(req.body);
    const user = req.user!;
    if (!user.employee_id || !user.hotel_id) {
      throw new AppError(400, '当前账号未绑定员工档案，无法发起休假/加班申请');
    }

    const db = getDb();
    const ts = nowIso();
    const requestNo = generateCode('LV');
    const route = buildLeaveRoute({ applicantRole: user.role, days: body.days });

    const leaveId = await db.transaction(async (tx) => {
      const ins = await tx.execute(
        `INSERT INTO leave_requests (
          request_no, employee_id, hotel_id, leave_type, start_date, end_date,
          days, hours, reason, status, current_step, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'PENDING_APPROVAL', 1, ?, ?)`,
        [
          requestNo,
          user.employee_id,
          user.hotel_id,
          body.leave_type,
          body.start_date,
          body.end_date,
          body.days,
          body.hours,
          body.reason,
          ts,
          ts,
        ]
      );
      await replaceApprovalSteps(tx, 'LEAVE', ins.insertId, route);
      await logApprovalAction(tx, {
        bizType: 'LEAVE',
        bizId: ins.insertId,
        action: 'SUBMIT',
        actor: user,
        comment: body.reason,
      });
      return ins.insertId;
    });

    const leave = await db.queryOne('SELECT * FROM leave_requests WHERE id = ?', [leaveId]);
    res.status(201).json({ leave });
  })
);

const actionSchema = z.object({
  action: z.enum(['APPROVE', 'REJECT', 'CANCEL']),
  comment: z.string().optional().default(''),
});

router.post(
  '/:id/action',
  asyncHandler(async (req, res) => {
    const id = Number(req.params.id);
    const { action, comment } = actionSchema.parse(req.body);
    const user = req.user!;
    const db = getDb();

    const leave = await db.queryOne<{
      id: number;
      employee_id: number;
      hotel_id: number;
      status: string;
      current_step: number;
    }>('SELECT id, employee_id, hotel_id, status, current_step FROM leave_requests WHERE id = ?', [id]);
    if (!leave) throw new AppError(404, '请假/加班申请不存在');
    if (leave.status !== 'PENDING_APPROVAL') {
      throw new AppError(400, '当前申请状态不可操作');
    }

    const ts = nowIso();
    if (action === 'CANCEL') {
      if (leave.employee_id !== user.employee_id) {
        throw new AppError(403, '仅申请人本人可撤销');
      }
      await db.execute(
        `UPDATE leave_requests SET status = 'CANCELLED', updated_at = ? WHERE id = ?`,
        [ts, id]
      );
      res.json({ ok: true, status: 'CANCELLED' });
      return;
    }

    const applicantUser = await db.queryOne<{ id: number }>(
      'SELECT id FROM users WHERE employee_id = ?',
      [leave.employee_id]
    );
    const step = await db.queryOne<{
      id: number;
      step_order: number;
      approver_role: UserRole;
    }>(
      `SELECT id, step_order, approver_role FROM approval_steps
       WHERE biz_type = 'LEAVE' AND biz_id = ? AND status = 'PENDING'
       ORDER BY step_order ASC LIMIT 1`,
      [id]
    );
    if (!step) throw new AppError(400, '未找到待审批节点');

    const allowed = await canUserActOnStep(
      db,
      user,
      step.approver_role,
      leave.hotel_id,
      applicantUser?.id ?? -1
    );
    if (!allowed) throw new AppError(403, '您无权审批当前节点');

    await db.transaction(async (tx) => {
      if (action === 'REJECT') {
        await tx.execute(
          `UPDATE approval_steps SET status = 'REJECTED', acted_by = ?, acted_at = ?, comment = ? WHERE id = ?`,
          [user.id, ts, comment || '驳回', step.id]
        );
        await tx.execute(
          `UPDATE leave_requests SET status = 'REJECTED', approver_id = ?, approval_remark = ?, updated_at = ? WHERE id = ?`,
          [user.id, comment || '驳回', ts, id]
        );
      } else {
        await tx.execute(
          `UPDATE approval_steps SET status = 'APPROVED', acted_by = ?, acted_at = ?, comment = ? WHERE id = ?`,
          [user.id, ts, comment || '同意', step.id]
        );
        const nextStep = await tx.queryOne<{ id: number; step_order: number }>(
          `SELECT id, step_order FROM approval_steps
           WHERE biz_type = 'LEAVE' AND biz_id = ? AND step_order > ?
           ORDER BY step_order ASC LIMIT 1`,
          [id, step.step_order]
        );
        if (nextStep) {
          await tx.execute(`UPDATE approval_steps SET status = 'PENDING' WHERE id = ?`, [nextStep.id]);
          await tx.execute(
            `UPDATE leave_requests SET current_step = ?, updated_at = ? WHERE id = ?`,
            [nextStep.step_order, ts, id]
          );
        } else {
          await tx.execute(
            `UPDATE leave_requests SET status = 'APPROVED', approver_id = ?, approval_remark = ?, approved_at = ?, updated_at = ? WHERE id = ?`,
            [user.id, comment || '同意', ts, ts, id]
          );
        }
      }
      await logApprovalAction(tx, {
        bizType: 'LEAVE',
        bizId: id,
        action,
        actor: user,
        comment,
      });
    });

    res.json({ ok: true });
  })
);

export default router;
