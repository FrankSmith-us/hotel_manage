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
import { logApprovalAction } from '../services/auditService';
import { calculateMonthlyPayroll, computeCumulativeIit } from '../services/payrollService';
import { buildCsv } from '../utils/csv';
import { currentYearMonth, nowIso, roundMoney } from '../utils/numbers';

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

export default router;
