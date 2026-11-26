import { Router } from 'express';
import bcrypt from 'bcryptjs';
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
  buildHeadcountRoute,
  buildStatusDetail,
  canUserActOnStep,
  getUserLastHandledAction,
  getWorkflowStepsWithActors,
  replaceApprovalSteps,
  resolveApprovalRoute,
} from '../services/workflowEngine';
import { UserRole } from '../types';
import { addDays, generateCode, nowIso, todayStr } from '../utils/numbers';

const router = Router();
router.use(authenticate);

router.get(
  '/headcounts',
  asyncHandler(async (req, res) => {
    const db = getDb();
    const user = req.user!;
    const tab = String(req.query.tab || 'all');
    const scope = await getScopeFilter(user);
    const conditions = ['1=1'];
    const params: unknown[] = [];

    if (tab === 'mine') {
      conditions.push('hc.applicant_id = ?');
      params.push(user.id);
    } else if (tab === 'handled') {
      conditions.push(
        `(EXISTS (SELECT 1 FROM approval_steps s WHERE s.biz_type = 'HEADCOUNT' AND s.biz_id = hc.id AND s.acted_by = ?)
          OR EXISTS (SELECT 1 FROM approval_logs l WHERE l.biz_type = 'HEADCOUNT' AND l.biz_id = hc.id AND l.actor_id = ? AND l.action IN ('APPROVE', 'REJECT')))`
      );
      params.push(user.id, user.id);
    } else if (tab !== 'pending') {
      if (scope.type === 'REGION') {
        if (scope.hotelIds.length === 0) {
          res.json({ headcounts: [] });
          return;
        }
        conditions.push(`hc.hotel_id IN (${scope.hotelIds.map(() => '?').join(',')})`);
        params.push(...scope.hotelIds);
      } else if (scope.type === 'HOTEL' || scope.type === 'SELF') {
        conditions.push('hc.hotel_id = ?');
        params.push(scope.hotelId);
      }
    }

    const rows = await db.query<{
      id: number;
      request_no: string;
      hotel_id: number;
      department_id: number;
      position: string;
      headcount: number;
      urgency: string;
      salary_range: string;
      reason: string;
      applicant_id: number;
      status: string;
      current_step: number;
      created_at: string;
      hotel_name: string;
      department_name: string;
      applicant_name: string;
    }>(
      `SELECT hc.*, h.name AS hotel_name, d.name AS department_name, u.display_name AS applicant_name
       FROM headcount_requests hc
       JOIN hotels h ON h.id = hc.hotel_id
       JOIN departments d ON d.id = hc.department_id
       JOIN users u ON u.id = hc.applicant_id
       WHERE ${conditions.join(' AND ')}
       ORDER BY CASE WHEN hc.urgency = 'URGENT' THEN 0 ELSE 1 END ASC, hc.id DESC`,
      params
    );

    const enriched = [];
    for (const r of rows) {
      const pendingStep =
        r.status === 'PENDING_APPROVAL'
          ? await db.queryOne<{ step_name: string; approver_role: UserRole }>(
              `SELECT step_name, approver_role FROM approval_steps
               WHERE biz_type = 'HEADCOUNT' AND biz_id = ? AND status = 'PENDING'
               ORDER BY step_order ASC LIMIT 1`,
              [r.id]
            )
          : null;
      const canApprove = pendingStep
        ? await canUserActOnStep(db, user, pendingStep.approver_role, r.hotel_id, r.applicant_id)
        : false;
      if (tab === 'pending' && !canApprove) continue;

      const steps = await getWorkflowStepsWithActors(db, 'HEADCOUNT', r.id);
      const handledInfo =
        tab === 'handled'
          ? await getUserLastHandledAction(db, 'HEADCOUNT', r.id, user.id)
          : { my_last_action: null, my_acted_at: null };

      enriched.push({
        ...r,
        current_step_name: pendingStep?.step_name ?? null,
        steps,
        status_detail: buildStatusDetail({
          bizType: 'HEADCOUNT',
          status: r.status,
          currentStepName: pendingStep?.step_name ?? null,
          currentStep: r.current_step,
          totalSteps: steps.length,
        }),
        my_last_action: handledInfo.my_last_action,
        my_acted_at: handledInfo.my_acted_at,
        canApprove,
      });
    }

    res.json({ headcounts: enriched });
  })
);

const createHcSchema = z.object({
  hotel_id: z.number().int().positive(),
  department_id: z.number().int().positive(),
  position: z.string().min(1),
  headcount: z.number().int().min(1).max(50),
  urgency: z.enum(['NORMAL', 'URGENT']).default('NORMAL'),
  salary_range: z.string().min(2),
  reason: z.string().min(2),
});

router.post(
  '/headcounts',
  requireRoles('HQ_ADMIN', 'HR_MANAGER', 'REGIONAL_MANAGER', 'STORE_MANAGER'),
  asyncHandler(async (req, res) => {
    const body = createHcSchema.parse(req.body);
    if (!(await canAccessHotel(req.user!, body.hotel_id))) {
      throw new AppError(403, '无权为其他门店发起补编申请');
    }
    const db = getDb();
    const ts = nowIso();
    const requestNo = generateCode('HC');
    const resolved = await resolveApprovalRoute(
      db,
      body.hotel_id,
      buildHeadcountRoute({ headcount: body.headcount, urgency: body.urgency })
    );
    const route = resolved.steps;

    const hcId = await db.transaction(async (tx) => {
      const ins = await tx.execute(
        `INSERT INTO headcount_requests (
          request_no, hotel_id, department_id, position, headcount, urgency,
          salary_range, reason, applicant_id, status, current_step, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'PENDING_APPROVAL', 1, ?, ?)`,
        [
          requestNo,
          body.hotel_id,
          body.department_id,
          body.position,
          body.headcount,
          body.urgency,
          body.salary_range,
          body.reason,
          req.user!.id,
          ts,
          ts,
        ]
      );
      await replaceApprovalSteps(tx, 'HEADCOUNT', ins.insertId, route);
      await logApprovalAction(tx, {
        bizType: 'HEADCOUNT',
        bizId: ins.insertId,
        action: 'SUBMIT',
        actor: req.user!,
        comment: body.reason,
      });
      if (resolved.skippedRegionalManager && resolved.skipReason) {
        await logApprovalAction(tx, {
          bizType: 'HEADCOUNT',
          bizId: ins.insertId,
          action: 'AUTO_SKIP',
          actor: req.user!,
          comment: resolved.skipReason,
        });
      }
      return ins.insertId;
    });

    const headcount = await db.queryOne('SELECT * FROM headcount_requests WHERE id = ?', [hcId]);
    res.status(201).json({ headcount });
  })
);

router.post(
  '/headcounts/:id/action',
  asyncHandler(async (req, res) => {
    const id = Number(req.params.id);
    const { action, comment } = z
      .object({
        action: z.enum(['APPROVE', 'REJECT']),
        comment: z.string().optional().default(''),
      })
      .parse(req.body);

    const db = getDb();
    const hc = await db.queryOne<{
      id: number;
      hotel_id: number;
      applicant_id: number;
      status: string;
    }>('SELECT id, hotel_id, applicant_id, status FROM headcount_requests WHERE id = ?', [id]);
    if (!hc) throw new AppError(404, '补编申请不存在');
    if (hc.status !== 'PENDING_APPROVAL') throw new AppError(400, '当前状态不可审批');

    const step = await db.queryOne<{ id: number; step_order: number; approver_role: UserRole }>(
      `SELECT id, step_order, approver_role FROM approval_steps
       WHERE biz_type = 'HEADCOUNT' AND biz_id = ? AND status = 'PENDING'
       ORDER BY step_order ASC LIMIT 1`,
      [id]
    );
    if (!step) throw new AppError(400, '未找到待审批节点');
    if (!(await canUserActOnStep(db, req.user!, step.approver_role, hc.hotel_id, hc.applicant_id))) {
      throw new AppError(403, '您无权审批此补编节点');
    }

    const ts = nowIso();
    await db.transaction(async (tx) => {
      if (action === 'REJECT') {
        await tx.execute(
          `UPDATE approval_steps SET status = 'REJECTED', acted_by = ?, acted_at = ?, comment = ? WHERE id = ?`,
          [req.user!.id, ts, comment || '驳回', step.id]
        );
        await tx.execute(`UPDATE headcount_requests SET status = 'REJECTED', updated_at = ? WHERE id = ?`, [ts, id]);
      } else {
        await tx.execute(
          `UPDATE approval_steps SET status = 'APPROVED', acted_by = ?, acted_at = ?, comment = ? WHERE id = ?`,
          [req.user!.id, ts, comment || '同意', step.id]
        );
        const nextStep = await tx.queryOne<{ id: number; step_order: number }>(
          `SELECT id, step_order FROM approval_steps
           WHERE biz_type = 'HEADCOUNT' AND biz_id = ? AND step_order > ?
           ORDER BY step_order ASC LIMIT 1`,
          [id, step.step_order]
        );
        if (nextStep) {
          await tx.execute(`UPDATE approval_steps SET status = 'PENDING' WHERE id = ?`, [nextStep.id]);
          await tx.execute(`UPDATE headcount_requests SET current_step = ?, updated_at = ? WHERE id = ?`, [
            nextStep.step_order,
            ts,
            id,
          ]);
        } else {
          await tx.execute(`UPDATE headcount_requests SET status = 'APPROVED', updated_at = ? WHERE id = ?`, [
            ts,
            id,
          ]);
        }
      }
      await logApprovalAction(tx, {
        bizType: 'HEADCOUNT',
        bizId: id,
        action,
        actor: req.user!,
        comment,
      });
    });

    res.json({ ok: true });
  })
);

router.get(
  '/candidates',
  asyncHandler(async (req, res) => {
    const db = getDb();
    const scope = await getScopeFilter(req.user!);
    const conditions = ['1=1'];
    const params: unknown[] = [];

    if (scope.type === 'REGION') {
      if (scope.hotelIds.length === 0) {
        res.json({ candidates: [] });
        return;
      }
      conditions.push(`c.hotel_id IN (${scope.hotelIds.map(() => '?').join(',')})`);
      params.push(...scope.hotelIds);
    } else if (scope.type === 'HOTEL' || scope.type === 'SELF') {
      conditions.push('c.hotel_id = ?');
      params.push(scope.hotelId);
    }

    const candidates = await db.query(
      `SELECT c.*, h.name AS hotel_name, d.name AS department_name, hc.request_no AS headcount_request_no
       FROM candidates c
       JOIN hotels h ON h.id = c.hotel_id
       JOIN departments d ON d.id = c.department_id
       LEFT JOIN headcount_requests hc ON hc.id = c.headcount_request_id
       WHERE ${conditions.join(' AND ')}
       ORDER BY c.id DESC`,
      params
    );

    res.json({ candidates });
  })
);

const createCandSchema = z.object({
  headcount_request_id: z.number().int().positive().nullable().optional(),
  hotel_id: z.number().int().positive(),
  department_id: z.number().int().positive(),
  name: z.string().min(1),
  phone: z.string().min(6),
  position: z.string().min(1),
  expected_salary: z.number().min(0),
  interview_notes: z.string().optional().nullable(),
});

router.post(
  '/candidates',
  requireRoles('HQ_ADMIN', 'HR_MANAGER', 'REGIONAL_MANAGER', 'STORE_MANAGER'),
  asyncHandler(async (req, res) => {
    const body = createCandSchema.parse(req.body);
    if (!(await canAccessHotel(req.user!, body.hotel_id))) {
      throw new AppError(403, '无权录入其他门店候选人');
    }
    const db = getDb();
    const ts = nowIso();
    const ins = await db.execute(
      `INSERT INTO candidates (
        headcount_request_id, hotel_id, department_id, name, phone, position,
        expected_salary, stage, interview_notes, created_by, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, 'SCREENING', ?, ?, ?, ?)`,
      [
        body.headcount_request_id ?? null,
        body.hotel_id,
        body.department_id,
        body.name,
        body.phone,
        body.position,
        body.expected_salary,
        body.interview_notes ?? null,
        req.user!.id,
        ts,
        ts,
      ]
    );
    const candidate = await db.queryOne('SELECT * FROM candidates WHERE id = ?', [ins.insertId]);
    res.status(201).json({ candidate });
  })
);

router.patch(
  '/candidates/:id/stage',
  requireRoles('HQ_ADMIN', 'HR_MANAGER', 'REGIONAL_MANAGER', 'STORE_MANAGER'),
  asyncHandler(async (req, res) => {
    const id = Number(req.params.id);
    const body = z
      .object({
        stage: z.enum(['SCREENING', 'INTERVIEW', 'OFFERED', 'REJECTED']),
        interview_notes: z.string().optional().nullable(),
      })
      .parse(req.body);
    const db = getDb();
    const cand = await db.queryOne<{ id: number; hotel_id: number; stage: string }>(
      'SELECT id, hotel_id, stage FROM candidates WHERE id = ?',
      [id]
    );
    if (!cand) throw new AppError(404, '候选人不存在');
    if (cand.stage === 'HIRED') throw new AppError(400, '已入职候选人不可修改阶段');
    if (!(await canAccessHotel(req.user!, cand.hotel_id))) {
      throw new AppError(403, '无权操作其他门店候选人');
    }

    await db.execute(
      'UPDATE candidates SET stage = ?, interview_notes = COALESCE(?, interview_notes), updated_at = ? WHERE id = ?',
      [body.stage, body.interview_notes ?? null, nowIso(), id]
    );
    const updated = await db.queryOne('SELECT * FROM candidates WHERE id = ?', [id]);
    res.json({ candidate: updated });
  })
);

router.post(
  '/candidates/:id/hire',
  requireRoles('HQ_ADMIN', 'HR_MANAGER', 'STORE_MANAGER'),
  asyncHandler(async (req, res) => {
    const id = Number(req.params.id);
    const body = z
      .object({
        username: z.string().min(3).optional(),
        hire_date: z.string().min(8).default(todayStr),
        health_cert_expiry: z.string().optional().nullable(),
      })
      .parse(req.body || {});

    const db = getDb();
    const cand = await db.queryOne<{
      id: number;
      hotel_id: number;
      department_id: number;
      name: string;
      phone: string;
      position: string;
      expected_salary: number;
      stage: string;
      hired_employee_id: number | null;
    }>('SELECT * FROM candidates WHERE id = ?', [id]);

    if (!cand) throw new AppError(404, '候选人不存在');
    if (cand.stage === 'HIRED' || cand.hired_employee_id) {
      throw new AppError(400, '该候选人已完成入职建档');
    }
    if (!(await canAccessHotel(req.user!, cand.hotel_id))) {
      throw new AppError(403, '无权为其他门店候选人办理入职');
    }

    const hotel = await db.queryOne<{ region_id: number }>('SELECT region_id FROM hotels WHERE id = ?', [
      cand.hotel_id,
    ]);
    const ts = nowIso();
    const suffix = Date.now().toString().slice(-5);
    const empNo = `YQ-${suffix}`;
    const username = body.username || `staff_${suffix}`;
    const passwordHash = bcrypt.hashSync('Hotel@2026', 8);

    const result = await db.transaction(async (tx) => {
      const empRes = await tx.execute(
        `INSERT INTO employees (
          emp_no, name, gender, phone, id_card_last4, hotel_id, department_id, position,
          employment_type, status, hire_date, probation_end_date, contract_end_date,
          health_cert_expiry, base_salary, night_allowance_rate, created_at, updated_at
        ) VALUES (?, ?, 'M', ?, '6666', ?, ?, ?, 'FULL_TIME', 'PROBATION', ?, ?, ?, ?, ?, 80, ?, ?)`,
        [
          empNo,
          cand.name,
          cand.phone,
          cand.hotel_id,
          cand.department_id,
          cand.position,
          body.hire_date,
          addDays(body.hire_date, 90),
          addDays(body.hire_date, 730),
          body.health_cert_expiry ?? addDays(body.hire_date, 365),
          cand.expected_salary,
          ts,
          ts,
        ]
      );

      await tx.execute(
        `INSERT INTO employee_lifecycle_events (
          employee_id, event_type, from_hotel_id, to_hotel_id, from_position, to_position,
          effective_date, reason, operator_id, created_at
        ) VALUES (?, 'ONBOARD', NULL, ?, NULL, ?, ?, '招聘录用一键入职建档', ?, ?)`,
        [empRes.insertId, cand.hotel_id, cand.position, body.hire_date, req.user!.id, ts]
      );

      await tx.execute(
        `INSERT INTO users (username, password_hash, display_name, role, employee_id, hotel_id, region_id, is_active, created_at)
         VALUES (?, ?, ?, 'STAFF', ?, ?, ?, 1, ?)`,
        [username, passwordHash, cand.name, empRes.insertId, cand.hotel_id, hotel?.region_id ?? null, ts]
      );

      await tx.execute(
        `UPDATE candidates SET stage = 'HIRED', hired_employee_id = ?, updated_at = ? WHERE id = ?`,
        [empRes.insertId, ts, id]
      );

      return { employeeId: empRes.insertId, empNo, username };
    });

    res.status(201).json({ ok: true, ...result });
  })
);

export default router;
