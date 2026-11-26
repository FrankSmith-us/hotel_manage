import { DbQueryRunner } from '../../db/adapter';
import { nowIso, roundMoney } from '../utils/numbers';

export async function calculateMonthlyPayroll(
  db: DbQueryRunner,
  params: {
    yearMonth: string;
    hotelId?: number;
  }
): Promise<{ processedCount: number; skippedConfirmedCount: number }> {
  const empConditions = [`status IN ('ACTIVE', 'PROBATION')`];
  const empParams: unknown[] = [];
  if (params.hotelId) {
    empConditions.push('hotel_id = ?');
    empParams.push(params.hotelId);
  }

  const employees = await db.query<{
    id: number;
    hotel_id: number;
    base_salary: number;
    night_allowance_rate: number;
  }>(
    `SELECT id, hotel_id, base_salary, night_allowance_rate
     FROM employees
     WHERE ${empConditions.join(' AND ')}`,
    empParams
  );

  const monthStart = `${params.yearMonth}-01`;
  const monthEnd = `${params.yearMonth}-31`;
  const ts = nowIso();
  let processedCount = 0;
  let skippedConfirmedCount = 0;

  for (const emp of employees) {
    const existing = await db.queryOne<{
      id: number;
      status: string;
      performance_bonus: number;
      notes: string | null;
    }>(
      'SELECT id, status, performance_bonus, notes FROM payroll_records WHERE `year_month` = ? AND employee_id = ?',
      [params.yearMonth, emp.id]
    );

    if (existing && (existing.status === 'CONFIRMED' || existing.status === 'PAID')) {
      skippedConfirmedCount++;
      continue;
    }

    // Count night shifts in this month
    const nightRow = await db.queryOne<{ cnt: number }>(
      `SELECT COUNT(*) AS cnt
       FROM shift_schedules
       WHERE employee_id = ? AND shift_type = 'NIGHT' AND shift_date >= ? AND shift_date <= ?`,
      [emp.id, monthStart, monthEnd]
    );
    const nightShifts = Number(nightRow?.cnt || 0);

    // Approved leave & overtime in this month
    const leaves = await db.query<{ leave_type: string; days: number; hours: number }>(
      `SELECT leave_type, days, hours
       FROM leave_requests
       WHERE employee_id = ? AND status = 'APPROVED' AND start_date <= ? AND end_date >= ?`,
      [emp.id, monthEnd, monthStart]
    );

    let overtimeHours = 0;
    let personalDays = 0;
    let sickDays = 0;

    for (const l of leaves) {
      if (l.leave_type === 'OVERTIME') {
        overtimeHours += Number(l.hours || 0);
      } else if (l.leave_type === 'PERSONAL') {
        personalDays += Number(l.days || 0);
      } else if (l.leave_type === 'SICK') {
        sickDays += Number(l.days || 0);
      }
    }

    const baseSalary = roundMoney(Number(emp.base_salary));
    const nightAllowance = roundMoney(nightShifts * Number(emp.night_allowance_rate || 80));
    const hourlyRate = baseSalary / 21.75 / 8;
    const overtimePay = roundMoney(hourlyRate * 1.5 * overtimeHours);
    const leaveDeductionDays = roundMoney(personalDays + sickDays * 0.4);
    const leaveDeduction = roundMoney((baseSalary / 21.75) * leaveDeductionDays);
    const performanceBonus = existing ? roundMoney(Number(existing.performance_bonus || 0)) : 0;
    const socialSecurity = roundMoney(baseSalary * 0.105);
    const grossPay = roundMoney(baseSalary + nightAllowance + overtimePay + performanceBonus - leaveDeduction);
    const netPay = roundMoney(Math.max(0, grossPay - socialSecurity));

    if (existing) {
      await db.execute(
        `UPDATE payroll_records
         SET hotel_id = ?, base_salary = ?, night_shifts = ?, night_allowance = ?,
             overtime_hours = ?, overtime_pay = ?, leave_deduction_days = ?, leave_deduction = ?,
             social_security = ?, gross_pay = ?, net_pay = ?, updated_at = ?
         WHERE id = ?`,
        [
          emp.hotel_id,
          baseSalary,
          nightShifts,
          nightAllowance,
          overtimeHours,
          overtimePay,
          leaveDeductionDays,
          leaveDeduction,
          socialSecurity,
          grossPay,
          netPay,
          ts,
          existing.id,
        ]
      );
    } else {
      await db.execute(
        `INSERT INTO payroll_records (
          \`year_month\`, employee_id, hotel_id, base_salary, night_shifts, night_allowance,
          overtime_hours, overtime_pay, leave_deduction_days, leave_deduction, performance_bonus,
          social_security, gross_pay, net_pay, status, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'DRAFT', ?, ?)`,
        [
          params.yearMonth,
          emp.id,
          emp.hotel_id,
          baseSalary,
          nightShifts,
          nightAllowance,
          overtimeHours,
          overtimePay,
          leaveDeductionDays,
          leaveDeduction,
          performanceBonus,
          socialSecurity,
          grossPay,
          netPay,
          ts,
          ts,
        ]
      );
    }
    processedCount++;
  }

  return { processedCount, skippedConfirmedCount };
}
