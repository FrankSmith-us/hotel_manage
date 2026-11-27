import { Router } from 'express';
import { z } from 'zod';
import { getDb } from '../../db';
import {
  AppError,
  asyncHandler,
  authenticate,
  canAccessHotel,
  getScopeFilter,
  requireRoles,
} from '../middleware/auth';
import { logApprovalAction } from '../services/auditService';
import {
  canUserActOnStep,
  getWorkflowStepsWithActors,
  replaceApprovalSteps,
  resolveApprovalRoute,
} from '../services/workflowEngine';
import { UserRole } from '../types';
import { generateCode, isoDateSchema, nowIso } from '../utils/numbers';

const router = Router();
router.use(authenticate);

router.get(
  '/records',
  asyncHandler(async (req, res) => {
    const db = getDb();
    const user = req.user!;
    const scope = await getScopeFilter(user);
    const cond = ['1=1'];
    const params: unknown[] = [];

    if (scope.type === 'SELF') {
      cond.push('a.employee_id = ?');
      params.push(scope.employeeId ?? -1);
    } else if (scope.type === 'HOTEL') {
      cond.push('a.hotel_id = ?');
      params.push(scope.hotelId);
    } else if (scope.type === 'REGION') {
      if (scope.hotelIds.length === 0) {
        res.json({ records: [] });
        return;
      }
      cond.push(`a.hotel_id IN (${scope.hotelIds.map(() => '?').join(',')})`);
      params.push(...scope.hotelIds);
    }

    if (req.query.yearMonth) {
      cond.push('a.attendance_date LIKE ?');
      params.push(`${String(req.query.yearMonth)}%`);
    }
    if (req.query.hotelId && scope.type !== 'SELF' && scope.type !== 'HOTEL') {
      cond.push('a.hotel_id = ?');
      params.push(Number(req.query.hotelId));
    }
    if (req.query.employeeId && scope.type !== 'SELF') {
      cond.push('a.employee_id = ?');
      params.push(Number(req.query.employeeId));
    }

    const records = await db.query(
      `SELECT a.*, e.name AS emp_name, e.emp_no, h.name AS hotel_name
       FROM attendance_records a
       JOIN employees e ON e.id = a.employee_id
       JOIN hotels h ON h.id = e.hotel_id
       WHERE ${cond.join(' AND ')}
       ORDER BY a.attendance_date DESC, a.employee_id ASC`,
      params
    );
    res.json({ records });
  })
);

router.post(
  '/import',
  requireRoles('HQ_ADMIN', 'HR_MANAGER', 'STORE_MANAGER'),
  asyncHandler(async (req, res) => {
    const body = z
      .object({
        records: z
          .array(
            z.object({
              employee_id: z.number().int().positive(),
              attendance_date: isoDateSchema,
              scheduled_shift: z.string().optional().nullable(),
              check_in_time: z.string().optional().nullable(),
              check_out_time: z.string().optional().nullable(),
              work_hours: z.number().min(0).max(24).default(8),
              is_night_shift: z.boolean().default(false),
              status: z.enum(['NORMAL', 'LATE', 'EARLY_LEAVE', 'ABSENT', 'LEAVE', 'REST']).default('NORMAL'),
              remark: z.string().optional().nullable(),
            })
          )
          .min(1),
      })
      .parse(req.body);

    const db = getDb();
    const user = req.user!;
    const ts = nowIso();
    let importedCount = 0;

    await db.transaction(async (tx) => {
      for (const item of body.records) {
        const emp = await tx.queryOne<{ id: number; hotel_id: number }>(
          'SELECT id, hotel_id FROM employees WHERE id = ?',
          [item.employee_id]
        );
        if (!emp) throw new AppError(404, `员工 ${item.employee_id} 不存在`);
        if (!(await canAccessHotel(user, emp.hotel_id))) {
          throw new AppError(403, '无权导入其他门店考勤记录');
        }

        const existing = await tx.queryOne<{ id: number; is_locked: number }>(
          'SELECT id, is_locked FROM attendance_records WHERE employee_id = ? AND attendance_date = ?',
          [item.employee_id, item.attendance_date]
        );
        if (existing?.is_locked) {
          throw new AppError(400, `${item.attendance_date} 所在月考勤已月结锁定，禁止覆盖导入`);
        }

        if (existing) {
          await tx.execute(
            `UPDATE attendance_records
             SET scheduled_shift = ?, check_in_time = ?, check_out_time = ?, work_hours = ?,
                 is_night_shift = ?, status = ?, source = 'CSV_IMPORT', remark = ?, updated_at = ?
             WHERE id = ?`,
            [
              item.scheduled_shift ?? null,
              item.check_in_time ?? null,
              item.check_out_time ?? null,
              item.work_hours,
              item.is_night_shift ? 1 : 0,
              item.status,
              item.remark ?? null,
              ts,
              existing.id,
            ]
          );
        } else {
          await tx.execute(
            `INSERT INTO attendance_records (
              employee_id, hotel_id, attendance_date, scheduled_shift, check_in_time, check_out_time,
              work_hours, is_night_shift, status, is_locked, source, remark, created_at, updated_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 0, 'CSV_IMPORT', ?, ?, ?)`,
            [
              item.employee_id,
              emp.hotel_id,
              item.attendance_date,
              item.scheduled_shift ?? null,
              item.check_in_time ?? null,
              item.check_out_time ?? null,
              item.work_hours,
              item.is_night_shift ? 1 : 0,
              item.status,
              item.remark ?? null,
              ts,
              ts,
            ]
          );
        }
        importedCount++;
      }
    });

    res.json({ ok: true, importedCount });
  })
);

router.post(
  '/lock',
  requireRoles('HQ_ADMIN', 'HR_MANAGER', 'STORE_MANAGER'),
  asyncHandler(async (req, res) => {
    const body = z
      .object({
        hotel_id: z.number().int().positive(),
        year_month: z.string().regex(/^\d{4}-\d{2}$/),
      })
      .parse(req.body);
    if (!(await canAccessHotel(req.user!, body.hotel_id))) {
      throw new AppError(403, '无权锁定其他门店考勤');
    }
    const db = getDb();
    const upd = await db.execute(
      `UPDATE attendance_records SET is_locked = 1, updated_at = ?
       WHERE hotel_id = ? AND attendance_date LIKE ?`,
      [nowIso(), body.hotel_id, `${body.year_month}%`]
    );
    res.json({ ok: true, lockedCount: upd.affectedRows });
  })
);

router.get(
  '/corrections',
  asyncHandler(async (req, res) => {
    const db = getDb();
    const user = req.user!;
    const scope = await getScopeFilter(user);
    const cond = ['1=1'];
    const params: unknown[] = [];

    if (scope.type === 'SELF') {
      cond.push('c.employee_id = ?');
      params.push(scope.employeeId ?? -1);
    } else if (scope.type === 'HOTEL') {
      cond.push('c.hotel_id = ?');
      params.push(scope.hotelId);
    } else if (scope.type === 'REGION') {
      if (scope.hotelIds.length === 0) {
        res.json({ corrections: [] });
        return;
      }
      cond.push(`c.hotel_id IN (${scope.hotelIds.map(() => '?').join(',')})`);
      params.push(...scope.hotelIds);
    }

    const rows = await db.query<{
      id: number;
      request_no: string;
      employee_id: number;
      hotel_id: number;
      attendance_date: string;
      check_type: string;
      corrected_time: string;
      reason: string;
      status: string;
      current_step: number;
      emp_name: string;
      hotel_name: string;
    }>(
      `SELECT c.*, e.name AS emp_name, h.name AS hotel_name
       FROM attendance_corrections c
       JOIN employees e ON e.id = c.employee_id
       JOIN hotels h ON h.id = c.hotel_id
       WHERE ${cond.join(' AND ')}
       ORDER BY c.id DESC`,
      params
    );

    const corrections = [];
    for (const r of rows) {
      const steps = await getWorkflowStepsWithActors(db, 'ATTENDANCE_CORRECTION', r.id);
      const pendingStep =
        r.status === 'PENDING_APPROVAL'
          ? await db.queryOne<{ approver_role: UserRole; approver_user_id: number | null }>(
              `SELECT approver_role, approver_user_id FROM approval_steps
               WHERE biz_type = 'ATTENDANCE_CORRECTION' AND biz_id = ? AND status = 'PENDING'
               ORDER BY step_order ASC LIMIT 1`,
              [r.id]
            )
          : null;
      const canApprove = pendingStep
        ? await canUserActOnStep(db, user, pendingStep.approver_role, r.hotel_id, -1, {
            approverUserId: pendingStep.approver_user_id,
            bizType: 'ATTENDANCE_CORRECTION',
          })
        : false;
      corrections.push({ ...r, steps, canApprove });
    }
    res.json({ corrections });
  })
);

router.post(
  '/corrections',
  asyncHandler(async (req, res) => {
    const body = z
      .object({
        attendance_date: isoDateSchema,
        check_type: z.enum(['CHECK_IN', 'CHECK_OUT', 'BOTH']).default('CHECK_IN'),
        corrected_time: z.string().trim().min(2),
        reason: z.string().trim().min(2),
      })
      .parse(req.body);

    const user = req.user!;
    if (!user.employee_id || !user.hotel_id) {
      throw new AppError(400, '当前账号未绑定员工档案');
    }

    const db = getDb();
    const existing = await db.queryOne<{ is_locked: number }>(
      'SELECT is_locked FROM attendance_records WHERE employee_id = ? AND attendance_date = ?',
      [user.employee_id, body.attendance_date]
    );
    if (existing?.is_locked) {
      throw new AppError(400, '该日期所在月考勤已锁定，禁止发起补卡');
    }

    const ts = nowIso();
    const requestNo = generateCode('COR');
    const corrId = await db.transaction(async (tx) => {
      const ins = await tx.execute(
        `INSERT INTO attendance_corrections (
          request_no, employee_id, hotel_id, attendance_date, check_type, corrected_time,
          reason, status, current_step, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, 'PENDING_APPROVAL', 1, ?, ?)`,
        [
          requestNo,
          user.employee_id,
          user.hotel_id,
          body.attendance_date,
          body.check_type,
          body.corrected_time,
          body.reason,
          ts,
          ts,
        ]
      );
      const resolved = await resolveApprovalRoute(
        tx,
        user.hotel_id!,
        [{ stepOrder: 1, stepName: '门店店长审批', approverRole: 'STORE_MANAGER' }],
        user.id
      );
      await replaceApprovalSteps(tx, 'ATTENDANCE_CORRECTION', ins.insertId, resolved.steps);
      await logApprovalAction(tx, {
        bizType: 'ATTENDANCE_CORRECTION',
        bizId: ins.insertId,
        action: 'SUBMIT',
        actor: user,
        comment: `补卡申请：${body.attendance_date} ${body.check_type} ${body.corrected_time}`,
      });
      return ins.insertId;
    });

    const correction = await db.queryOne('SELECT * FROM attendance_corrections WHERE id = ?', [corrId]);
    res.status(201).json({ correction });
  })
);

router.post(
  '/corrections/:id/action',
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
      const corr = await tx.queryOne<{
        id: number;
        employee_id: number;
        hotel_id: number;
        attendance_date: string;
        check_type: string;
        corrected_time: string;
        status: string;
      }>(`SELECT * FROM attendance_corrections WHERE id = ?${tx.forUpdateSuffix()}`, [id]);
      if (!corr) throw new AppError(404, '补卡申请不存在');
      if (corr.status !== 'PENDING_APPROVAL') throw new AppError(400, '当前状态不可审批');

      const step = await tx.queryOne<{ id: number; approver_role: UserRole; approver_user_id: number | null }>(
        `SELECT id, approver_role, approver_user_id FROM approval_steps
         WHERE biz_type = 'ATTENDANCE_CORRECTION' AND biz_id = ? AND status = 'PENDING'
         ORDER BY step_order ASC LIMIT 1`,
        [id]
      );
      if (!step) throw new AppError(400, '未找到待审批节点');
      if (
        !(await canUserActOnStep(tx, user, step.approver_role, corr.hotel_id, -1, {
          approverUserId: step.approver_user_id,
          bizType: 'ATTENDANCE_CORRECTION',
        }))
      ) {
        throw new AppError(403, '无权审批该补卡申请');
      }

      if (action === 'REJECT') {
        await tx.execute(
          `UPDATE approval_steps SET status = 'REJECTED', acted_by = ?, acted_at = ?, comment = ? WHERE id = ?`,
          [user.id, ts, comment || '驳回', step.id]
        );
        await tx.execute(`UPDATE attendance_corrections SET status = 'REJECTED', updated_at = ? WHERE id = ?`, [
          ts,
          id,
        ]);
      } else {
        await tx.execute(
          `UPDATE approval_steps SET status = 'APPROVED', acted_by = ?, acted_at = ?, comment = ? WHERE id = ?`,
          [user.id, ts, comment || '同意', step.id]
        );
        await tx.execute(`UPDATE attendance_corrections SET status = 'APPROVED', updated_at = ? WHERE id = ?`, [
          ts,
          id,
        ]);

        const att = await tx.queryOne<{ id: number; check_in_time: string | null; check_out_time: string | null }>(
          'SELECT id, check_in_time, check_out_time FROM attendance_records WHERE employee_id = ? AND attendance_date = ?',
          [corr.employee_id, corr.attendance_date]
        );
        const newIn = corr.check_type === 'CHECK_OUT' ? att?.check_in_time ?? null : corr.corrected_time;
        const newOut = corr.check_type === 'CHECK_IN' ? att?.check_out_time ?? null : corr.corrected_time;
        if (att) {
          await tx.execute(
            `UPDATE attendance_records
             SET check_in_time = ?, check_out_time = ?, status = 'NORMAL', source = 'CORRECTION', updated_at = ?
             WHERE id = ?`,
            [newIn, newOut, ts, att.id]
          );
        } else {
          await tx.execute(
            `INSERT INTO attendance_records (
              employee_id, hotel_id, attendance_date, check_in_time, check_out_time,
              work_hours, is_night_shift, status, is_locked, source, created_at, updated_at
            ) VALUES (?, ?, ?, ?, ?, 8, 0, 'NORMAL', 0, 'CORRECTION', ?, ?)`,
            [corr.employee_id, corr.hotel_id, corr.attendance_date, newIn, newOut, ts, ts]
          );
        }
      }

      await logApprovalAction(tx, {
        bizType: 'ATTENDANCE_CORRECTION',
        bizId: id,
        action,
        actor: user,
        comment: comment || (action === 'APPROVE' ? '同意补卡并修复考勤' : '驳回补卡'),
      });
    });

    res.json({ ok: true });
  })
);

export default router;
