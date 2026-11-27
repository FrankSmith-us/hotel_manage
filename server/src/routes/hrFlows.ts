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
import { archiveEmployeeRecords } from '../services/archiveService';
import { logApprovalAction } from '../services/auditService';
import { completeOffboardingTx, executeEmployeeChangeTx, runScheduledJobs } from '../services/schedulerService';
import {
  buildOffboardingRoute,
  buildOnboardingRoute,
  buildStatusDetail,
  canUserActOnStep,
  getUserLastHandledAction,
  getWorkflowStepsWithActors,
  reassignPendingSteps,
  replaceApprovalSteps,
  resolveApprovalRoute,
} from '../services/workflowEngine';
import { UserRole } from '../types';
import {
  addDays,
  generateCode,
  generateTempPassword,
  isoDateSchema,
  nowIso,
  randomTokenSuffix,
  roundMoney,
  todayStr,
} from '../utils/numbers';

const router = Router();
router.use(authenticate);

function parseJsonSafe<T>(raw: string | null | undefined, fallback: T): T {
  if (!raw) return fallback;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
}

// ==========================================
// 1. Onboarding Workflow (/api/hr-flows/onboarding)
// ==========================================
router.get(
  '/onboarding',
  asyncHandler(async (req, res) => {
    const db = getDb();
    const user = req.user!;
    const tab = String(req.query.tab || 'all');
    const scope = await getScopeFilter(user);
    const conditions = ['1=1'];
    const params: unknown[] = [];

    if (tab === 'mine') {
      conditions.push('ob.applicant_id = ?');
      params.push(user.id);
    } else if (tab === 'handled') {
      conditions.push(
        `(EXISTS (SELECT 1 FROM approval_steps s WHERE s.biz_type = 'ONBOARDING' AND s.biz_id = ob.id AND s.acted_by = ?)
          OR EXISTS (SELECT 1 FROM approval_logs l WHERE l.biz_type = 'ONBOARDING' AND l.biz_id = ob.id AND l.actor_id = ? AND l.action IN ('APPROVE', 'REJECT')))`
      );
      params.push(user.id, user.id);
    } else if (tab !== 'pending') {
      if (scope.type === 'REGION') {
        if (scope.hotelIds.length === 0) {
          res.json({ requests: [] });
          return;
        }
        conditions.push(`ob.hotel_id IN (${scope.hotelIds.map(() => '?').join(',')})`);
        params.push(...scope.hotelIds);
      } else if (scope.type === 'HOTEL') {
        conditions.push('ob.hotel_id = ?');
        params.push(scope.hotelId);
      } else if (scope.type === 'SELF') {
        conditions.push('ob.applicant_id = ?');
        params.push(user.id);
      }
    }

    const rows = await db.query<{
      id: number;
      request_no: string;
      candidate_name: string;
      gender: string;
      phone: string;
      email: string | null;
      hotel_id: number;
      department_id: number;
      position_id: number | null;
      position: string;
      education: string | null;
      employment_type: string;
      marital_status: string | null;
      political_status: string | null;
      planned_hire_date: string;
      base_salary: number;
      night_allowance_rate: number;
      health_cert_expiry: string | null;
      contract_end_date: string | null;
      create_user_account: number;
      applicant_id: number;
      status: string;
      current_step: number;
      checklist_json: string | null;
      employee_id: number | null;
      remarks: string | null;
      created_at: string;
      hotel_name: string;
      department_name: string;
      applicant_name: string;
    }>(
      `SELECT ob.*, h.name AS hotel_name, d.name AS department_name, u.display_name AS applicant_name
       FROM onboarding_requests ob
       JOIN hotels h ON h.id = ob.hotel_id
       JOIN departments d ON d.id = ob.department_id
       JOIN users u ON u.id = ob.applicant_id
       WHERE ${conditions.join(' AND ')}
       ORDER BY ob.id DESC`,
      params
    );

    const result = [];
    for (const r of rows) {
      const steps = await getWorkflowStepsWithActors(db, 'ONBOARDING', r.id);
      const pendingStep = steps.find((s) => s.status === 'PENDING');
      const pendingRaw =
        r.status === 'PENDING_APPROVAL'
          ? await db.queryOne<{ approver_role: UserRole; approver_user_id: number | null }>(
              `SELECT approver_role, approver_user_id FROM approval_steps WHERE biz_type = 'ONBOARDING' AND biz_id = ? AND status = 'PENDING' ORDER BY step_order ASC LIMIT 1`,
              [r.id]
            )
          : null;
      const canApprove =
        r.status === 'PENDING_APPROVAL' && pendingRaw
          ? await canUserActOnStep(db, user, pendingRaw.approver_role, r.hotel_id, r.applicant_id, {
              approverUserId: pendingRaw.approver_user_id,
              bizType: 'ONBOARDING',
            })
          : false;
      if (tab === 'pending' && !canApprove) continue;
      const canComplete =
        r.status === 'APPROVED' &&
        ['HQ_ADMIN', 'HR_MANAGER', 'STORE_MANAGER'].includes(user.role) &&
        (await canAccessHotel(user, r.hotel_id));
      result.push({
        ...r,
        checklist: parseJsonSafe<Record<string, boolean>>(r.checklist_json, {}),
        steps,
        canApprove,
        canComplete,
        status_detail: buildStatusDetail({
          bizType: 'ONBOARDING',
          status: r.status,
          currentStepName: pendingStep?.step_name,
          currentStep: r.current_step,
          totalSteps: steps.length,
        }),
        my_last_action: await getUserLastHandledAction(db, 'ONBOARDING', r.id, user.id),
      });
    }
    res.json({ requests: result });
  })
);

const createOnboardingSchema = z.object({
  candidate_name: z.string().trim().min(1, '请输入拟入职人员姓名'),
  gender: z.string().min(1).max(12).default('M'),
  phone: z.string().trim().min(6, '请输入有效手机号'),
  email: z.string().optional().nullable(),
  hotel_id: z.number().int().positive(),
  department_id: z.number().int().positive(),
  position_id: z.number().int().positive().optional().nullable(),
  position: z.string().trim().min(1, '请输入岗位名称'),
  education: z.string().max(32).optional().nullable(),
  employment_type: z.string().min(2).max(24).default('FULL_TIME'),
  marital_status: z.string().max(24).optional().nullable(),
  political_status: z.string().max(24).optional().nullable(),
  planned_hire_date: isoDateSchema.default(todayStr),
  base_salary: z.number().min(0).max(1_000_000),
  night_allowance_rate: z.number().min(0).max(10_000).default(80),
  health_cert_expiry: isoDateSchema.optional().nullable(),
  contract_end_date: isoDateSchema.optional().nullable(),
  create_user_account: z.boolean().default(true),
  remarks: z.string().max(500).optional().nullable(),
});

router.post(
  '/onboarding',
  requireRoles('HQ_ADMIN', 'HR_MANAGER', 'REGIONAL_MANAGER', 'STORE_MANAGER'),
  asyncHandler(async (req, res) => {
    const body = createOnboardingSchema.parse(req.body);
    const user = req.user!;
    if (!(await canAccessHotel(user, body.hotel_id))) {
      throw new AppError(403, '无权为其他门店发起入职申请');
    }
    const db = getDb();
    const dept = await db.queryOne<{ id: number }>(
      'SELECT id FROM departments WHERE id = ? AND hotel_id = ?',
      [body.department_id, body.hotel_id]
    );
    if (!dept) {
      throw new AppError(400, '所选部门不属于当前门店');
    }

    const requestNo = generateCode('OB');
    const ts = nowIso();
    const plannedSteps = buildOnboardingRoute({ applicantRole: user.role });

    const reqId = await db.transaction(async (tx) => {
      const ins = await tx.execute(
        `INSERT INTO onboarding_requests (
          request_no, candidate_name, gender, phone, email, hotel_id, department_id,
          position_id, position, education, employment_type, marital_status, political_status,
          planned_hire_date, base_salary, night_allowance_rate, health_cert_expiry,
          contract_end_date, create_user_account, applicant_id, status, current_step,
          remarks, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'PENDING_APPROVAL', 1, ?, ?, ?)`,
        [
          requestNo,
          body.candidate_name,
          body.gender,
          body.phone,
          body.email ?? null,
          body.hotel_id,
          body.department_id,
          body.position_id ?? null,
          body.position,
          body.education ?? null,
          body.employment_type,
          body.marital_status ?? null,
          body.political_status ?? null,
          body.planned_hire_date,
          body.base_salary,
          body.night_allowance_rate,
          body.health_cert_expiry ?? null,
          body.contract_end_date ?? null,
          body.create_user_account ? 1 : 0,
          user.id,
          body.remarks ?? null,
          ts,
          ts,
        ]
      );

      const resolved = await resolveApprovalRoute(tx, body.hotel_id, plannedSteps, user.id);
      await replaceApprovalSteps(tx, 'ONBOARDING', ins.insertId, resolved.steps);
      await logApprovalAction(tx, {
        bizType: 'ONBOARDING',
        bizId: ins.insertId,
        action: 'SUBMIT',
        actor: user,
        comment: `发起入职申请：${body.candidate_name}（${body.position}）`,
      });
      return ins.insertId;
    });

    const created = await db.queryOne('SELECT * FROM onboarding_requests WHERE id = ?', [reqId]);
    res.status(201).json({ request: created });
  })
);

const flowActionSchema = z.object({
  action: z.enum(['APPROVE', 'REJECT']),
  comment: z.string().optional(),
});

router.post(
  '/onboarding/:id/action',
  asyncHandler(async (req, res) => {
    const id = Number(req.params.id);
    const body = flowActionSchema.parse(req.body);
    const db = getDb();
    const user = req.user!;

    const ob = await db.queryOne<{ id: number; hotel_id: number; applicant_id: number; status: string; current_step: number }>(
      'SELECT * FROM onboarding_requests WHERE id = ?',
      [id]
    );
    if (!ob) throw new AppError(404, '入职申请不存在');
    if (ob.status !== 'PENDING_APPROVAL') throw new AppError(400, '当前状态不可审批');

    const stepRow = await db.queryOne<{ approver_role: UserRole; approver_user_id: number | null }>(
      `SELECT approver_role, approver_user_id FROM approval_steps WHERE biz_type = 'ONBOARDING' AND biz_id = ? AND step_order = ?`,
      [id, ob.current_step]
    );
    const canAct = stepRow
      ? await canUserActOnStep(db, user, stepRow.approver_role, ob.hotel_id, ob.applicant_id, {
          approverUserId: stepRow.approver_user_id,
          bizType: 'ONBOARDING',
        })
      : false;
    if (!canAct) throw new AppError(403, '当前审批节点无权操作');

    const ts = nowIso();
    await db.transaction(async (tx) => {
      if (body.action === 'REJECT') {
        await tx.execute(
          `UPDATE approval_steps SET status = 'REJECTED', acted_by = ?, acted_at = ?, comment = ?
           WHERE biz_type = 'ONBOARDING' AND biz_id = ? AND step_order = ?`,
          [user.id, ts, body.comment || '驳回入职申请', id, ob.current_step]
        );
        await tx.execute(`UPDATE onboarding_requests SET status = 'REJECTED', updated_at = ? WHERE id = ?`, [
          ts,
          id,
        ]);
      } else {
        await tx.execute(
          `UPDATE approval_steps SET status = 'APPROVED', acted_by = ?, acted_at = ?, comment = ?
           WHERE biz_type = 'ONBOARDING' AND biz_id = ? AND step_order = ?`,
          [user.id, ts, body.comment || '同意入职', id, ob.current_step]
        );
        const nextStep = await tx.queryOne<{ step_order: number }>(
          `SELECT step_order FROM approval_steps WHERE biz_type = 'ONBOARDING' AND biz_id = ? AND step_order > ? ORDER BY step_order ASC LIMIT 1`,
          [id, ob.current_step]
        );
        if (nextStep) {
          await tx.execute(
            `UPDATE approval_steps SET status = 'PENDING' WHERE biz_type = 'ONBOARDING' AND biz_id = ? AND step_order = ?`,
            [id, nextStep.step_order]
          );
          await tx.execute(`UPDATE onboarding_requests SET current_step = ?, updated_at = ? WHERE id = ?`, [
            nextStep.step_order,
            ts,
            id,
          ]);
        } else {
          await tx.execute(`UPDATE onboarding_requests SET status = 'APPROVED', updated_at = ? WHERE id = ?`, [
            ts,
            id,
          ]);
        }
      }
      await logApprovalAction(tx, {
        bizType: 'ONBOARDING',
        bizId: id,
        action: body.action,
        actor: user,
        comment: body.comment || (body.action === 'APPROVE' ? '同意入职' : '驳回入职'),
      });
    });

    res.json({ ok: true });
  })
);

const completeOnboardingSchema = z.object({
  checklist: z.record(z.string(), z.boolean()).optional(),
  hire_date: isoDateSchema.optional(),
  id_card_last4: z.string().max(8).optional().default(''),
});

router.post(
  '/onboarding/:id/complete',
  requireRoles('HQ_ADMIN', 'HR_MANAGER', 'STORE_MANAGER'),
  asyncHandler(async (req, res) => {
    const id = Number(req.params.id);
    const body = completeOnboardingSchema.parse(req.body || {});
    const db = getDb();
    const user = req.user!;

    const ob = await db.queryOne<{
      id: number;
      request_no: string;
      candidate_name: string;
      gender: string;
      phone: string;
      email: string | null;
      hotel_id: number;
      department_id: number;
      position_id: number | null;
      position: string;
      education: string | null;
      employment_type: string;
      marital_status: string | null;
      political_status: string | null;
      planned_hire_date: string;
      base_salary: number;
      night_allowance_rate: number;
      health_cert_expiry: string | null;
      contract_end_date: string | null;
      create_user_account: number;
      status: string;
    }>('SELECT * FROM onboarding_requests WHERE id = ?', [id]);

    if (!ob) throw new AppError(404, '入职申请不存在');
    if (ob.status !== 'APPROVED') throw new AppError(400, '仅审批通过的入职申请可办理入职建档');
    if (!(await canAccessHotel(user, ob.hotel_id))) {
      throw new AppError(403, '无权办理该门店入职手续');
    }

    const ts = nowIso();
    const hireDate = body.hire_date || ob.planned_hire_date || todayStr();
    const empNo = `YQ-${randomTokenSuffix(3)}`;
    const probationEnd = addDays(hireDate, 90);
    const contractEnd = ob.contract_end_date || addDays(hireDate, 730);
    const username = `staff_${randomTokenSuffix(3).toLowerCase()}`;
    const tempPassword = generateTempPassword();
    const defaultPassHash = bcrypt.hashSync(tempPassword, 8);

    const result = await db.transaction(async (tx) => {
      const insEmp = await tx.execute(
        `INSERT INTO employees (
          emp_no, name, gender, phone, email, id_card_last4, hotel_id, department_id,
          position_id, position, education, marital_status, political_status,
          employment_type, status, hire_date, probation_end_date, contract_end_date,
          health_cert_expiry, base_salary, night_allowance_rate, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'PROBATION', ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          empNo,
          ob.candidate_name,
          ob.gender,
          ob.phone,
          ob.email,
          body.id_card_last4,
          ob.hotel_id,
          ob.department_id,
          ob.position_id,
          ob.position,
          ob.education,
          ob.marital_status,
          ob.political_status,
          ob.employment_type,
          hireDate,
          probationEnd,
          contractEnd,
          ob.health_cert_expiry,
          ob.base_salary,
          ob.night_allowance_rate,
          ts,
          ts,
        ]
      );

      await tx.execute(
        `INSERT INTO employee_lifecycle_events (
          employee_id, event_type, from_hotel_id, to_hotel_id, from_position, to_position,
          effective_date, reason, operator_id, created_at
        ) VALUES (?, 'ONBOARD', NULL, ?, NULL, ?, ?, ?, ?, ?)`,
        [insEmp.insertId, ob.hotel_id, ob.position, hireDate, `入职流程（${ob.request_no}）办结建档`, user.id, ts]
      );

      let createdUsername: string | null = null;
      let createdTempPassword: string | null = null;
      if (ob.create_user_account) {
        const hotel = await tx.queryOne<{ region_id: number }>('SELECT region_id FROM hotels WHERE id = ?', [ob.hotel_id]);
        await tx.execute(
          `INSERT INTO users (username, password_hash, display_name, role, employee_id, hotel_id, region_id, is_active, must_change_password, created_at)
           VALUES (?, ?, ?, 'STAFF', ?, ?, ?, 1, 1, ?)`,
          [username, defaultPassHash, ob.candidate_name, insEmp.insertId, ob.hotel_id, hotel?.region_id ?? null, ts]
        );
        createdUsername = username;
        createdTempPassword = tempPassword;
      }

      await tx.execute(
        `UPDATE onboarding_requests
         SET status = 'COMPLETED', employee_id = ?, checklist_json = ?, updated_at = ?
         WHERE id = ?`,
        [insEmp.insertId, JSON.stringify(body.checklist || { contract_signed: true, badge_issued: true }), ts, id]
      );

      await logApprovalAction(tx, {
        bizType: 'ONBOARDING',
        bizId: id,
        action: 'COMPLETE',
        actor: user,
        comment: `完成入职建档，工号 ${empNo}${createdUsername ? `，已开通账号 ${createdUsername}` : ''}`,
      });

      return {
        employeeId: insEmp.insertId,
        empNo,
        username: createdUsername,
        temp_password: createdTempPassword,
      };
    });

    res.json({ ok: true, ...result });
  })
);

// ==========================================
// 2. Offboarding Workflow (/api/hr-flows/offboarding)
// ==========================================
router.get(
  '/offboarding',
  asyncHandler(async (req, res) => {
    const db = getDb();
    const user = req.user!;
    const tab = String(req.query.tab || 'all');
    const scope = await getScopeFilter(user);
    const conditions = ['1=1'];
    const params: unknown[] = [];

    if (tab === 'mine') {
      conditions.push('(off.applicant_id = ? OR off.employee_id = ?)');
      params.push(user.id, user.employee_id ?? -1);
    } else if (tab === 'handled') {
      conditions.push(
        `(EXISTS (SELECT 1 FROM approval_steps s WHERE s.biz_type = 'OFFBOARDING' AND s.biz_id = off.id AND s.acted_by = ?)
          OR EXISTS (SELECT 1 FROM approval_logs l WHERE l.biz_type = 'OFFBOARDING' AND l.biz_id = off.id AND l.actor_id = ? AND l.action IN ('APPROVE', 'REJECT')))`
      );
      params.push(user.id, user.id);
    } else if (tab !== 'pending') {
      if (scope.type === 'REGION') {
        if (scope.hotelIds.length === 0) {
          res.json({ requests: [] });
          return;
        }
        conditions.push(`off.hotel_id IN (${scope.hotelIds.map(() => '?').join(',')})`);
        params.push(...scope.hotelIds);
      } else if (scope.type === 'HOTEL') {
        conditions.push('off.hotel_id = ?');
        params.push(scope.hotelId);
      } else if (scope.type === 'SELF') {
        conditions.push('(off.applicant_id = ? OR off.employee_id = ?)');
        params.push(user.id, user.employee_id ?? -1);
      }
    }

    const rows = await db.query<{
      id: number;
      request_no: string;
      employee_id: number;
      hotel_id: number;
      applicant_id: number;
      resign_reason_code: string;
      resign_reason_detail: string;
      last_working_date: string;
      handover_to_employee_id: number | null;
      handover_notes: string | null;
      status: string;
      current_step: number;
      checklist_json: string | null;
      archive_id: number | null;
      created_at: string;
      employee_name: string;
      emp_no: string;
      employee_position: string;
      employee_status: string;
      hotel_name: string;
      department_name: string;
      applicant_name: string;
      handover_to_name: string | null;
    }>(
      `SELECT off.*,
              e.name AS employee_name, e.emp_no, e.position AS employee_position, e.status AS employee_status,
              h.name AS hotel_name, d.name AS department_name,
              u.display_name AS applicant_name,
              he.name AS handover_to_name
       FROM offboarding_requests off
       JOIN employees e ON e.id = off.employee_id
       JOIN hotels h ON h.id = off.hotel_id
       JOIN departments d ON d.id = e.department_id
       JOIN users u ON u.id = off.applicant_id
       LEFT JOIN employees he ON he.id = off.handover_to_employee_id
       WHERE ${conditions.join(' AND ')}
       ORDER BY off.id DESC`,
      params
    );

    const result = [];
    for (const r of rows) {
      const steps = await getWorkflowStepsWithActors(db, 'OFFBOARDING', r.id);
      const pendingStep = steps.find((s) => s.status === 'PENDING');
      const pendingRaw =
        r.status === 'PENDING_APPROVAL'
          ? await db.queryOne<{ approver_role: UserRole; approver_user_id: number | null }>(
              `SELECT approver_role, approver_user_id FROM approval_steps WHERE biz_type = 'OFFBOARDING' AND biz_id = ? AND status = 'PENDING' ORDER BY step_order ASC LIMIT 1`,
              [r.id]
            )
          : null;
      const canApprove =
        r.status === 'PENDING_APPROVAL' && pendingRaw
          ? await canUserActOnStep(db, user, pendingRaw.approver_role, r.hotel_id, r.applicant_id, {
              approverUserId: pendingRaw.approver_user_id,
              bizType: 'OFFBOARDING',
            })
          : false;
      if (tab === 'pending' && !canApprove) continue;
      const canComplete =
        r.status === 'APPROVED' &&
        ['HQ_ADMIN', 'HR_MANAGER', 'STORE_MANAGER'].includes(user.role) &&
        (await canAccessHotel(user, r.hotel_id));

      // Check unsettled cash advances for this employee
      const empUser = await db.queryOne<{ id: number }>('SELECT id FROM users WHERE employee_id = ?', [r.employee_id]);
      const unsettledAdv = empUser
        ? await db.queryOne<{ cnt: number }>(
            `SELECT COUNT(*) AS cnt FROM cash_advances WHERE applicant_id = ? AND status = 'DISBURSED' AND (amount - offset_amount) > 0`,
            [empUser.id]
          )
        : null;

      const clearanceItems = await db.query(
        `SELECT id, item_key, item_label, department_role, status, remark, cleared_by_name, cleared_at
         FROM offboarding_clearance_items WHERE offboarding_id = ? ORDER BY id ASC`,
        [r.id]
      );
      result.push({
        ...r,
        checklist: parseJsonSafe<Record<string, boolean>>(r.checklist_json, {}),
        unsettled_advances: Number(unsettledAdv?.cnt || 0),
        clearance_items: clearanceItems,
        steps,
        canApprove,
        canComplete,
        status_detail: buildStatusDetail({
          bizType: 'OFFBOARDING',
          status: r.status,
          currentStepName: pendingStep?.step_name,
          currentStep: r.current_step,
          totalSteps: steps.length,
        }),
        my_last_action: await getUserLastHandledAction(db, 'OFFBOARDING', r.id, user.id),
      });
    }
    res.json({ requests: result });
  })
);

const createOffboardingSchema = z.object({
  employee_id: z.number().int().positive(),
  resign_reason_code: z.string().trim().min(1, '请选择离职原因'),
  resign_reason_detail: z.string().trim().min(2, '请填写离职详细说明'),
  last_working_date: isoDateSchema.default(todayStr),
  handover_to_employee_id: z.number().int().positive().optional().nullable(),
  handover_notes: z.string().max(500).optional().nullable(),
});

router.post(
  '/offboarding',
  asyncHandler(async (req, res) => {
    const body = createOffboardingSchema.parse(req.body);
    const user = req.user!;
    const db = getDb();

    const emp = await db.queryOne<{ id: number; name: string; hotel_id: number; position: string; status: string }>(
      'SELECT id, name, hotel_id, position, status FROM employees WHERE id = ?',
      [body.employee_id]
    );
    if (!emp) throw new AppError(404, '员工不存在');
    if (emp.status === 'RESIGNED') throw new AppError(400, '该员工已离职并归档');

    const isSelf = user.employee_id && Number(user.employee_id) === Number(emp.id);
    if (!isSelf) {
      if (!['HQ_ADMIN', 'HR_MANAGER', 'REGIONAL_MANAGER', 'STORE_MANAGER'].includes(user.role)) {
        throw new AppError(403, '仅本人或授权管理人员可发起离职申请');
      }
      if (!(await canAccessHotel(user, emp.hotel_id))) {
        throw new AppError(403, '无权为其他门店员工发起离职申请');
      }
    }

    const dup = await db.queryOne<{ id: number }>(
      `SELECT id FROM offboarding_requests WHERE employee_id = ? AND status IN ('PENDING_APPROVAL', 'APPROVED')`,
      [emp.id]
    );
    if (dup) throw new AppError(409, '该员工已有正在处理中的离职申请');

    const targetUser = await db.queryOne<{ id: number; role: UserRole }>('SELECT id, role FROM users WHERE employee_id = ?', [emp.id]);
    const targetRole: UserRole = targetUser?.role || 'STAFF';
    const plannedSteps = buildOffboardingRoute({ targetRole });

    let unsettledAdvanceAmount = 0;
    let pendingReimbursementCount = 0;
    if (targetUser) {
      const advRow = await db.queryOne<{ total: number }>(
        `SELECT COALESCE(SUM(amount - offset_amount - repaid_amount), 0) AS total
         FROM cash_advances WHERE applicant_id = ? AND status = 'DISBURSED'`,
        [targetUser.id]
      );
      unsettledAdvanceAmount = roundMoney(Number(advRow?.total || 0));
      const claimRow = await db.queryOne<{ cnt: number }>(
        `SELECT COUNT(*) AS cnt FROM reimbursements
         WHERE applicant_id = ? AND status IN ('PENDING_APPROVAL', 'RETURNED', 'APPROVED', 'PAYMENT_FAILED')`,
        [targetUser.id]
      );
      pendingReimbursementCount = Number(claimRow?.cnt || 0);
    }

    let handoverToUserId: number | null = null;
    if (body.handover_to_employee_id) {
      const hu = await db.queryOne<{ id: number }>('SELECT id FROM users WHERE employee_id = ?', [body.handover_to_employee_id]);
      handoverToUserId = hu?.id ?? null;
    }

    const requestNo = generateCode('OFF');
    const ts = nowIso();

    const reqId = await db.transaction(async (tx) => {
      const ins = await tx.execute(
        `INSERT INTO offboarding_requests (
          request_no, employee_id, hotel_id, applicant_id, resign_reason_code,
          resign_reason_detail, last_working_date, handover_to_employee_id, handover_to_user_id, handover_notes,
          unsettled_advance_amount, pending_reimbursement_count, settlement_status,
          status, current_step, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'PENDING_APPROVAL', 1, ?, ?)`,
        [
          requestNo,
          emp.id,
          emp.hotel_id,
          user.id,
          body.resign_reason_code,
          body.resign_reason_detail,
          body.last_working_date,
          body.handover_to_employee_id ?? null,
          handoverToUserId,
          body.handover_notes ?? null,
          unsettledAdvanceAmount,
          pendingReimbursementCount,
          unsettledAdvanceAmount > 0 ? 'PENDING' : 'SETTLED',
          ts,
          ts,
        ]
      );

      const clearanceDefs = [
        { key: 'WORK_HANDOVER', label: '工作交接与客户资料移交', role: 'STORE_MANAGER', status: 'PENDING', remark: null },
        { key: 'ASSETS_RETURN', label: '工牌、钥匙及门店资产归还', role: 'STORE_MANAGER', status: 'PENDING', remark: null },
        {
          key: 'ADVANCE_SETTLE',
          label: '财务备用金与在途报销清账',
          role: 'FINANCE',
          status: unsettledAdvanceAmount > 0 ? 'BLOCKED' : 'PENDING',
          remark: unsettledAdvanceAmount > 0 ? `尚有未结清借款 ¥${unsettledAdvanceAmount.toFixed(2)}` : null,
        },
        { key: 'HR_ARCHIVE', label: '人事档案核对与社保停缴确认', role: 'HR_MANAGER', status: 'PENDING', remark: null },
      ];
      for (const item of clearanceDefs) {
        await tx.execute(
          `INSERT INTO offboarding_clearance_items (
            offboarding_id, item_key, item_label, department_role, status, remark, created_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?)`,
          [ins.insertId, item.key, item.label, item.role, item.status, item.remark, ts]
        );
      }

      const resolved = await resolveApprovalRoute(tx, emp.hotel_id, plannedSteps);
      await replaceApprovalSteps(tx, 'OFFBOARDING', ins.insertId, resolved.steps);
      await logApprovalAction(tx, {
        bizType: 'OFFBOARDING',
        bizId: ins.insertId,
        action: 'SUBMIT',
        actor: user,
        comment: `发起离职申请：${emp.name}（最后工作日 ${body.last_working_date}）`,
      });
      return ins.insertId;
    });

    const created = await db.queryOne('SELECT * FROM offboarding_requests WHERE id = ?', [reqId]);
    res.status(201).json({ request: created });
  })
);

router.post(
  '/offboarding/:id/action',
  asyncHandler(async (req, res) => {
    const id = Number(req.params.id);
    const body = flowActionSchema.parse(req.body);
    const db = getDb();
    const user = req.user!;

    const off = await db.queryOne<{ id: number; hotel_id: number; applicant_id: number; status: string; current_step: number }>(
      'SELECT * FROM offboarding_requests WHERE id = ?',
      [id]
    );
    if (!off) throw new AppError(404, '离职申请不存在');
    if (off.status !== 'PENDING_APPROVAL') throw new AppError(400, '当前状态不可审批');

    const stepRow = await db.queryOne<{ approver_role: UserRole; approver_user_id: number | null }>(
      `SELECT approver_role, approver_user_id FROM approval_steps WHERE biz_type = 'OFFBOARDING' AND biz_id = ? AND step_order = ?`,
      [id, off.current_step]
    );
    const canAct = stepRow
      ? await canUserActOnStep(db, user, stepRow.approver_role, off.hotel_id, off.applicant_id, {
          approverUserId: stepRow.approver_user_id,
          bizType: 'OFFBOARDING',
        })
      : false;
    if (!canAct) throw new AppError(403, '当前审批节点无权操作');

    const ts = nowIso();
    await db.transaction(async (tx) => {
      if (body.action === 'REJECT') {
        await tx.execute(
          `UPDATE approval_steps SET status = 'REJECTED', acted_by = ?, acted_at = ?, comment = ?
           WHERE biz_type = 'OFFBOARDING' AND biz_id = ? AND step_order = ?`,
          [user.id, ts, body.comment || '驳回离职申请', id, off.current_step]
        );
        await tx.execute(`UPDATE offboarding_requests SET status = 'REJECTED', updated_at = ? WHERE id = ?`, [
          ts,
          id,
        ]);
      } else {
        await tx.execute(
          `UPDATE approval_steps SET status = 'APPROVED', acted_by = ?, acted_at = ?, comment = ?
           WHERE biz_type = 'OFFBOARDING' AND biz_id = ? AND step_order = ?`,
          [user.id, ts, body.comment || '同意离职', id, off.current_step]
        );
        const nextStep = await tx.queryOne<{ step_order: number }>(
          `SELECT step_order FROM approval_steps WHERE biz_type = 'OFFBOARDING' AND biz_id = ? AND step_order > ? ORDER BY step_order ASC LIMIT 1`,
          [id, off.current_step]
        );
        if (nextStep) {
          await tx.execute(
            `UPDATE approval_steps SET status = 'PENDING' WHERE biz_type = 'OFFBOARDING' AND biz_id = ? AND step_order = ?`,
            [id, nextStep.step_order]
          );
          await tx.execute(`UPDATE offboarding_requests SET current_step = ?, updated_at = ? WHERE id = ?`, [
            nextStep.step_order,
            ts,
            id,
          ]);
        } else {
          await tx.execute(`UPDATE offboarding_requests SET status = 'APPROVED', updated_at = ? WHERE id = ?`, [
            ts,
            id,
          ]);
        }
      }
      await logApprovalAction(tx, {
        bizType: 'OFFBOARDING',
        bizId: id,
        action: body.action,
        actor: user,
        comment: body.comment || (body.action === 'APPROVE' ? '同意离职' : '驳回离职'),
      });
    });

    res.json({ ok: true });
  })
);

router.get(
  '/offboarding/:id/clearance',
  asyncHandler(async (req, res) => {
    const id = Number(req.params.id);
    const db = getDb();
    const off = await db.queryOne<{ id: number; hotel_id: number; employee_id: number; applicant_id: number }>(
      'SELECT id, hotel_id, employee_id, applicant_id FROM offboarding_requests WHERE id = ?',
      [id]
    );
    if (!off) throw new AppError(404, '离职申请不存在');
    const isSelf =
      Number(off.applicant_id) === Number(req.user!.id) ||
      (req.user!.employee_id && Number(off.employee_id) === Number(req.user!.employee_id));
    if (!isSelf && !(await canAccessHotel(req.user!, off.hotel_id))) {
      throw new AppError(403, '无权查看该离职清查清单');
    }
    const items = await db.query(
      'SELECT * FROM offboarding_clearance_items WHERE offboarding_id = ? ORDER BY id ASC',
      [id]
    );
    res.json({ items });
  })
);

router.post(
  '/offboarding/:id/clearance/:itemId',
  requireRoles('HQ_ADMIN', 'HR_MANAGER', 'FINANCE', 'STORE_MANAGER', 'REGIONAL_MANAGER'),
  asyncHandler(async (req, res) => {
    const id = Number(req.params.id);
    const itemId = Number(req.params.itemId);
    const body = z
      .object({
        status: z.enum(['CLEARED', 'BLOCKED']),
        remark: z.string().max(255).optional().nullable(),
        allow_salary_deduct: z.boolean().optional().default(false),
      })
      .parse(req.body || {});

    const db = getDb();
    const off = await db.queryOne<{ id: number; employee_id: number; hotel_id: number }>(
      'SELECT id, employee_id, hotel_id FROM offboarding_requests WHERE id = ?',
      [id]
    );
    if (!off) throw new AppError(404, '离职申请不存在');
    if (!(await canAccessHotel(req.user!, off.hotel_id))) {
      throw new AppError(403, '无权操作其他门店离职清查');
    }

    const item = await db.queryOne<{ id: number; item_key: string }>(
      'SELECT id, item_key FROM offboarding_clearance_items WHERE id = ? AND offboarding_id = ?',
      [itemId, id]
    );
    if (!item) throw new AppError(404, '清查项不存在');

    const ts = nowIso();
    await db.transaction(async (tx) => {
      if (item.item_key === 'ADVANCE_SETTLE' && body.status === 'CLEARED') {
        const empUser = await tx.queryOne<{ id: number }>('SELECT id FROM users WHERE employee_id = ?', [off.employee_id]);
        let unsettled = 0;
        if (empUser) {
          const advRow = await tx.queryOne<{ total: number }>(
            `SELECT COALESCE(SUM(amount - offset_amount - repaid_amount), 0) AS total
             FROM cash_advances WHERE applicant_id = ? AND status = 'DISBURSED'`,
            [empUser.id]
          );
          unsettled = roundMoney(Number(advRow?.total || 0));
        }
        if (unsettled > 0 && !body.allow_salary_deduct) {
          throw new AppError(400, `该员工尚有未结清借款 ¥${unsettled.toFixed(2)}，请先冲销/还款或勾选离职薪资扣回后确认清账`);
        }
        if (unsettled > 0 && body.allow_salary_deduct) {
          await tx.execute(
            `UPDATE offboarding_requests SET settlement_status = 'SALARY_DEDUCT', updated_at = ? WHERE id = ?`,
            [ts, id]
          );
        } else {
          await tx.execute(
            `UPDATE offboarding_requests SET settlement_status = 'SETTLED', unsettled_advance_amount = 0, updated_at = ? WHERE id = ?`,
            [ts, id]
          );
        }
      }

      await tx.execute(
        `UPDATE offboarding_clearance_items
         SET status = ?, remark = ?, cleared_by = ?, cleared_by_name = ?, cleared_at = ?
         WHERE id = ?`,
        [body.status, body.remark ?? null, req.user!.id, req.user!.display_name, ts, itemId]
      );
    });

    res.json({ ok: true });
  })
);

const completeOffboardingSchema = z.object({
  checklist: z.record(z.string(), z.boolean()).optional(),
  schedule_for_effective_date: z.boolean().optional().default(false),
  allow_salary_deduct: z.boolean().optional().default(false),
});

router.post(
  '/offboarding/:id/complete',
  requireRoles('HQ_ADMIN', 'HR_MANAGER', 'STORE_MANAGER'),
  asyncHandler(async (req, res) => {
    const id = Number(req.params.id);
    const body = completeOffboardingSchema.parse(req.body || {});
    const db = getDb();
    const user = req.user!;

    const off = await db.queryOne<{
      id: number;
      request_no: string;
      employee_id: number;
      hotel_id: number;
      resign_reason_code: string;
      resign_reason_detail: string;
      last_working_date: string;
      settlement_status: string;
      status: string;
    }>('SELECT * FROM offboarding_requests WHERE id = ?', [id]);

    if (!off) throw new AppError(404, '离职申请不存在');
    if (off.status !== 'APPROVED') throw new AppError(400, '仅审批通过的离职申请可办理离职并归档');
    if (!(await canAccessHotel(user, off.hotel_id))) {
      throw new AppError(403, '无权办理该门店员工离职');
    }

    const blockedItem = await db.queryOne<{ id: number; item_label: string }>(
      `SELECT id, item_label FROM offboarding_clearance_items
       WHERE offboarding_id = ? AND status = 'BLOCKED' LIMIT 1`,
      [id]
    );
    if (blockedItem) {
      throw new AppError(400, `存在未解除阻塞的离职清查项：${blockedItem.item_label}`);
    }

    const empUser = await db.queryOne<{ id: number }>('SELECT id FROM users WHERE employee_id = ?', [off.employee_id]);
    if (empUser) {
      const advRow = await db.queryOne<{ total: number }>(
        `SELECT COALESCE(SUM(amount - offset_amount - repaid_amount), 0) AS total
         FROM cash_advances WHERE applicant_id = ? AND status = 'DISBURSED'`,
        [empUser.id]
      );
      const unsettled = roundMoney(Number(advRow?.total || 0));
      if (unsettled > 0 && !body.allow_salary_deduct && off.settlement_status !== 'SALARY_DEDUCT') {
        throw new AppError(400, `员工尚有未结清借款 ¥${unsettled.toFixed(2)}，请先清账或勾选离职薪资扣回`);
      }
    }

    const ts = nowIso();
    if (body.schedule_for_effective_date && off.last_working_date > todayStr()) {
      await db.execute(
        `UPDATE offboarding_requests
         SET scheduled_execute = 1,
             settlement_status = CASE WHEN ? = 1 THEN 'SALARY_DEDUCT' ELSE settlement_status END,
             updated_at = ?
         WHERE id = ?`,
        [body.allow_salary_deduct ? 1 : 0, ts, id]
      );
      res.json({ ok: true, scheduled: true, last_working_date: off.last_working_date });
      return;
    }

    const archiveId = await db.transaction(async (tx) => {
      return completeOffboardingTx(tx, off, user, {
        checklist: body.checklist,
        settlementStatus:
          body.allow_salary_deduct || off.settlement_status === 'SALARY_DEDUCT' ? 'SALARY_DEDUCT' : 'SETTLED',
      });
    });

    res.json({ ok: true, archiveId });
  })
);

router.post(
  '/offboarding/run-scheduled',
  requireRoles('HQ_ADMIN', 'HR_MANAGER'),
  asyncHandler(async (req, res) => {
    const db = getDb();
    const result = await runScheduledJobs(db, req.user!);
    res.json({ ok: true, ...result });
  })
);

// ==========================================
// 3. Employee Archives (/api/hr-flows/archives)
// ==========================================
router.get(
  '/archives',
  asyncHandler(async (req, res) => {
    const db = getDb();
    const user = req.user!;
    const scope = await getScopeFilter(user);
    const conditions = ['1=1'];
    const params: unknown[] = [];

    if (scope.type === 'REGION') {
      if (scope.hotelIds.length === 0) {
        res.json({ archives: [] });
        return;
      }
      conditions.push(`hotel_id IN (${scope.hotelIds.map(() => '?').join(',')})`);
      params.push(...scope.hotelIds);
    } else if (scope.type === 'HOTEL') {
      conditions.push('hotel_id = ?');
      params.push(scope.hotelId);
    } else if (scope.type === 'SELF') {
      conditions.push('employee_id = ?');
      params.push(scope.employeeId ?? -1);
    }

    if (req.query.keyword) {
      const kw = `%${String(req.query.keyword).trim()}%`;
      conditions.push('(employee_name LIKE ? OR emp_no LIKE ? OR position LIKE ? OR hotel_name LIKE ?)');
      params.push(kw, kw, kw, kw);
    }

    const rows = await db.query<{
      id: number;
      employee_id: number;
      emp_no: string;
      employee_name: string;
      hotel_id: number;
      hotel_name: string;
      department_name: string;
      position: string;
      hire_date: string;
      resign_date: string;
      resign_reason: string;
      offboarding_request_id: number | null;
      summary_json: string;
      archived_by_name: string;
      archived_at: string;
    }>(
      `SELECT id, employee_id, emp_no, employee_name, hotel_id, hotel_name, department_name,
              position, hire_date, resign_date, resign_reason, offboarding_request_id,
              summary_json, archived_by_name, archived_at
       FROM employee_archives
       WHERE ${conditions.join(' AND ')}
       ORDER BY id DESC`,
      params
    );

    res.json({
      archives: rows.map((r) => ({
        ...r,
        summary: parseJsonSafe<Record<string, number>>(r.summary_json, {}),
      })),
    });
  })
);

router.get(
  '/archives/:employeeId',
  asyncHandler(async (req, res) => {
    const employeeId = Number(req.params.employeeId);
    const db = getDb();
    const user = req.user!;

    const row = await db.queryOne<{
      id: number;
      employee_id: number;
      emp_no: string;
      employee_name: string;
      hotel_id: number;
      hotel_name: string;
      department_name: string;
      position: string;
      hire_date: string;
      resign_date: string;
      resign_reason: string;
      offboarding_request_id: number | null;
      employee_snapshot_json: string;
      summary_json: string;
      records_json: string;
      archived_by_name: string;
      archived_at: string;
    }>('SELECT * FROM employee_archives WHERE employee_id = ?', [employeeId]);

    if (!row) throw new AppError(404, '未找到该员工的离职归档记录');
    const isSelf = user.employee_id && Number(user.employee_id) === Number(employeeId);
    if (!isSelf && !(await canAccessHotel(user, row.hotel_id))) {
      throw new AppError(403, '无权查看其他门店离职归档记录');
    }

    res.json({
      archive: {
        ...row,
        snapshot: parseJsonSafe<Record<string, unknown>>(row.employee_snapshot_json, {}),
        summary: parseJsonSafe<Record<string, number>>(row.summary_json, {}),
        records: parseJsonSafe<Record<string, unknown[]>>(row.records_json, {}),
      },
    });
  })
);

// ==========================================
// 4. Employee Change Requests (/api/hr-flows/changes) - T2-01
// ==========================================
router.get(
  '/changes',
  asyncHandler(async (req, res) => {
    const db = getDb();
    const user = req.user!;
    const scope = await getScopeFilter(user);
    const conditions = ['1=1'];
    const params: unknown[] = [];

    if (scope.type === 'REGION') {
      if (scope.hotelIds.length === 0) {
        res.json({ requests: [] });
        return;
      }
      conditions.push(`(c.from_hotel_id IN (${scope.hotelIds.map(() => '?').join(',')}) OR c.to_hotel_id IN (${scope.hotelIds.map(() => '?').join(',')}))`);
      params.push(...scope.hotelIds, ...scope.hotelIds);
    } else if (scope.type === 'HOTEL') {
      conditions.push('(c.from_hotel_id = ? OR c.to_hotel_id = ?)');
      params.push(scope.hotelId, scope.hotelId);
    } else if (scope.type === 'SELF') {
      conditions.push('(c.applicant_id = ? OR c.employee_id = ?)');
      params.push(user.id, user.employee_id ?? -1);
    }

    const rows = await db.query<{
      id: number;
      request_no: string;
      employee_id: number;
      change_type: string;
      from_hotel_id: number;
      to_hotel_id: number;
      from_department_id: number;
      to_department_id: number;
      from_position: string;
      to_position: string;
      from_salary: number;
      to_salary: number;
      effective_date: string;
      reason: string;
      applicant_id: number;
      status: string;
      current_step: number;
      executed_at: string | null;
      created_at: string;
      employee_name: string;
      emp_no: string;
      from_hotel_name: string;
      to_hotel_name: string;
      applicant_name: string;
    }>(
      `SELECT c.*, e.name AS employee_name, e.emp_no,
              fh.name AS from_hotel_name, th.name AS to_hotel_name, u.display_name AS applicant_name
       FROM employee_change_requests c
       JOIN employees e ON e.id = c.employee_id
       JOIN hotels fh ON fh.id = c.from_hotel_id
       JOIN hotels th ON th.id = c.to_hotel_id
       JOIN users u ON u.id = c.applicant_id
       WHERE ${conditions.join(' AND ')}
       ORDER BY c.id DESC`,
      params
    );

    const result = [];
    for (const r of rows) {
      const steps = await getWorkflowStepsWithActors(db, 'EMPLOYEE_CHANGE', r.id);
      const pendingStep =
        r.status === 'PENDING_APPROVAL'
          ? await db.queryOne<{ step_name: string; approver_role: UserRole; approver_user_id: number | null }>(
              `SELECT step_name, approver_role, approver_user_id FROM approval_steps
               WHERE biz_type = 'EMPLOYEE_CHANGE' AND biz_id = ? AND status = 'PENDING'
               ORDER BY step_order ASC LIMIT 1`,
              [r.id]
            )
          : null;
      const canApprove = pendingStep
        ? await canUserActOnStep(db, user, pendingStep.approver_role, r.from_hotel_id, r.applicant_id, {
            approverUserId: pendingStep.approver_user_id,
            bizType: 'EMPLOYEE_CHANGE',
          })
        : false;
      result.push({
        ...r,
        steps,
        canApprove,
        status_detail: buildStatusDetail({
          bizType: 'EMPLOYEE_CHANGE',
          status: r.status,
          currentStepName: pendingStep?.step_name ?? null,
          currentStep: r.current_step,
          totalSteps: steps.length,
        }),
      });
    }

    res.json({ requests: result });
  })
);

const createChangeSchema = z.object({
  employee_id: z.number().int().positive(),
  change_type: z.enum(['PROBATION_PASS', 'TRANSFER', 'PROMOTE', 'SALARY_ADJUST']),
  to_hotel_id: z.number().int().positive().optional(),
  to_department_id: z.number().int().positive().optional(),
  to_position: z.string().trim().min(1).optional(),
  to_salary: z.number().min(0).max(1_000_000).optional(),
  effective_date: isoDateSchema,
  reason: z.string().trim().min(2, '请填写异动原因'),
});

router.post(
  '/changes',
  requireRoles('HQ_ADMIN', 'HR_MANAGER', 'REGIONAL_MANAGER', 'STORE_MANAGER'),
  asyncHandler(async (req, res) => {
    const body = createChangeSchema.parse(req.body);
    const db = getDb();
    const user = req.user!;

    const emp = await db.queryOne<{
      id: number;
      name: string;
      hotel_id: number;
      department_id: number;
      position: string;
      base_salary: number;
      status: string;
    }>('SELECT id, name, hotel_id, department_id, position, base_salary, status FROM employees WHERE id = ?', [
      body.employee_id,
    ]);
    if (!emp) throw new AppError(404, '员工不存在');
    if (emp.status === 'RESIGNED') throw new AppError(400, '已离职员工不可发起人事异动');
    if (!(await canAccessHotel(user, emp.hotel_id))) {
      throw new AppError(403, '无权为其他门店员工发起人事异动');
    }

    const toHotelId = body.to_hotel_id ?? emp.hotel_id;
    const toDeptId = body.to_department_id ?? emp.department_id;
    const toPosition = body.to_position ?? emp.position;
    const toSalary = body.to_salary ?? Number(emp.base_salary);

    const dept = await db.queryOne<{ id: number }>('SELECT id FROM departments WHERE id = ? AND hotel_id = ?', [
      toDeptId,
      toHotelId,
    ]);
    if (!dept) throw new AppError(400, '目标部门不属于目标门店');

    const plannedSteps =
      body.change_type === 'TRANSFER' || body.change_type === 'SALARY_ADJUST'
        ? [
            { stepOrder: 1, stepName: '集团HR审批', approverRole: 'HR_MANAGER' as UserRole },
            { stepOrder: 2, stepName: '集团总经理终审', approverRole: 'GENERAL_MANAGER' as UserRole },
          ]
        : [{ stepOrder: 1, stepName: '集团HR审批', approverRole: 'HR_MANAGER' as UserRole }];

    const requestNo = generateCode('CHG');
    const ts = nowIso();

    const chgId = await db.transaction(async (tx) => {
      const ins = await tx.execute(
        `INSERT INTO employee_change_requests (
          request_no, employee_id, change_type, from_hotel_id, to_hotel_id,
          from_department_id, to_department_id, from_position, to_position,
          from_salary, to_salary, effective_date, reason, applicant_id,
          status, current_step, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'PENDING_APPROVAL', 1, ?, ?)`,
        [
          requestNo,
          emp.id,
          body.change_type,
          emp.hotel_id,
          toHotelId,
          emp.department_id,
          toDeptId,
          emp.position,
          toPosition,
          emp.base_salary,
          toSalary,
          body.effective_date,
          body.reason,
          user.id,
          ts,
          ts,
        ]
      );

      const resolved = await resolveApprovalRoute(tx, emp.hotel_id, plannedSteps, user.id);
      await replaceApprovalSteps(tx, 'EMPLOYEE_CHANGE', ins.insertId, resolved.steps);
      await logApprovalAction(tx, {
        bizType: 'EMPLOYEE_CHANGE',
        bizId: ins.insertId,
        action: 'SUBMIT',
        actor: user,
        comment: `发起人事异动(${body.change_type})：${emp.name}，生效日 ${body.effective_date}`,
      });
      return ins.insertId;
    });

    const created = await db.queryOne('SELECT * FROM employee_change_requests WHERE id = ?', [chgId]);
    res.status(201).json({ request: created });
  })
);

router.post(
  '/changes/:id/action',
  asyncHandler(async (req, res) => {
    const id = Number(req.params.id);
    const body = flowActionSchema.parse(req.body);
    const db = getDb();
    const user = req.user!;
    const ts = nowIso();
    const today = todayStr();

    await db.transaction(async (tx) => {
      const chg = await tx.queryOne<{
        id: number;
        request_no: string;
        employee_id: number;
        change_type: string;
        from_hotel_id: number;
        to_hotel_id: number;
        from_department_id: number;
        to_department_id: number;
        from_position: string;
        to_position: string;
        from_salary: number;
        to_salary: number;
        effective_date: string;
        reason: string;
        applicant_id: number;
        status: string;
      }>(`SELECT * FROM employee_change_requests WHERE id = ?${tx.forUpdateSuffix()}`, [id]);
      if (!chg) throw new AppError(404, '人事异动申请不存在');
      if (chg.status !== 'PENDING_APPROVAL') throw new AppError(400, '当前状态不可审批');

      const step = await tx.queryOne<{ id: number; step_order: number; approver_role: UserRole; approver_user_id: number | null }>(
        `SELECT id, step_order, approver_role, approver_user_id FROM approval_steps
         WHERE biz_type = 'EMPLOYEE_CHANGE' AND biz_id = ? AND status = 'PENDING'
         ORDER BY step_order ASC LIMIT 1`,
        [id]
      );
      if (!step) throw new AppError(400, '未找到待审批节点');
      if (
        !(await canUserActOnStep(tx, user, step.approver_role, chg.from_hotel_id, chg.applicant_id, {
          approverUserId: step.approver_user_id,
          bizType: 'EMPLOYEE_CHANGE',
        }))
      ) {
        throw new AppError(403, '您无权审批当前人事异动节点');
      }

      if (body.action === 'REJECT') {
        await tx.execute(
          `UPDATE approval_steps SET status = 'REJECTED', acted_by = ?, acted_at = ?, comment = ? WHERE id = ?`,
          [user.id, ts, body.comment || '驳回', step.id]
        );
        await tx.execute(`UPDATE employee_change_requests SET status = 'REJECTED', updated_at = ? WHERE id = ?`, [ts, id]);
      } else {
        await tx.execute(
          `UPDATE approval_steps SET status = 'APPROVED', acted_by = ?, acted_at = ?, comment = ? WHERE id = ?`,
          [user.id, ts, body.comment || '同意', step.id]
        );
        const nextStep = await tx.queryOne<{ id: number; step_order: number }>(
          `SELECT id, step_order FROM approval_steps
           WHERE biz_type = 'EMPLOYEE_CHANGE' AND biz_id = ? AND step_order > ?
           ORDER BY step_order ASC LIMIT 1`,
          [id, step.step_order]
        );
        if (nextStep) {
          await tx.execute(`UPDATE approval_steps SET status = 'PENDING' WHERE id = ?`, [nextStep.id]);
          await tx.execute(`UPDATE employee_change_requests SET current_step = ?, updated_at = ? WHERE id = ?`, [
            nextStep.step_order,
            ts,
            id,
          ]);
        } else {
          await tx.execute(`UPDATE employee_change_requests SET status = 'APPROVED', updated_at = ? WHERE id = ?`, [
            ts,
            id,
          ]);
          if (chg.effective_date <= today) {
            await executeEmployeeChangeTx(tx, chg, user);
          }
        }
      }

      await logApprovalAction(tx, {
        bizType: 'EMPLOYEE_CHANGE',
        bizId: id,
        action: body.action,
        actor: user,
        comment: body.comment || (body.action === 'APPROVE' ? '同意人事异动' : '驳回人事异动'),
      });
    });

    res.json({ ok: true });
  })
);

router.post(
  '/run-scheduled',
  requireRoles('HQ_ADMIN', 'HR_MANAGER'),
  asyncHandler(async (req, res) => {
    const result = await runScheduledJobs(getDb(), req.user!);
    res.json({ ok: true, ...result });
  })
);

// ==========================================
// 5. Contract Renewals (/api/hr-flows/contracts) - T2-02
// ==========================================
router.get(
  '/contracts',
  asyncHandler(async (req, res) => {
    const db = getDb();
    const user = req.user!;
    const scope = await getScopeFilter(user);
    const cond = ['1=1'];
    const params: unknown[] = [];

    if (scope.type === 'SELF') {
      cond.push('(cr.applicant_id = ? OR cr.employee_id = ?)');
      params.push(user.id, scope.employeeId ?? -1);
    } else if (scope.type === 'HOTEL') {
      cond.push('cr.hotel_id = ?');
      params.push(scope.hotelId);
    } else if (scope.type === 'REGION') {
      if (scope.hotelIds.length === 0) {
        res.json({ contracts: [] });
        return;
      }
      cond.push(`cr.hotel_id IN (${scope.hotelIds.map(() => '?').join(',')})`);
      params.push(...scope.hotelIds);
    }

    const rows = await db.query<{
      id: number;
      request_no: string;
      employee_id: number;
      hotel_id: number;
      current_end_date: string | null;
      proposed_end_date: string | null;
      contract_term_years: number;
      contract_type: string;
      proposed_salary: number | null;
      remarks: string | null;
      applicant_id: number;
      status: string;
      current_step: number;
      signed_at: string | null;
      emp_name: string;
      emp_no: string;
      hotel_name: string;
    }>(
      `SELECT cr.*, e.name AS emp_name, e.emp_no, h.name AS hotel_name
       FROM contract_renewals cr
       JOIN employees e ON e.id = cr.employee_id
       JOIN hotels h ON h.id = cr.hotel_id
       WHERE ${cond.join(' AND ')}
       ORDER BY cr.id DESC`,
      params
    );

    const contracts = [];
    for (const r of rows) {
      const steps = await getWorkflowStepsWithActors(db, 'CONTRACT_RENEWAL', r.id);
      const pendingStep =
        r.status === 'PENDING_APPROVAL'
          ? await db.queryOne<{ approver_role: UserRole; approver_user_id: number | null }>(
              `SELECT approver_role, approver_user_id FROM approval_steps
               WHERE biz_type = 'CONTRACT_RENEWAL' AND biz_id = ? AND status = 'PENDING'
               ORDER BY step_order ASC LIMIT 1`,
              [r.id]
            )
          : null;
      const canApprove = pendingStep
        ? await canUserActOnStep(db, user, pendingStep.approver_role, r.hotel_id, r.applicant_id, {
            approverUserId: pendingStep.approver_user_id,
            bizType: 'CONTRACT_RENEWAL',
          })
        : false;
      contracts.push({ ...r, steps, canApprove });
    }
    res.json({ contracts });
  })
);

router.post(
  '/contracts',
  requireRoles('HQ_ADMIN', 'HR_MANAGER', 'REGIONAL_MANAGER', 'STORE_MANAGER'),
  asyncHandler(async (req, res) => {
    const body = z
      .object({
        employee_id: z.number().int().positive(),
        contract_type: z.enum(['FIXED_TERM', 'OPEN_ENDED']).default('FIXED_TERM'),
        contract_term_years: z.number().int().min(1).max(20).default(2),
        proposed_end_date: isoDateSchema.optional().nullable(),
        proposed_salary: z.number().min(0).max(1_000_000).optional().nullable(),
        remarks: z.string().max(500).optional().nullable(),
      })
      .parse(req.body);

    const db = getDb();
    const user = req.user!;
    const emp = await db.queryOne<{
      id: number;
      name: string;
      hotel_id: number;
      status: string;
      contract_end_date: string | null;
    }>('SELECT id, name, hotel_id, status, contract_end_date FROM employees WHERE id = ?', [body.employee_id]);
    if (!emp) throw new AppError(404, '员工不存在');
    if (emp.status === 'RESIGNED') throw new AppError(400, '已离职员工不可发起合同续签');
    if (!(await canAccessHotel(user, emp.hotel_id))) {
      throw new AppError(403, '无权为其他门店员工发起合同续签');
    }

    const proposedEnd =
      body.contract_type === 'OPEN_ENDED'
        ? null
        : body.proposed_end_date ||
          addDays(emp.contract_end_date || todayStr(), body.contract_term_years * 365);

    const ts = nowIso();
    const requestNo = generateCode('CTR');
    const crId = await db.transaction(async (tx) => {
      const ins = await tx.execute(
        `INSERT INTO contract_renewals (
          request_no, employee_id, hotel_id, current_end_date, proposed_end_date,
          contract_term_years, contract_type, proposed_salary, remarks, applicant_id,
          status, current_step, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'PENDING_APPROVAL', 1, ?, ?)`,
        [
          requestNo,
          emp.id,
          emp.hotel_id,
          emp.contract_end_date,
          proposedEnd,
          body.contract_term_years,
          body.contract_type,
          body.proposed_salary ?? null,
          body.remarks ?? null,
          user.id,
          ts,
          ts,
        ]
      );
      const resolved = await resolveApprovalRoute(
        tx,
        emp.hotel_id,
        [
          { stepOrder: 1, stepName: '集团HR审批', approverRole: 'HR_MANAGER' },
          { stepOrder: 2, stepName: '集团总经理审批', approverRole: 'GENERAL_MANAGER' },
        ],
        user.id
      );
      await replaceApprovalSteps(tx, 'CONTRACT_RENEWAL', ins.insertId, resolved.steps);
      await logApprovalAction(tx, {
        bizType: 'CONTRACT_RENEWAL',
        bizId: ins.insertId,
        action: 'SUBMIT',
        actor: user,
        comment: `发起劳动合同续签：${emp.name}（${body.contract_type}）`,
      });
      return ins.insertId;
    });

    const contract = await db.queryOne('SELECT * FROM contract_renewals WHERE id = ?', [crId]);
    res.status(201).json({ contract });
  })
);

router.post(
  '/contracts/:id/action',
  asyncHandler(async (req, res) => {
    const id = Number(req.params.id);
    const body = flowActionSchema.parse(req.body);
    const db = getDb();
    const user = req.user!;
    const ts = nowIso();

    await db.transaction(async (tx) => {
      const cr = await tx.queryOne<{ id: number; hotel_id: number; applicant_id: number; status: string }>(
        `SELECT id, hotel_id, applicant_id, status FROM contract_renewals WHERE id = ?${tx.forUpdateSuffix()}`,
        [id]
      );
      if (!cr) throw new AppError(404, '续签申请不存在');
      if (cr.status !== 'PENDING_APPROVAL') throw new AppError(400, '当前状态不可审批');

      const step = await tx.queryOne<{ id: number; step_order: number; approver_role: UserRole; approver_user_id: number | null }>(
        `SELECT id, step_order, approver_role, approver_user_id FROM approval_steps
         WHERE biz_type = 'CONTRACT_RENEWAL' AND biz_id = ? AND status = 'PENDING'
         ORDER BY step_order ASC LIMIT 1`,
        [id]
      );
      if (!step) throw new AppError(400, '未找到待审批节点');
      if (
        !(await canUserActOnStep(tx, user, step.approver_role, cr.hotel_id, cr.applicant_id, {
          approverUserId: step.approver_user_id,
          bizType: 'CONTRACT_RENEWAL',
        }))
      ) {
        throw new AppError(403, '无权审批该合同续签节点');
      }

      if (body.action === 'REJECT') {
        await tx.execute(
          `UPDATE approval_steps SET status = 'REJECTED', acted_by = ?, acted_at = ?, comment = ? WHERE id = ?`,
          [user.id, ts, body.comment || '驳回', step.id]
        );
        await tx.execute(`UPDATE contract_renewals SET status = 'REJECTED', updated_at = ? WHERE id = ?`, [ts, id]);
      } else {
        await tx.execute(
          `UPDATE approval_steps SET status = 'APPROVED', acted_by = ?, acted_at = ?, comment = ? WHERE id = ?`,
          [user.id, ts, body.comment || '同意', step.id]
        );
        const nextStep = await tx.queryOne<{ id: number; step_order: number }>(
          `SELECT id, step_order FROM approval_steps
           WHERE biz_type = 'CONTRACT_RENEWAL' AND biz_id = ? AND step_order > ?
           ORDER BY step_order ASC LIMIT 1`,
          [id, step.step_order]
        );
        if (nextStep) {
          await tx.execute(`UPDATE approval_steps SET status = 'PENDING' WHERE id = ?`, [nextStep.id]);
          await tx.execute(`UPDATE contract_renewals SET current_step = ?, updated_at = ? WHERE id = ?`, [
            nextStep.step_order,
            ts,
            id,
          ]);
        } else {
          await tx.execute(`UPDATE contract_renewals SET status = 'APPROVED', updated_at = ? WHERE id = ?`, [ts, id]);
        }
      }

      await logApprovalAction(tx, {
        bizType: 'CONTRACT_RENEWAL',
        bizId: id,
        action: body.action,
        actor: user,
        comment: body.comment || (body.action === 'APPROVE' ? '同意续签' : '驳回续签'),
      });
    });

    res.json({ ok: true });
  })
);

router.post(
  '/contracts/:id/sign',
  requireRoles('HQ_ADMIN', 'HR_MANAGER'),
  asyncHandler(async (req, res) => {
    const id = Number(req.params.id);
    const db = getDb();
    const user = req.user!;
    const ts = nowIso();

    await db.transaction(async (tx) => {
      const cr = await tx.queryOne<{
        id: number;
        request_no: string;
        employee_id: number;
        hotel_id: number;
        proposed_end_date: string | null;
        proposed_salary: number | null;
        contract_type: string;
        status: string;
      }>(`SELECT * FROM contract_renewals WHERE id = ?${tx.forUpdateSuffix()}`, [id]);
      if (!cr) throw new AppError(404, '续签申请不存在');
      if (cr.status !== 'APPROVED') throw new AppError(400, '仅审批通过的续签申请可确认签署');

      const emp = await tx.queryOne<{ id: number; position: string; base_salary: number }>(
        'SELECT id, position, base_salary FROM employees WHERE id = ?',
        [cr.employee_id]
      );
      if (!emp) throw new AppError(404, '员工不存在');

      const upd = await tx.execute(
        `UPDATE contract_renewals SET status = 'SIGNED', signed_at = ?, updated_at = ? WHERE id = ? AND status = 'APPROVED'`,
        [ts, ts, id]
      );
      if (upd.affectedRows !== 1) throw new AppError(409, '续签状态已变更，请刷新后重试');

      await tx.execute(
        `UPDATE employees
         SET contract_end_date = ?, base_salary = COALESCE(?, base_salary), updated_at = ?
         WHERE id = ?`,
        [cr.proposed_end_date, cr.proposed_salary, ts, cr.employee_id]
      );

      await tx.execute(
        `INSERT INTO employee_lifecycle_events (
          employee_id, event_type, from_hotel_id, to_hotel_id, from_position, to_position,
          effective_date, reason, operator_id, created_at
        ) VALUES (?, 'CONTRACT_RENEW', ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          cr.employee_id,
          cr.hotel_id,
          cr.hotel_id,
          emp.position,
          emp.position,
          todayStr(),
          `合同续签签署生效（${cr.request_no}，${cr.contract_type}）`,
          user.id,
          ts,
        ]
      );

      await logApprovalAction(tx, {
        bizType: 'CONTRACT_RENEWAL',
        bizId: id,
        action: 'SIGN',
        actor: user,
        comment: `完成合同签署，新到期日：${cr.proposed_end_date || '无固定期限'}`,
      });
    });

    res.json({ ok: true });
  })
);

export default router;
