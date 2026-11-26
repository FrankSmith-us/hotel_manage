import { Router } from 'express';
import { z } from 'zod';
import { getDb } from '../../db';
import { AppError, asyncHandler, authenticate, getScopeFilter } from '../middleware/auth';
import { logApprovalAction } from '../services/auditService';
import {
  buildLeaveRoute,
  buildStatusDetail,
  canUserActOnStep,
  getUserLastHandledAction,
  getWorkflowStepsWithActors,
  replaceApprovalSteps,
  resolveApprovalRoute,
} from '../services/workflowEngine';
import { UserRole } from '../types';
import { generateCode, isoDateSchema, nowIso } from '../utils/numbers';

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
    } else if (tab === 'handled') {
      conditions.push(
        `(EXISTS (SELECT 1 FROM approval_steps s WHERE s.biz_type = 'LEAVE' AND s.biz_id = l.id AND s.acted_by = ?)
          OR EXISTS (SELECT 1 FROM approval_logs al WHERE al.biz_type = 'LEAVE' AND al.biz_id = l.id AND al.actor_id = ? AND al.action IN ('APPROVE', 'REJECT')))`
      );
      params.push(user.id, user.id);
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
      `SELECT l.*, e.name AS emp_name, e.emp_no, e.position, h.name AS hotel_name,
              (SELECT u.id FROM users u WHERE u.employee_id = e.id AND u.is_active = 1 ORDER BY u.id ASC LIMIT 1) AS applicant_user_id
       FROM leave_requests l
       JOIN employees e ON e.id = l.employee_id
       JOIN hotels h ON h.id = l.hotel_id
       WHERE ${conditions.join(' AND ')}
       ORDER BY CASE WHEN l.urgency = 'URGENT' THEN 0 ELSE 1 END ASC, l.id DESC`,
      params
    );

    const enriched = [];
    for (const row of rows) {
      const pendingStep =
        row.status === 'PENDING_APPROVAL'
          ? await db.queryOne<{ step_name: string; approver_role: UserRole; approver_user_id: number | null }>(
              `SELECT step_name, approver_role, approver_user_id FROM approval_steps
               WHERE biz_type = 'LEAVE' AND biz_id = ? AND status = 'PENDING'
               ORDER BY step_order ASC LIMIT 1`,
              [row.id]
            )
          : null;

      const canApprove = pendingStep
        ? await canUserActOnStep(db, user, pendingStep.approver_role, row.hotel_id, row.applicant_user_id ?? -1, {
            approverUserId: pendingStep.approver_user_id,
            bizType: 'LEAVE',
          })
        : false;

      if (tab === 'pending' && !canApprove) continue;

      const steps = await getWorkflowStepsWithActors(db, 'LEAVE', row.id);
      const handledInfo =
        tab === 'handled'
          ? await getUserLastHandledAction(db, 'LEAVE', row.id, user.id)
          : { my_last_action: null, my_acted_at: null };

      enriched.push({
        ...row,
        current_step_name: pendingStep?.step_name ?? null,
        steps,
        status_detail: buildStatusDetail({
          bizType: 'LEAVE',
          status: row.status,
          currentStepName: pendingStep?.step_name ?? null,
          currentStep: row.current_step,
          totalSteps: steps.length,
        }),
        my_last_action: handledInfo.my_last_action,
        my_acted_at: handledInfo.my_acted_at,
        canApprove,
      });
    }

    res.json({ leaves: enriched });
  })
);

const createLeaveSchema = z.object({
  leave_type: z.enum(['ANNUAL', 'SICK', 'PERSONAL', 'COMP_OFF', 'OVERTIME']),
  start_date: isoDateSchema,
  end_date: isoDateSchema,
  days: z.number().min(0).max(365).default(0),
  hours: z.number().min(0).max(2000).default(0),
  reason: z.string().min(2, '请填写事由'),
  urgency: z.enum(['NORMAL', 'URGENT']).default('NORMAL'),
});

router.post(
  '/',
  asyncHandler(async (req, res) => {
    const body = createLeaveSchema.parse(req.body);
    const user = req.user!;
    if (!user.employee_id || !user.hotel_id) {
      throw new AppError(400, '当前账号未绑定员工档案，无法发起休假/加班申请');
    }

    const startMs = Date.parse(`${body.start_date}T00:00:00Z`);
    const endMs = Date.parse(`${body.end_date}T00:00:00Z`);
    if (Number.isNaN(startMs) || Number.isNaN(endMs) || endMs < startMs) {
      throw new AppError(400, '结束日期不能早于开始日期');
    }
    const calendarDays = Math.round((endMs - startMs) / 86_400_000) + 1;
    let effectiveDays = body.days;
    if (body.leave_type === 'OVERTIME') {
      effectiveDays = 0;
      const maxOvertimeHours = Math.min(36, calendarDays * 24);
      if (body.hours <= 0 || body.hours > maxOvertimeHours) {
        throw new AppError(400, `加班时长须在 0.5 ~ ${maxOvertimeHours} 小时之间`);
      }
    } else {
      const minDays = Math.max(0.5, calendarDays - 0.5);
      if (body.days < minDays || body.days > calendarDays) {
        throw new AppError(400, `请假天数与日期区间不匹配（${calendarDays} 天区间应填 ${minDays} ~ ${calendarDays} 天）`);
      }
    }

    const db = getDb();
    const ts = nowIso();
    const requestNo = generateCode('LV');

    // D-02: GENERAL_MANAGER leave uses filing/auto-approve mode
    if (user.role === 'GENERAL_MANAGER') {
      const leaveId = await db.transaction(async (tx) => {
        const ins = await tx.execute(
          `INSERT INTO leave_requests (
            request_no, employee_id, hotel_id, leave_type, start_date, end_date,
            days, hours, reason, urgency, status, current_step, approval_remark, approved_at, created_at, updated_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'APPROVED', 0, '总经理休假备案制自动通过并抄送HR', ?, ?, ?)`,
          [
            requestNo,
            user.employee_id,
            user.hotel_id,
            body.leave_type,
            body.start_date,
            body.end_date,
            effectiveDays,
            body.hours,
            body.reason,
            body.urgency,
            ts,
            ts,
            ts,
          ]
        );
        await logApprovalAction(tx, {
          bizType: 'LEAVE',
          bizId: ins.insertId,
          action: 'AUTO_APPROVE',
          actor: user,
          comment: '总经理休假备案制自动通过并抄送HR',
        });
        return ins.insertId;
      });
      const leave = await db.queryOne('SELECT * FROM leave_requests WHERE id = ?', [leaveId]);
      res.status(201).json({ leave });
      return;
    }

    const resolved = await resolveApprovalRoute(
      db,
      user.hotel_id,
      buildLeaveRoute({ applicantRole: user.role, days: effectiveDays }),
      user.id
    );
    const route = resolved.steps;

    const leaveId = await db.transaction(async (tx) => {
      const ins = await tx.execute(
        `INSERT INTO leave_requests (
          request_no, employee_id, hotel_id, leave_type, start_date, end_date,
          days, hours, reason, urgency, status, current_step, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'PENDING_APPROVAL', 1, ?, ?)`,
        [
          requestNo,
          user.employee_id,
          user.hotel_id,
          body.leave_type,
          body.start_date,
          body.end_date,
          effectiveDays,
          body.hours,
          body.reason,
          body.urgency,
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
      if (resolved.skippedRegionalManager && resolved.skipReason) {
        await logApprovalAction(tx, {
          bizType: 'LEAVE',
          bizId: ins.insertId,
          action: 'AUTO_SKIP',
          actor: user,
          comment: resolved.skipReason,
        });
      }
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

    const ts = nowIso();
    if (action === 'CANCEL') {
      await db.transaction(async (tx) => {
        const leave = await tx.queryOne<{ id: number; employee_id: number; status: string }>(
          `SELECT id, employee_id, status FROM leave_requests WHERE id = ?${tx.forUpdateSuffix()}`,
          [id]
        );
        if (!leave) throw new AppError(404, '请假/加班申请不存在');
        if (leave.employee_id !== user.employee_id) {
          throw new AppError(403, '仅申请人本人可撤销');
        }
        if (leave.status !== 'PENDING_APPROVAL') {
          throw new AppError(400, '当前申请状态不可撤销');
        }
        const upd = await tx.execute(
          `UPDATE leave_requests SET status = 'CANCELLED', updated_at = ? WHERE id = ? AND status = 'PENDING_APPROVAL'`,
          [ts, id]
        );
        if (upd.affectedRows !== 1) throw new AppError(409, '申请状态已变更，请刷新后重试');
        await logApprovalAction(tx, {
          bizType: 'LEAVE',
          bizId: id,
          action: 'CANCEL',
          actor: user,
          comment: comment || '申请人主动撤销',
        });
      });
      res.json({ ok: true, status: 'CANCELLED' });
      return;
    }

    await db.transaction(async (tx) => {
      const leave = await tx.queryOne<{
        id: number;
        employee_id: number;
        hotel_id: number;
        status: string;
        current_step: number;
      }>(`SELECT id, employee_id, hotel_id, status, current_step FROM leave_requests WHERE id = ?${tx.forUpdateSuffix()}`, [id]);
      if (!leave) throw new AppError(404, '请假/加班申请不存在');
      if (leave.status !== 'PENDING_APPROVAL') {
        throw new AppError(400, '当前申请状态不可操作');
      }

      const applicantUser = await tx.queryOne<{ id: number }>(
        'SELECT id FROM users WHERE employee_id = ? AND is_active = 1 ORDER BY id ASC LIMIT 1',
        [leave.employee_id]
      );
      const step = await tx.queryOne<{
        id: number;
        step_order: number;
        approver_role: UserRole;
        approver_user_id: number | null;
      }>(
        `SELECT id, step_order, approver_role, approver_user_id FROM approval_steps
         WHERE biz_type = 'LEAVE' AND biz_id = ? AND status = 'PENDING'
         ORDER BY step_order ASC LIMIT 1`,
        [id]
      );
      if (!step) throw new AppError(400, '未找到待审批节点');

      const allowed = await canUserActOnStep(
        tx,
        user,
        step.approver_role,
        leave.hotel_id,
        applicantUser?.id ?? -1,
        { approverUserId: step.approver_user_id, bizType: 'LEAVE' }
      );
      if (!allowed) throw new AppError(403, '您无权审批当前节点');

      if (action === 'REJECT') {
        const stepUpd = await tx.execute(
          `UPDATE approval_steps SET status = 'REJECTED', acted_by = ?, acted_at = ?, comment = ? WHERE id = ? AND status = 'PENDING'`,
          [user.id, ts, comment || '驳回', step.id]
        );
        if (stepUpd.affectedRows !== 1) throw new AppError(409, '审批节点状态已变更，请刷新后重试');
        const lvUpd = await tx.execute(
          `UPDATE leave_requests SET status = 'REJECTED', approver_id = ?, approval_remark = ?, updated_at = ?
           WHERE id = ? AND status = 'PENDING_APPROVAL'`,
          [user.id, comment || '驳回', ts, id]
        );
        if (lvUpd.affectedRows !== 1) throw new AppError(409, '申请状态已变更，请刷新后重试');
      } else {
        const stepUpd = await tx.execute(
          `UPDATE approval_steps SET status = 'APPROVED', acted_by = ?, acted_at = ?, comment = ? WHERE id = ? AND status = 'PENDING'`,
          [user.id, ts, comment || '同意', step.id]
        );
        if (stepUpd.affectedRows !== 1) throw new AppError(409, '审批节点状态已变更，请刷新后重试');
        const nextStep = await tx.queryOne<{ id: number; step_order: number }>(
          `SELECT id, step_order FROM approval_steps
           WHERE biz_type = 'LEAVE' AND biz_id = ? AND step_order > ?
           ORDER BY step_order ASC LIMIT 1`,
          [id, step.step_order]
        );
        if (nextStep) {
          await tx.execute(`UPDATE approval_steps SET status = 'PENDING' WHERE id = ?`, [nextStep.id]);
          await tx.execute(
            `UPDATE leave_requests SET current_step = ?, updated_at = ? WHERE id = ? AND status = 'PENDING_APPROVAL'`,
            [nextStep.step_order, ts, id]
          );
        } else {
          const lvUpd = await tx.execute(
            `UPDATE leave_requests SET status = 'APPROVED', approver_id = ?, approval_remark = ?, approved_at = ?, updated_at = ?
             WHERE id = ? AND status = 'PENDING_APPROVAL'`,
            [user.id, comment || '同意', ts, ts, id]
          );
          if (lvUpd.affectedRows !== 1) throw new AppError(409, '申请状态已变更，请刷新后重试');
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
