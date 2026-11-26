import { Router } from 'express';
import { z } from 'zod';
import { getDb } from '../../db';
import {
  AppError,
  asyncHandler,
  authenticate,
  getScopeFilter,
  requireRoles,
} from '../middleware/auth';
import { calculateMonthlyPayroll } from '../services/payrollService';
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
        performance_bonus: z.number().min(0),
        notes: z.string().optional().nullable(),
      })
      .parse(req.body);

    const db = getDb();
    const row = await db.queryOne<{
      id: number;
      status: string;
      base_salary: number;
      night_allowance: number;
      overtime_pay: number;
      leave_deduction: number;
      social_security: number;
    }>('SELECT * FROM payroll_records WHERE id = ?', [id]);
    if (!row) throw new AppError(404, '薪资记录不存在');
    if (row.status !== 'DRAFT') {
      throw new AppError(400, '已确认/已发放的薪资记录不可修改');
    }

    const bonus = roundMoney(body.performance_bonus);
    const grossPay = roundMoney(
      Number(row.base_salary) +
        Number(row.night_allowance) +
        Number(row.overtime_pay) +
        bonus -
        Number(row.leave_deduction)
    );
    const netPay = roundMoney(Math.max(0, grossPay - Number(row.social_security)));

    await db.execute(
      `UPDATE payroll_records
       SET performance_bonus = ?, gross_pay = ?, net_pay = ?, notes = ?, updated_at = ?
       WHERE id = ?`,
      [bonus, grossPay, netPay, body.notes ?? null, nowIso(), id]
    );

    const updated = await db.queryOne('SELECT * FROM payroll_records WHERE id = ?', [id]);
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
    const params: unknown[] = [ts, req.user!.id, ts, body.yearMonth];
    if (body.hotelId) {
      conditions.push('hotel_id = ?');
      params.push(body.hotelId);
    }

    const result = await db.execute(
      `UPDATE payroll_records
       SET status = 'CONFIRMED', confirmed_by = ?, confirmed_at = ?, updated_at = ?
       WHERE ${conditions.slice(0).join(' AND ')}`.replace(
        'SET status = \'CONFIRMED\', confirmed_by = ?, confirmed_at = ?, updated_at = ?',
        'SET status = \'CONFIRMED\', confirmed_by = ?, confirmed_at = ?, updated_at = ?'
      ),
      [req.user!.id, ts, ts, body.yearMonth, ...(body.hotelId ? [body.hotelId] : [])]
    );

    res.json({ ok: true, confirmedCount: result.affectedRows });
  })
);

router.get(
  '/export',
  requireRoles('HQ_ADMIN', 'HR_MANAGER', 'FINANCE', 'STORE_MANAGER', 'REGIONAL_MANAGER'),
  asyncHandler(async (req, res) => {
    const db = getDb();
    const yearMonth = String(req.query.yearMonth || currentYearMonth());
    const scope = await getScopeFilter(req.user!);
    const conditions = ['p.`year_month` = ?'];
    const params: unknown[] = [yearMonth];

    if (scope.type === 'REGION' && scope.hotelIds.length > 0) {
      conditions.push(`p.hotel_id IN (${scope.hotelIds.map(() => '?').join(',')})`);
      params.push(...scope.hotelIds);
    } else if (scope.type === 'HOTEL') {
      conditions.push('p.hotel_id = ?');
      params.push(scope.hotelId);
    }

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

export default router;
