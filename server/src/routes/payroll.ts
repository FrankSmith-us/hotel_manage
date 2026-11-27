import { Router } from 'express';
import { z } from 'zod';
import { getDb } from '../../db';
import {
  AppError,
  asyncHandler,
  authenticate,
  buildHotelScopeSql,
  getScopeFilter,
  requireRoles,
} from '../middleware/auth';
import { BUSINESS_RULES, assertSegregation } from '../config/businessRules';
import { logApprovalAction } from '../services/auditService';
import { calculateMonthlyPayroll, computeCumulativeIit } from '../services/payrollService';
import {
  buildStatusDetail,
  canUserActOnStep,
  getWorkflowStepsWithActors,
  replaceApprovalSteps,
  resolveApprovalRoute,
} from '../services/workflowEngine';
import { UserRole } from '../types';
import { buildCsv } from '../utils/csv';
import { currentYearMonth, generateCode, nowIso, roundMoney } from '../utils/numbers';

const router = Router();
router.use(authenticate);

router.get(
  '/',
  asyncHandler(async (req, res) => {
    const db = getDb();
    const user = req.user!;
    const yearMonth = String(req.query.yearMonth || currentYearMonth());
    const scope = await getScopeFilter(user);

    const conditions = ['p.`year_month` = ?'];
    const params: unknown[] = [yearMonth];

    if (scope.type === 'REGION') {
      if (scope.hotelIds.length === 0) {
        res.json({ yearMonth, records: [] });
        return;
      }
      conditions.push(`p.hotel_id IN (${scope.hotelIds.map(() => '?').join(',')})`);
      params.push(...scope.hotelIds);
    } else if (scope.type === 'HOTEL') {
      conditions.push('p.hotel_id = ?');
      params.push(scope.hotelId);
    } else if (scope.type === 'SELF') {
      conditions.push('p.employee_id = ?');
      params.push(scope.employeeId);
    }

    if (req.query.hotelId && scope.type !== 'SELF' && scope.type !== 'HOTEL') {
      conditions.push('p.hotel_id = ?');
      params.push(Number(req.query.hotelId));
    }

    const records = await db.query(
      `SELECT p.*, e.emp_no, e.name AS emp_name, e.position, d.name AS department_name, h.name AS hotel_name
       FROM payroll_records p
       JOIN employees e ON e.id = p.employee_id
       JOIN departments d ON d.id = e.department_id
       JOIN hotels h ON h.id = p.hotel_id
       WHERE ${conditions.join(' AND ')}
       ORDER BY p.hotel_id ASC, e.id ASC`,
      params
    );

    res.json({ yearMonth, records });
  })
);

router.post(
  '/calculate',
  requireRoles('HQ_ADMIN', 'HR_MANAGER'),
  asyncHandler(async (req, res) => {
    const body = z
      .object({
        yearMonth: z.string().regex(/^\d{4}-\d{2}$/),
        hotelId: z.number().int().positive().optional(),
      })
      .parse(req.body);

    const db = getDb();
    const result = await db.transaction(async (tx) => {
      return calculateMonthlyPayroll(tx, {
        yearMonth: body.yearMonth,
        hotelId: body.hotelId,
      });
    });

    res.json({ ok: true, ...result });
  })
);

router.put(
  '/:id',
  requireRoles('HQ_ADMIN', 'HR_MANAGER', 'FINANCE'),
  asyncHandler(async (req, res) => {
    const id = Number(req.params.id);
    const body = z
      .object({
        performance_bonus: z.number().min(0).max(1_000_000, '绩效奖金超出合理范围').optional(),
        other_allowance: z.number().min(0).max(1_000_000, '其他补贴超出合理范围').optional(),
        advance_deduction: z.number().min(0).max(1_000_000, '借款扣款超出合理范围').optional(),
        other_deduction: z.number().min(0).max(1_000_000, '其他扣款超出合理范围').optional(),
        notes: z.string().optional().nullable(),
      })
      .parse(req.body);

    const db = getDb();
    const updated = await db.transaction(async (tx) => {
      const row = await tx.queryOne<{
        id: number;
        employee_id: number;
        year_month: string;
        status: string;
        base_salary: number;
        night_allowance: number;
        overtime_pay: number;
        leave_deduction: number;
        performance_bonus: number;
        other_allowance: number;
        social_security: number;
        special_deduction: number;
        advance_deduction: number;
        other_deduction: number;
      }>(`SELECT * FROM payroll_records WHERE id = ?${tx.forUpdateSuffix()}`, [id]);
      if (!row) throw new AppError(404, '薪资记录不存在');
      if (row.status !== 'DRAFT') {
        throw new AppError(400, '已确认/已发放的薪资记录不可修改');
      }

      const bonus = roundMoney(body.performance_bonus ?? Number(row.performance_bonus || 0));
      const otherAllowance = roundMoney(body.other_allowance ?? Number(row.other_allowance || 0));
      const advanceDeduction = roundMoney(body.advance_deduction ?? Number(row.advance_deduction || 0));
      const otherDeduction = roundMoney(body.other_deduction ?? Number(row.other_deduction || 0));
      const grossPay = Math.max(
        0,
        roundMoney(
          Number(row.base_salary) +
            Number(row.night_allowance) +
            Number(row.overtime_pay) +
            bonus +
            otherAllowance -
            Number(row.leave_deduction)
        )
      );
      const iit = await computeCumulativeIit(tx, {
        employeeId: row.employee_id,
        yearMonth: row.year_month,
        grossPay,
        socialSecurity: Number(row.social_security),
        specialDeduction: Number(row.special_deduction || 0),
      });
      const netPay = Math.max(
        0,
        roundMoney(grossPay - Number(row.social_security) - iit.incomeTax - advanceDeduction - otherDeduction)
      );

      const upd = await tx.execute(
        `UPDATE payroll_records
         SET performance_bonus = ?, other_allowance = ?, advance_deduction = ?, other_deduction = ?,
             taxable_income = ?, ytd_taxable_income = ?, ytd_tax_paid = ?, income_tax = ?,
             gross_pay = ?, net_pay = ?, notes = ?, updated_at = ?
         WHERE id = ? AND status = 'DRAFT'`,
        [
          bonus,
          otherAllowance,
          advanceDeduction,
          otherDeduction,
          iit.taxableIncome,
          iit.ytdTaxableIncome,
          iit.ytdTaxPaid,
          iit.incomeTax,
          grossPay,
          netPay,
          body.notes ?? null,
          nowIso(),
          id,
        ]
      );
      if (upd.affectedRows !== 1) throw new AppError(409, '薪资记录状态已变更，请刷新后重试');

      await logApprovalAction(tx, {
        bizType: 'PAYROLL',
        bizId: id,
        action: 'UPDATE_BONUS',
        actor: req.user!,
        comment: `绩效奖金调整：${row.performance_bonus} -> ${bonus}${body.notes ? `（备注：${body.notes}）` : ''}`,
      });

      return tx.queryOne('SELECT * FROM payroll_records WHERE id = ?', [id]);
    });

    res.json({ record: updated });
  })
);

router.post(
  '/confirm',
  requireRoles('HQ_ADMIN', 'HR_MANAGER', 'FINANCE'),
  asyncHandler(async (req, res) => {
    const body = z
      .object({
        yearMonth: z.string().regex(/^\d{4}-\d{2}$/),
        hotelId: z.number().int().positive().optional(),
      })
      .parse(req.body);

    const db = getDb();
    const ts = nowIso();
    const conditions = ['`year_month` = ?', `status = 'DRAFT'`];
    const params: unknown[] = [req.user!.id, ts, ts, body.yearMonth];
    if (body.hotelId) {
      conditions.push('hotel_id = ?');
      params.push(body.hotelId);
    }

    const confirmedCount = await db.transaction(async (tx) => {
      const result = await tx.execute(
        `UPDATE payroll_records
         SET status = 'CONFIRMED', confirmed_by = ?, confirmed_at = ?, updated_at = ?
         WHERE ${conditions.join(' AND ')}`,
        params
      );
      if (result.affectedRows > 0) {
        await logApprovalAction(tx, {
          bizType: 'PAYROLL',
          bizId: body.hotelId ?? 0,
          action: 'CONFIRM',
          actor: req.user!,
          comment: `确认锁账 ${body.yearMonth} 薪资共 ${result.affectedRows} 条${body.hotelId ? `（门店 ${body.hotelId}）` : ''}`,
        });
      }
      return result.affectedRows;
    });

    res.json({ ok: true, confirmedCount });
  })
);

router.post(
  '/mark-paid',
  requireRoles('HQ_ADMIN', 'FINANCE'),
  asyncHandler(async (req, res) => {
    const body = z
      .object({
        yearMonth: z.string().regex(/^\d{4}-\d{2}$/),
        hotelId: z.number().int().positive().optional(),
      })
      .parse(req.body);

    const db = getDb();
    const ts = nowIso();
    const conditions = ['`year_month` = ?', `status = 'CONFIRMED'`];
    const params: unknown[] = [ts, body.yearMonth];
    if (body.hotelId) {
      conditions.push('hotel_id = ?');
      params.push(body.hotelId);
    }

    const paidCount = await db.transaction(async (tx) => {
      const result = await tx.execute(
        `UPDATE payroll_records SET status = 'PAID', updated_at = ? WHERE ${conditions.join(' AND ')}`,
        params
      );
      if (result.affectedRows > 0) {
        await logApprovalAction(tx, {
          bizType: 'PAYROLL',
          bizId: body.hotelId ?? 0,
          action: 'PAY',
          actor: req.user!,
          comment: `标记发放 ${body.yearMonth} 薪资共 ${result.affectedRows} 条`,
        });
      }
      return result.affectedRows;
    });

    res.json({ ok: true, paidCount });
  })
);

router.get(
  '/export',
  requireRoles('HQ_ADMIN', 'HR_MANAGER', 'FINANCE', 'STORE_MANAGER', 'REGIONAL_MANAGER'),
  asyncHandler(async (req, res) => {
    const db = getDb();
    const yearMonth = String(req.query.yearMonth || currentYearMonth());
    const scope = await getScopeFilter(req.user!);
    const scopeSql = buildHotelScopeSql(scope, 'p.hotel_id');
    const conditions = ['p.`year_month` = ?', scopeSql.sql];
    const params: unknown[] = [yearMonth, ...scopeSql.params];

    const rows = await db.query<{
      year_month: string;
      hotel_name: string;
      emp_no: string;
      emp_name: string;
      position: string;
      base_salary: number;
      night_shifts: number;
      night_allowance: number;
      overtime_hours: number;
      overtime_pay: number;
      leave_deduction: number;
      performance_bonus: number;
      social_security: number;
      gross_pay: number;
      net_pay: number;
      status: string;
    }>(
      `SELECT p.*, e.emp_no, e.name AS emp_name, e.position, h.name AS hotel_name
       FROM payroll_records p
       JOIN employees e ON e.id = p.employee_id
       JOIN hotels h ON h.id = p.hotel_id
       WHERE ${conditions.join(' AND ')}
       ORDER BY p.hotel_id ASC, e.id ASC`,
      params
    );

    const csv = buildCsv(
      ['月份', '门店', '工号', '姓名', '岗位', '底薪', '夜班天数', '夜班津贴', '加班小时', '加班费', '请假扣款', '绩效奖金', '社保公积金', '应发工资', '实发工资', '状态'],
      rows.map((r) => [
        r.year_month,
        r.hotel_name,
        r.emp_no,
        r.emp_name,
        r.position,
        r.base_salary,
        r.night_shifts,
        r.night_allowance,
        r.overtime_hours,
        r.overtime_pay,
        r.leave_deduction,
        r.performance_bonus,
        r.social_security,
        r.gross_pay,
        r.net_pay,
        r.status,
      ])
    );

    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="payroll-${yearMonth}.csv"`);
    res.send(csv);
  })
);

router.get(
  '/ss-rules',
  asyncHandler(async (_req, res) => {
    const db = getDb();
    const rules = await db.query('SELECT * FROM city_social_security_rules ORDER BY city ASC');
    res.json({ rules });
  })
);

router.put(
  '/ss-rules',
  requireRoles('HQ_ADMIN', 'HR_MANAGER', 'FINANCE'),
  asyncHandler(async (req, res) => {
    const body = z
      .object({
        city: z.string().trim().min(1, '请填写城市名称'),
        effective_year: z.number().int().min(2020).max(2099).default(2026),
        ss_base_min: z.number().min(0),
        ss_base_max: z.number().positive(),
        pension_rate: z.number().min(0).max(0.5),
        medical_rate: z.number().min(0).max(0.5),
        unemployment_rate: z.number().min(0).max(0.5),
        housing_fund_rate: z.number().min(0).max(0.5),
      })
      .parse(req.body);

    if (body.ss_base_max < body.ss_base_min) {
      throw new AppError(400, '社保缴费基数上限不能小于下限');
    }

    const totalPersonalRate = roundMoney(
      (body.pension_rate + body.medical_rate + body.unemployment_rate + body.housing_fund_rate) * 100
    ) / 100;
    const db = getDb();
    const ts = nowIso();
    const existing = await db.queryOne<{ id: number }>(
      'SELECT id FROM city_social_security_rules WHERE city = ?',
      [body.city]
    );
    if (existing) {
      await db.execute(
        `UPDATE city_social_security_rules
         SET effective_year = ?, ss_base_min = ?, ss_base_max = ?,
             pension_rate = ?, medical_rate = ?, unemployment_rate = ?, housing_fund_rate = ?,
             total_personal_rate = ?, updated_by = ?, updated_at = ?
         WHERE id = ?`,
        [
          body.effective_year,
          body.ss_base_min,
          body.ss_base_max,
          body.pension_rate,
          body.medical_rate,
          body.unemployment_rate,
          body.housing_fund_rate,
          totalPersonalRate,
          req.user!.id,
          ts,
          existing.id,
        ]
      );
    } else {
      await db.execute(
        `INSERT INTO city_social_security_rules (
          city, effective_year, ss_base_min, ss_base_max, pension_rate, medical_rate,
          unemployment_rate, housing_fund_rate, total_personal_rate, updated_by, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          body.city,
          body.effective_year,
          body.ss_base_min,
          body.ss_base_max,
          body.pension_rate,
          body.medical_rate,
          body.unemployment_rate,
          body.housing_fund_rate,
          totalPersonalRate,
          req.user!.id,
          ts,
        ]
      );
    }

    const rule = await db.queryOne('SELECT * FROM city_social_security_rules WHERE city = ?', [body.city]);
    res.json({ rule });
  })
);

router.post(
  '/batches/submit',
  requireRoles('HQ_ADMIN', 'HR_MANAGER'),
  asyncHandler(async (req, res) => {
    const body = z
      .object({
        yearMonth: z.string().regex(/^\d{4}-\d{2}$/),
        hotelId: z.number().int().positive().optional(),
      })
      .parse(req.body);

    const db = getDb();
    const user = req.user!;
    const ts = nowIso();
    const batchNo = generateCode('PAY');

    const batch = await db.transaction(async (tx) => {
      const cond = ['`year_month` = ?', `status = 'DRAFT'`];
      const params: unknown[] = [body.yearMonth];
      if (body.hotelId) {
        cond.push('hotel_id = ?');
        params.push(body.hotelId);
      }

      const draftRows = await tx.query<{ id: number; gross_pay: number; net_pay: number }>(
        `SELECT id, gross_pay, net_pay FROM payroll_records WHERE ${cond.join(' AND ')}`,
        params
      );
      if (draftRows.length === 0) {
        throw new AppError(400, '当前没有待提交审批的草稿薪资记录');
      }

      const totalEmployees = draftRows.length;
      const totalGross = roundMoney(draftRows.reduce((s, r) => s + Number(r.gross_pay || 0), 0));
      const totalNet = roundMoney(draftRows.reduce((s, r) => s + Number(r.net_pay || 0), 0));

      const ins = await tx.execute(
        `INSERT INTO payroll_batches (
          batch_no, \`year_month\`, hotel_id, total_employees, total_gross, total_net,
          status, current_step, submitted_by, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, 'PENDING_APPROVAL', 1, ?, ?, ?)`,
        [batchNo, body.yearMonth, body.hotelId ?? null, totalEmployees, totalGross, totalNet, user.id, ts, ts]
      );

      await tx.execute(
        `UPDATE payroll_records SET batch_id = ?, updated_at = ? WHERE ${cond.join(' AND ')}`,
        [ins.insertId, ts, ...params]
      );

      const resolved = await resolveApprovalRoute(
        tx,
        body.hotelId ?? 1,
        [
          { stepOrder: 1, stepName: '集团财务审批', approverRole: 'FINANCE' },
          { stepOrder: 2, stepName: '集团总经理审批', approverRole: 'GENERAL_MANAGER' },
        ],
        user.id
      );
      await replaceApprovalSteps(tx, 'PAYROLL_BATCH', ins.insertId, resolved.steps);
      await logApprovalAction(tx, {
        bizType: 'PAYROLL_BATCH',
        bizId: ins.insertId,
        action: 'SUBMIT',
        actor: user,
        comment: `提交 ${body.yearMonth} 薪资批次审批（${totalEmployees}人，实发 ¥${totalNet.toFixed(2)}）`,
      });

      return tx.queryOne('SELECT * FROM payroll_batches WHERE id = ?', [ins.insertId]);
    });

    res.status(201).json({ batch });
  })
);

router.get(
  '/batches',
  asyncHandler(async (req, res) => {
    const db = getDb();
    const user = req.user!;
    const scope = await getScopeFilter(user);
    if (scope.type === 'SELF') {
      res.json({ batches: [] });
      return;
    }

    const cond = ['1=1'];
    const params: unknown[] = [];
    if (req.query.yearMonth) {
      cond.push('b.`year_month` = ?');
      params.push(String(req.query.yearMonth));
    }
    if (scope.type === 'HOTEL') {
      cond.push('(b.hotel_id = ? OR b.hotel_id IS NULL)');
      params.push(scope.hotelId);
    } else if (scope.type === 'REGION' && scope.hotelIds.length > 0) {
      cond.push(`(b.hotel_id IN (${scope.hotelIds.map(() => '?').join(',')}) OR b.hotel_id IS NULL)`);
      params.push(...scope.hotelIds);
    }

    const rows = await db.query<{
      id: number;
      batch_no: string;
      year_month: string;
      hotel_id: number | null;
      total_employees: number;
      total_gross: number;
      total_net: number;
      status: string;
      current_step: number;
      submitted_by: number;
      paid_by: number | null;
      payment_ref: string | null;
      paid_at: string | null;
      submitted_by_name: string;
    }>(
      `SELECT b.*, u.display_name AS submitted_by_name
       FROM payroll_batches b
       JOIN users u ON u.id = b.submitted_by
       WHERE ${cond.join(' AND ')}
       ORDER BY b.id DESC`,
      params
    );

    const batches = [];
    for (const row of rows) {
      const steps = await getWorkflowStepsWithActors(db, 'PAYROLL_BATCH', row.id);
      const pendingStep =
        row.status === 'PENDING_APPROVAL'
          ? await db.queryOne<{ step_name: string; approver_role: UserRole; approver_user_id: number | null }>(
              `SELECT step_name, approver_role, approver_user_id FROM approval_steps
               WHERE biz_type = 'PAYROLL_BATCH' AND biz_id = ? AND status = 'PENDING'
               ORDER BY step_order ASC LIMIT 1`,
              [row.id]
            )
          : null;
      const canApprove = pendingStep
        ? await canUserActOnStep(db, user, pendingStep.approver_role, row.hotel_id ?? 1, row.submitted_by, {
            approverUserId: pendingStep.approver_user_id,
            bizType: 'PAYROLL_BATCH',
          })
        : false;

      batches.push({
        ...row,
        steps,
        canApprove,
        status_detail: buildStatusDetail({
          bizType: 'PAYROLL_BATCH',
          status: row.status,
          currentStepName: pendingStep?.step_name ?? null,
          currentStep: row.current_step,
          totalSteps: steps.length,
          paymentRef: row.payment_ref,
        }),
      });
    }

    res.json({ batches });
  })
);

router.post(
  '/batches/:id/action',
  asyncHandler(async (req, res) => {
    const id = Number(req.params.id);
    const { action, comment } = z
      .object({
        action: z.enum(['APPROVE', 'REJECT']),
        comment: z.string().optional().default(''),
      })
      .parse(req.body);

    const db = getDb();
    const ts = nowIso();
    await db.transaction(async (tx) => {
      const batch = await tx.queryOne<{
        id: number;
        hotel_id: number | null;
        submitted_by: number;
        status: string;
      }>(`SELECT id, hotel_id, submitted_by, status FROM payroll_batches WHERE id = ?${tx.forUpdateSuffix()}`, [id]);
      if (!batch) throw new AppError(404, '薪资批次不存在');
      if (batch.status !== 'PENDING_APPROVAL') throw new AppError(400, '当前批次状态不可审批');

      const step = await tx.queryOne<{ id: number; step_order: number; approver_role: UserRole; approver_user_id: number | null }>(
        `SELECT id, step_order, approver_role, approver_user_id FROM approval_steps
         WHERE biz_type = 'PAYROLL_BATCH' AND biz_id = ? AND status = 'PENDING'
         ORDER BY step_order ASC LIMIT 1`,
        [id]
      );
      if (!step) throw new AppError(400, '未找到待审批节点');
      if (
        !(await canUserActOnStep(tx, req.user!, step.approver_role, batch.hotel_id ?? 1, batch.submitted_by, {
          approverUserId: step.approver_user_id,
          bizType: 'PAYROLL_BATCH',
        }))
      ) {
        throw new AppError(403, '您无权审批当前薪资批次节点');
      }

      if (action === 'REJECT') {
        await tx.execute(
          `UPDATE approval_steps SET status = 'REJECTED', acted_by = ?, acted_at = ?, comment = ? WHERE id = ?`,
          [req.user!.id, ts, comment || '驳回', step.id]
        );
        await tx.execute(`UPDATE payroll_batches SET status = 'REJECTED', updated_at = ? WHERE id = ?`, [ts, id]);
        await tx.execute(`UPDATE payroll_records SET batch_id = NULL, updated_at = ? WHERE batch_id = ? AND status = 'DRAFT'`, [
          ts,
          id,
        ]);
      } else {
        await tx.execute(
          `UPDATE approval_steps SET status = 'APPROVED', acted_by = ?, acted_at = ?, comment = ? WHERE id = ?`,
          [req.user!.id, ts, comment || '同意', step.id]
        );
        const nextStep = await tx.queryOne<{ id: number; step_order: number }>(
          `SELECT id, step_order FROM approval_steps
           WHERE biz_type = 'PAYROLL_BATCH' AND biz_id = ? AND step_order > ?
           ORDER BY step_order ASC LIMIT 1`,
          [id, step.step_order]
        );
        if (nextStep) {
          await tx.execute(`UPDATE approval_steps SET status = 'PENDING' WHERE id = ?`, [nextStep.id]);
          await tx.execute(`UPDATE payroll_batches SET current_step = ?, updated_at = ? WHERE id = ?`, [
            nextStep.step_order,
            ts,
            id,
          ]);
        } else {
          await tx.execute(`UPDATE payroll_batches SET status = 'APPROVED', updated_at = ? WHERE id = ?`, [ts, id]);
          await tx.execute(
            `UPDATE payroll_records
             SET status = 'CONFIRMED', confirmed_by = ?, confirmed_at = ?, updated_at = ?
             WHERE batch_id = ? AND status = 'DRAFT'`,
            [req.user!.id, ts, ts, id]
          );
        }
      }

      await logApprovalAction(tx, {
        bizType: 'PAYROLL_BATCH',
        bizId: id,
        action,
        actor: req.user!,
        comment,
      });
    });

    res.json({ ok: true });
  })
);

router.post(
  '/batches/:id/pay',
  requireRoles('HQ_ADMIN', 'FINANCE'),
  asyncHandler(async (req, res) => {
    const id = Number(req.params.id);
    const { payment_ref } = z
      .object({
        payment_ref: z.string().min(2, '请填写银行代发流水号'),
      })
      .parse(req.body);

    const db = getDb();
    const ts = nowIso();
    await db.transaction(async (tx) => {
      const batch = await tx.queryOne<{ id: number; status: string; submitted_by: number }>(
        `SELECT id, status, submitted_by FROM payroll_batches WHERE id = ?${tx.forUpdateSuffix()}`,
        [id]
      );
      if (!batch) throw new AppError(404, '薪资批次不存在');
      assertSegregation(req.user!.id, batch.submitted_by, '禁止薪资制单人与发放人为同一人');
      if (batch.status !== 'APPROVED') throw new AppError(400, '仅审批通过的薪资批次可执行发放');

      const upd = await tx.execute(
        `UPDATE payroll_batches SET status = 'PAID', paid_by = ?, payment_ref = ?, paid_at = ?, updated_at = ?
         WHERE id = ? AND status = 'APPROVED'`,
        [req.user!.id, payment_ref, ts, ts, id]
      );
      if (upd.affectedRows !== 1) throw new AppError(409, '薪资批次状态已变更，请刷新后重试');

      await tx.execute(
        `UPDATE payroll_records SET status = 'PAID', updated_at = ? WHERE batch_id = ? AND status = 'CONFIRMED'`,
        [ts, id]
      );

      await logApprovalAction(tx, {
        bizType: 'PAYROLL_BATCH',
        bizId: id,
        action: 'PAY',
        actor: req.user!,
        comment: `完成薪资批次发放，银行代发流水号：${payment_ref}`,
      });
    });

    res.json({ ok: true });
  })
);

router.get(
  '/batches/:id/bank-export',
  requireRoles('HQ_ADMIN', 'HR_MANAGER', 'FINANCE'),
  asyncHandler(async (req, res) => {
    const id = Number(req.params.id);
    const db = getDb();
    const batch = await db.queryOne<{ id: number; batch_no: string; year_month: string }>(
      'SELECT id, batch_no, `year_month` FROM payroll_batches WHERE id = ?',
      [id]
    );
    if (!batch) throw new AppError(404, '薪资批次不存在');

    const rows = await db.query<{
      emp_no: string;
      emp_name: string;
      hotel_name: string;
      bank_name: string | null;
      bank_account: string | null;
      net_pay: number;
    }>(
      `SELECT e.emp_no, e.name AS emp_name, h.name AS hotel_name, e.bank_name, e.bank_account, p.net_pay
       FROM payroll_records p
       JOIN employees e ON e.id = p.employee_id
       JOIN hotels h ON h.id = p.hotel_id
       WHERE p.batch_id = ?
       ORDER BY p.hotel_id ASC, e.id ASC`,
      [id]
    );

    const csv = buildCsv(
      ['工号', '姓名', '门店', '开户行', '银行账号', '实发金额', '摘要'],
      rows.map((r) => [
        r.emp_no,
        r.emp_name,
        r.hotel_name,
        r.bank_name || '',
        r.bank_account || '',
        r.net_pay,
        `${batch.year_month}月度工资(${batch.batch_no})`,
      ])
    );

    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="bank-payout-${batch.batch_no}.csv"`);
    res.send(csv);
  })
);

router.get(
  '/my-payslips',
  asyncHandler(async (req, res) => {
    const user = req.user!;
    if (!user.employee_id) {
      res.json({ payslips: [] });
      return;
    }
    const db = getDb();
    const ts = nowIso();
    await db.execute(
      `UPDATE payroll_records
       SET payslip_viewed_at = ?
       WHERE employee_id = ? AND status IN ('CONFIRMED', 'PAID') AND payslip_viewed_at IS NULL`,
      [ts, user.employee_id]
    );
    const payslips = await db.query(
      `SELECT p.*, e.emp_no, e.name AS emp_name, e.position, h.name AS hotel_name
       FROM payroll_records p
       JOIN employees e ON e.id = p.employee_id
       JOIN hotels h ON h.id = p.hotel_id
       WHERE p.employee_id = ? AND p.status IN ('CONFIRMED', 'PAID')
       ORDER BY p.\`year_month\` DESC`,
      [user.employee_id]
    );
    res.json({ payslips });
  })
);

export default router;
