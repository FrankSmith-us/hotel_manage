import { Router } from 'express';
import { z } from 'zod';
import { getDb } from '../../db';
import { AppError, asyncHandler, authenticate, canAccessHotel, getScopeFilter, requireRoles } from '../middleware/auth';
import { BUSINESS_RULES } from '../config/businessRules';
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
import { generateCode, isoDateSchema, nowIso, roundMoney } from '../utils/numbers';

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
  leave_type: z.enum([
    'ANNUAL',
    'SICK',
    'PERSONAL',
    'COMP_OFF',
    'MARRIAGE',
    'MATERNITY',
    'PATERNITY',
    'BEREAVEMENT',
    'OVERTIME',
  ]),
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
    const leaveYear = Number(body.start_date.slice(0, 4));
    const tracksBalance = body.leave_type === 'ANNUAL' || body.leave_type === 'COMP_OFF';

    // D-02: GENERAL_MANAGER leave uses filing/auto-approve mode
    if (user.role === 'GENERAL_MANAGER') {
      const leaveId = await db.transaction(async (tx) => {
        if (tracksBalance) {
          const bal = await tx.queryOne<{ id: number; total_days: number; used_days: number; pending_days: number }>(
            `SELECT id, total_days, used_days, pending_days FROM leave_balances
             WHERE employee_id = ? AND year = ? AND leave_type = ?`,
            [user.employee_id, leaveYear, body.leave_type]
          );
          if (bal) {
            const avail = roundMoney(Number(bal.total_days) - Number(bal.used_days) - Number(bal.pending_days));
            if (effectiveDays > avail) {
              throw new AppError(400, `剩余${body.leave_type === 'ANNUAL' ? '年假' : '调休'}额度不足（可用 ${avail} 天）`);
            }
            await tx.execute(
              `UPDATE leave_balances SET used_days = ?, updated_at = ? WHERE id = ?`,
              [roundMoney(Number(bal.used_days) + effectiveDays), ts, bal.id]
            );
          }
        }
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
      if (tracksBalance) {
        const bal = await tx.queryOne<{ id: number; total_days: number; used_days: number; pending_days: number }>(
          `SELECT id, total_days, used_days, pending_days FROM leave_balances
           WHERE employee_id = ? AND year = ? AND leave_type = ?`,
          [user.employee_id, leaveYear, body.leave_type]
        );
        if (bal) {
          const avail = roundMoney(Number(bal.total_days) - Number(bal.used_days) - Number(bal.pending_days));
          if (effectiveDays > avail) {
            throw new AppError(400, `剩余${body.leave_type === 'ANNUAL' ? '年假' : '调休'}额度不足（可用 ${avail} 天）`);
          }
          await tx.execute(
            `UPDATE leave_balances SET pending_days = ?, updated_at = ? WHERE id = ?`,
            [roundMoney(Number(bal.pending_days) + effectiveDays), ts, bal.id]
          );
        }
      }
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
        const leave = await tx.queryOne<{
          id: number;
          employee_id: number;
          leave_type: string;
          start_date: string;
          days: number;
          status: string;
        }>(
          `SELECT id, employee_id, leave_type, start_date, days, status FROM leave_requests WHERE id = ?${tx.forUpdateSuffix()}`,
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
        if (leave.leave_type === 'ANNUAL' || leave.leave_type === 'COMP_OFF') {
          const yr = Number(leave.start_date.slice(0, 4));
          await tx.execute(
            `UPDATE leave_balances SET pending_days = MAX(0, pending_days - ?), updated_at = ?
             WHERE employee_id = ? AND year = ? AND leave_type = ?`,
            [leave.days, ts, leave.employee_id, yr, leave.leave_type]
          );
        }
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
        leave_type: string;
        start_date: string;
        days: number;
        status: string;
        current_step: number;
      }>(
        `SELECT id, employee_id, hotel_id, leave_type, start_date, days, status, current_step
         FROM leave_requests WHERE id = ?${tx.forUpdateSuffix()}`,
        [id]
      );
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

      const tracksBal = leave.leave_type === 'ANNUAL' || leave.leave_type === 'COMP_OFF';
      const yr = Number(leave.start_date.slice(0, 4));

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
        if (tracksBal) {
          await tx.execute(
            `UPDATE leave_balances SET pending_days = MAX(0, pending_days - ?), updated_at = ?
             WHERE employee_id = ? AND year = ? AND leave_type = ?`,
            [leave.days, ts, leave.employee_id, yr, leave.leave_type]
          );
        }
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
          if (tracksBal) {
            await tx.execute(
              `UPDATE leave_balances
               SET pending_days = MAX(0, pending_days - ?), used_days = used_days + ?, updated_at = ?
               WHERE employee_id = ? AND year = ? AND leave_type = ?`,
              [leave.days, leave.days, ts, leave.employee_id, yr, leave.leave_type]
            );
          }
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

router.post(
  '/:id/revoke',
  asyncHandler(async (req, res) => {
    const id = Number(req.params.id);
    const { reason } = z.object({ reason: z.string().optional().default('销假退还额度') }).parse(req.body || {});
    const user = req.user!;
    const db = getDb();
    const ts = nowIso();

    await db.transaction(async (tx) => {
      const leave = await tx.queryOne<{
        id: number;
        employee_id: number;
        hotel_id: number;
        leave_type: string;
        start_date: string;
        days: number;
        status: string;
      }>(`SELECT * FROM leave_requests WHERE id = ?${tx.forUpdateSuffix()}`, [id]);
      if (!leave) throw new AppError(404, '请假申请不存在');
      if (leave.status !== 'APPROVED') throw new AppError(400, '仅已通过的请假申请可办理销假');

      const isSelf = user.employee_id && Number(user.employee_id) === Number(leave.employee_id);
      const isManager =
        ['HQ_ADMIN', 'HR_MANAGER', 'STORE_MANAGER', 'REGIONAL_MANAGER'].includes(user.role) &&
        (await canAccessHotel(user, leave.hotel_id));
      if (!isSelf && !isManager) {
        throw new AppError(403, '无权为该员工办理销假');
      }

      const upd = await tx.execute(
        `UPDATE leave_requests SET status = 'REVOKED', approval_remark = ?, updated_at = ?
         WHERE id = ? AND status = 'APPROVED'`,
        [reason, ts, id]
      );
      if (upd.affectedRows !== 1) throw new AppError(409, '请假单状态已变更，请刷新后重试');

      if (leave.leave_type === 'ANNUAL' || leave.leave_type === 'COMP_OFF') {
        const yr = Number(leave.start_date.slice(0, 4));
        await tx.execute(
          `UPDATE leave_balances SET used_days = MAX(0, used_days - ?), updated_at = ?
           WHERE employee_id = ? AND year = ? AND leave_type = ?`,
          [leave.days, ts, leave.employee_id, yr, leave.leave_type]
        );
      }

      await logApprovalAction(tx, {
        bizType: 'LEAVE',
        bizId: id,
        action: 'REVOKE',
        actor: user,
        comment: reason,
      });
    });

    res.json({ ok: true, status: 'REVOKED' });
  })
);

router.get(
  '/balances',
  asyncHandler(async (req, res) => {
    const db = getDb();
    const user = req.user!;
    const year = Number(req.query.year || new Date().getFullYear());
    const scope = await getScopeFilter(user);

    const cond = ['lb.year = ?'];
    const params: unknown[] = [year];
    if (scope.type === 'SELF') {
      cond.push('lb.employee_id = ?');
      params.push(scope.employeeId ?? -1);
    } else if (scope.type === 'HOTEL') {
      cond.push('e.hotel_id = ?');
      params.push(scope.hotelId);
    } else if (scope.type === 'REGION') {
      if (scope.hotelIds.length === 0) {
        res.json({ balances: [] });
        return;
      }
      cond.push(`e.hotel_id IN (${scope.hotelIds.map(() => '?').join(',')})`);
      params.push(...scope.hotelIds);
    }

    const balances = await db.query(
      `SELECT lb.*, e.name AS emp_name, e.emp_no, h.name AS hotel_name
       FROM leave_balances lb
       JOIN employees e ON e.id = lb.employee_id
       JOIN hotels h ON h.id = e.hotel_id
       WHERE ${cond.join(' AND ')}
       ORDER BY e.id ASC, lb.leave_type ASC`,
      params
    );
    res.json({ balances });
  })
);

router.post(
  '/balances/init',
  requireRoles('HQ_ADMIN', 'HR_MANAGER'),
  asyncHandler(async (req, res) => {
    const { year } = z.object({ year: z.number().int().min(2020).max(2099) }).parse(req.body);
    const db = getDb();
    const ts = nowIso();
    const employees = await db.query<{ id: number; hire_date: string }>(
      `SELECT id, hire_date FROM employees WHERE status IN ('ACTIVE', 'PROBATION')`
    );

    let initialized = 0;
    await db.transaction(async (tx) => {
      for (const emp of employees) {
        const hireYear = Number(emp.hire_date.slice(0, 4));
        const tenureYears = Math.max(0, year - hireYear);
        let annualDays = BUSINESS_RULES.annualLeave.under10Years;
        if (tenureYears >= 20) annualDays = BUSINESS_RULES.annualLeave.over20Years;
        else if (tenureYears >= 10) annualDays = BUSINESS_RULES.annualLeave.under20Years;

        const existing = await tx.queryOne<{ id: number }>(
          `SELECT id FROM leave_balances WHERE employee_id = ? AND year = ? AND leave_type = 'ANNUAL'`,
          [emp.id, year]
        );
        if (!existing) {
          await tx.execute(
            `INSERT INTO leave_balances (employee_id, year, leave_type, total_days, used_days, pending_days, updated_at)
             VALUES (?, ?, 'ANNUAL', ?, 0, 0, ?)`,
            [emp.id, year, annualDays, ts]
          );
          initialized++;
        }
      }
    });

    res.json({ ok: true, year, initialized });
  })
);

router.get(
  '/holidays',
  asyncHandler(async (req, res) => {
    const db = getDb();
    const year = Number(req.query.year || new Date().getFullYear());
    const holidays = await db.query(
      'SELECT * FROM holiday_calendar WHERE year = ? ORDER BY holiday_date ASC',
      [year]
    );
    res.json({ holidays });
  })
);

router.post(
  '/holidays',
  requireRoles('HQ_ADMIN', 'HR_MANAGER'),
  asyncHandler(async (req, res) => {
    const body = z
      .object({
        holiday_date: isoDateSchema,
        name: z.string().trim().min(1),
        day_type: z.enum(['HOLIDAY', 'WORKDAY']).default('HOLIDAY'),
      })
      .parse(req.body);

    const db = getDb();
    const ts = nowIso();
    const year = Number(body.holiday_date.slice(0, 4));
    const existing = await db.queryOne<{ id: number }>(
      'SELECT id FROM holiday_calendar WHERE holiday_date = ?',
      [body.holiday_date]
    );
    if (existing) {
      await db.execute(
        'UPDATE holiday_calendar SET name = ?, day_type = ?, year = ? WHERE id = ?',
        [body.name, body.day_type, year, existing.id]
      );
    } else {
      await db.execute(
        `INSERT INTO holiday_calendar (holiday_date, name, day_type, year, created_at)
         VALUES (?, ?, ?, ?, ?)`,
        [body.holiday_date, body.name, body.day_type, year, ts]
      );
    }
    const holiday = await db.queryOne('SELECT * FROM holiday_calendar WHERE holiday_date = ?', [body.holiday_date]);
    res.status(201).json({ holiday });
  })
);

router.get(
  '/overtime',
  asyncHandler(async (req, res) => {
    const db = getDb();
    const user = req.user!;
    const scope = await getScopeFilter(user);
    const cond = ['1=1'];
    const params: unknown[] = [];

    if (scope.type === 'SELF') {
      cond.push('o.employee_id = ?');
      params.push(scope.employeeId ?? -1);
    } else if (scope.type === 'HOTEL') {
      cond.push('o.hotel_id = ?');
      params.push(scope.hotelId);
    } else if (scope.type === 'REGION') {
      if (scope.hotelIds.length === 0) {
        res.json({ overtimeRequests: [] });
        return;
      }
      cond.push(`o.hotel_id IN (${scope.hotelIds.map(() => '?').join(',')})`);
      params.push(...scope.hotelIds);
    }

    const rows = await db.query<{
      id: number;
      request_no: string;
      employee_id: number;
      hotel_id: number;
      overtime_date: string;
      day_type: string;
      hours: number;
      comp_mode: string;
      multiplier: number;
      reason: string;
      status: string;
      current_step: number;
      emp_name: string;
      hotel_name: string;
    }>(
      `SELECT o.*, e.name AS emp_name, h.name AS hotel_name
       FROM overtime_requests o
       JOIN employees e ON e.id = o.employee_id
       JOIN hotels h ON h.id = o.hotel_id
       WHERE ${cond.join(' AND ')}
       ORDER BY o.id DESC`,
      params
    );

    const overtimeRequests = [];
    for (const r of rows) {
      const steps = await getWorkflowStepsWithActors(db, 'OVERTIME', r.id);
      const pendingStep =
        r.status === 'PENDING_APPROVAL'
          ? await db.queryOne<{ approver_role: UserRole; approver_user_id: number | null }>(
              `SELECT approver_role, approver_user_id FROM approval_steps
               WHERE biz_type = 'OVERTIME' AND biz_id = ? AND status = 'PENDING'
               ORDER BY step_order ASC LIMIT 1`,
              [r.id]
            )
          : null;
      const canApprove = pendingStep
        ? await canUserActOnStep(db, user, pendingStep.approver_role, r.hotel_id, -1, {
            approverUserId: pendingStep.approver_user_id,
            bizType: 'OVERTIME',
          })
        : false;
      overtimeRequests.push({ ...r, steps, canApprove });
    }
    res.json({ overtimeRequests });
  })
);

router.post(
  '/overtime',
  asyncHandler(async (req, res) => {
    const body = z
      .object({
        overtime_date: isoDateSchema,
        hours: z.number().positive(),
        day_type: z.enum(['WORKDAY', 'RESTDAY', 'HOLIDAY']).optional(),
        comp_mode: z.enum(['COMP_OFF', 'PAY']).optional(),
        reason: z.string().trim().min(2),
      })
      .parse(req.body);

    const user = req.user!;
    if (!user.employee_id || !user.hotel_id) {
      throw new AppError(400, '当前账号未绑定员工档案');
    }
    if (body.hours > BUSINESS_RULES.overtime.maxHoursPerRequest) {
      throw new AppError(400, `单次加班申请不能超过 ${BUSINESS_RULES.overtime.maxHoursPerRequest} 小时`);
    }

    const db = getDb();
    const ym = body.overtime_date.slice(0, 7);
    const monthSumRow = await db.queryOne<{ total_h: number }>(
      `SELECT COALESCE(SUM(hours), 0) AS total_h FROM overtime_requests
       WHERE employee_id = ? AND overtime_date LIKE ? AND status IN ('PENDING_APPROVAL', 'APPROVED')`,
      [user.employee_id, `${ym}%`]
    );
    const currentMonthHours = Number(monthSumRow?.total_h || 0);
    if (currentMonthHours + body.hours > BUSINESS_RULES.overtime.maxHoursPerMonth) {
      throw new AppError(
        400,
        `当月累计加班不能超过 ${BUSINESS_RULES.overtime.maxHoursPerMonth} 小时（已申请 ${currentMonthHours}h）`
      );
    }

    let dayType = body.day_type;
    if (!dayType) {
      const hol = await db.queryOne<{ day_type: string }>(
        'SELECT day_type FROM holiday_calendar WHERE holiday_date = ?',
        [body.overtime_date]
      );
      if (hol?.day_type === 'HOLIDAY') dayType = 'HOLIDAY';
      else if (hol?.day_type === 'WORKDAY') dayType = 'WORKDAY';
      else {
        const wd = new Date(`${body.overtime_date}T00:00:00Z`).getUTCDay();
        dayType = wd === 0 || wd === 6 ? 'RESTDAY' : 'WORKDAY';
      }
    }

    const multiplier =
      dayType === 'HOLIDAY'
        ? BUSINESS_RULES.overtime.holidayRate
        : dayType === 'RESTDAY'
          ? BUSINESS_RULES.overtime.restdayRate
          : BUSINESS_RULES.overtime.workdayRate;
    const compMode = body.comp_mode ?? (dayType === 'RESTDAY' ? 'COMP_OFF' : 'PAY');

    const ts = nowIso();
    const requestNo = generateCode('OT');
    const otId = await db.transaction(async (tx) => {
      const ins = await tx.execute(
        `INSERT INTO overtime_requests (
          request_no, employee_id, hotel_id, overtime_date, day_type, hours, comp_mode, multiplier,
          reason, status, current_step, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'PENDING_APPROVAL', 1, ?, ?)`,
        [requestNo, user.employee_id, user.hotel_id, body.overtime_date, dayType, body.hours, compMode, multiplier, body.reason, ts, ts]
      );
      const resolved = await resolveApprovalRoute(
        tx,
        user.hotel_id!,
        buildLeaveRoute({ applicantRole: user.role, days: 0.5 }),
        user.id
      );
      await replaceApprovalSteps(tx, 'OVERTIME', ins.insertId, resolved.steps);
      await logApprovalAction(tx, {
        bizType: 'OVERTIME',
        bizId: ins.insertId,
        action: 'SUBMIT',
        actor: user,
        comment: `加班申请：${body.overtime_date} ${body.hours}h (${dayType}/${compMode})`,
      });
      return ins.insertId;
    });

    const overtimeRequest = await db.queryOne('SELECT * FROM overtime_requests WHERE id = ?', [otId]);
    res.status(201).json({ overtimeRequest });
  })
);

router.post(
  '/overtime/:id/action',
  asyncHandler(async (req, res) => {
    const id = Number(req.params.id);
    const { action, comment } = z
      .object({
        action: z.enum(['APPROVE', 'REJECT']),
        comment: z.string().optional().default(''),
      })
      .parse(req.body);

    const db = getDb();
    const user = req.user!;
    const ts = nowIso();

    await db.transaction(async (tx) => {
      const ot = await tx.queryOne<{
        id: number;
        employee_id: number;
        hotel_id: number;
        overtime_date: string;
        hours: number;
        comp_mode: string;
        status: string;
      }>(`SELECT * FROM overtime_requests WHERE id = ?${tx.forUpdateSuffix()}`, [id]);
      if (!ot) throw new AppError(404, '加班申请不存在');
      if (ot.status !== 'PENDING_APPROVAL') throw new AppError(400, '当前状态不可审批');

      const step = await tx.queryOne<{ id: number; step_order: number; approver_role: UserRole; approver_user_id: number | null }>(
        `SELECT id, step_order, approver_role, approver_user_id FROM approval_steps
         WHERE biz_type = 'OVERTIME' AND biz_id = ? AND status = 'PENDING'
         ORDER BY step_order ASC LIMIT 1`,
        [id]
      );
      if (!step) throw new AppError(400, '未找到待审批节点');
      if (
        !(await canUserActOnStep(tx, user, step.approver_role, ot.hotel_id, -1, {
          approverUserId: step.approver_user_id,
          bizType: 'OVERTIME',
        }))
      ) {
        throw new AppError(403, '无权审批该加班申请');
      }

      if (action === 'REJECT') {
        await tx.execute(
          `UPDATE approval_steps SET status = 'REJECTED', acted_by = ?, acted_at = ?, comment = ? WHERE id = ?`,
          [user.id, ts, comment || '驳回', step.id]
        );
        await tx.execute(`UPDATE overtime_requests SET status = 'REJECTED', updated_at = ? WHERE id = ?`, [ts, id]);
      } else {
        await tx.execute(
          `UPDATE approval_steps SET status = 'APPROVED', acted_by = ?, acted_at = ?, comment = ? WHERE id = ?`,
          [user.id, ts, comment || '同意', step.id]
        );
        await tx.execute(
          `UPDATE overtime_requests SET status = 'APPROVED', approved_at = ?, updated_at = ? WHERE id = ?`,
          [ts, ts, id]
        );
        if (ot.comp_mode === 'COMP_OFF') {
          const yr = Number(ot.overtime_date.slice(0, 4));
          const addDaysVal = roundMoney(Number(ot.hours) / 8);
          const bal = await tx.queryOne<{ id: number; total_days: number }>(
            `SELECT id, total_days FROM leave_balances WHERE employee_id = ? AND year = ? AND leave_type = 'COMP_OFF'`,
            [ot.employee_id, yr]
          );
          if (bal) {
            await tx.execute(
              `UPDATE leave_balances SET total_days = ?, updated_at = ? WHERE id = ?`,
              [roundMoney(Number(bal.total_days) + addDaysVal), ts, bal.id]
            );
          } else {
            await tx.execute(
              `INSERT INTO leave_balances (employee_id, year, leave_type, total_days, used_days, pending_days, updated_at)
               VALUES (?, ?, 'COMP_OFF', ?, 0, 0, ?)`,
              [ot.employee_id, yr, addDaysVal, ts]
            );
          }
        }
      }

      await logApprovalAction(tx, {
        bizType: 'OVERTIME',
        bizId: id,
        action,
        actor: user,
        comment: comment || (action === 'APPROVE' ? '同意加班' : '驳回加班'),
      });
    });

    res.json({ ok: true });
  })
);

export default router;
