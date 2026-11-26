import { DbQueryRunner } from '../../db/adapter';
import { BUSINESS_RULES } from '../config/businessRules';
import { nowIso, roundMoney } from '../utils/numbers';

export async function computeCumulativeIit(
  db: DbQueryRunner,
  params: {
    employeeId: number;
    yearMonth: string;
    grossPay: number;
    socialSecurity: number;
    specialDeduction: number;
  }
): Promise<{
  taxableIncome: number;
  ytdTaxableIncome: number;
  ytdTaxPaid: number;
  incomeTax: number;
}> {
  const year = params.yearMonth.slice(0, 4);
  const yearStartYm = `${year}-01`;

  const prevRow = await db.queryOne<{
    prev_gross: number;
    prev_ss: number;
    prev_spec: number;
    prev_tax: number;
    prev_cnt: number;
  }>(
    `SELECT COALESCE(SUM(gross_pay), 0) AS prev_gross,
            COALESCE(SUM(social_security), 0) AS prev_ss,
            COALESCE(SUM(special_deduction), 0) AS prev_spec,
            COALESCE(SUM(income_tax), 0) AS prev_tax,
            COUNT(*) AS prev_cnt
     FROM payroll_records
     WHERE employee_id = ? AND \`year_month\` >= ? AND \`year_month\` < ?`,
    [params.employeeId, yearStartYm, params.yearMonth]
  );

  const prevCnt = Number(prevRow?.prev_cnt || 0);
  const curTaxable = Math.max(
    0,
    roundMoney(
      params.grossPay -
        params.socialSecurity -
        params.specialDeduction -
        BUSINESS_RULES.payroll.taxThresholdMonthly
    )
  );
  const ytdGross = roundMoney(Number(prevRow?.prev_gross || 0) + params.grossPay);
  const ytdSs = roundMoney(Number(prevRow?.prev_ss || 0) + params.socialSecurity);
  const ytdSpec = roundMoney(Number(prevRow?.prev_spec || 0) + params.specialDeduction);
  const ytdThreshold = roundMoney((prevCnt + 1) * BUSINESS_RULES.payroll.taxThresholdMonthly);
  const ytdTaxableIncome = Math.max(0, roundMoney(ytdGross - ytdSs - ytdSpec - ytdThreshold));
  const ytdTaxPaid = roundMoney(Number(prevRow?.prev_tax || 0));

  let cumulativeTax = 0;
  for (const bracket of BUSINESS_RULES.payroll.taxBrackets2026) {
    if (ytdTaxableIncome <= bracket.upTo) {
      cumulativeTax = Math.max(
        0,
        roundMoney(ytdTaxableIncome * bracket.rate - bracket.quickDeduction)
      );
      break;
    }
  }
  const incomeTax = Math.max(0, roundMoney(cumulativeTax - ytdTaxPaid));

  return {
    taxableIncome: curTaxable,
    ytdTaxableIncome,
    ytdTaxPaid,
    incomeTax,
  };
}

export async function calculateMonthlyPayroll(
  db: DbQueryRunner,
  params: {
    yearMonth: string;
    hotelId?: number;
  }
): Promise<{ processedCount: number; skippedConfirmedCount: number }> {
  const [ymYear, ymMonth] = params.yearMonth.split('-').map(Number);
  const lastDay = new Date(Date.UTC(ymYear, ymMonth, 0)).getUTCDate();
  const monthStart = `${params.yearMonth}-01`;
  const monthEnd = `${params.yearMonth}-${String(lastDay).padStart(2, '0')}`;
  const monthStartMs = Date.parse(`${monthStart}T00:00:00Z`);
  const monthEndMs = Date.parse(`${monthEnd}T00:00:00Z`);

  const hotelFilterSql = params.hotelId ? 'AND e.hotel_id = ?' : '';
  const empParams: unknown[] = [monthEnd, monthStart, monthEnd, monthStart, monthEnd];
  if (params.hotelId) empParams.push(params.hotelId);

  const employees = await db.query<{
    id: number;
    hotel_id: number;
    hotel_city: string;
    status: string;
    hire_date: string;
    resign_date: string | null;
    base_salary: number;
    probation_salary_ratio: number | null;
    special_additional_deduction: number | null;
    night_allowance_rate: number;
    ev_resign_date: string | null;
  }>(
    `SELECT e.id, e.hotel_id, h.city AS hotel_city, e.status, e.hire_date, e.resign_date, e.base_salary,
            e.probation_salary_ratio, e.special_additional_deduction, e.night_allowance_rate,
            (SELECT MAX(ev.effective_date)
             FROM employee_lifecycle_events ev
             WHERE ev.employee_id = e.id AND ev.event_type = 'RESIGN'
               AND ev.effective_date >= ? AND ev.effective_date <= ?) AS ev_resign_date
     FROM employees e
     JOIN hotels h ON h.id = e.hotel_id
     WHERE e.hire_date <= ?
       AND (
         e.status IN ('ACTIVE', 'PROBATION')
         OR (
           e.status = 'RESIGNED'
           AND (
             (e.resign_date IS NOT NULL AND e.resign_date >= ? AND e.resign_date <= ?)
             OR EXISTS (
               SELECT 1 FROM employee_lifecycle_events ev2
               WHERE ev2.employee_id = e.id AND ev2.event_type = 'RESIGN'
                 AND ev2.effective_date >= ? AND ev2.effective_date <= ?
             )
           )
         )
       )
       ${hotelFilterSql}`,
    [monthStart, monthEnd, ...empParams]
  );

  const ssRulesRows = await db.query<{
    city: string;
    ss_base_min: number;
    ss_base_max: number;
    total_personal_rate: number;
  }>('SELECT city, ss_base_min, ss_base_max, total_personal_rate FROM city_social_security_rules');
  const ssRuleMap = new Map(ssRulesRows.map((r) => [r.city, r]));

  const ts = nowIso();
  let processedCount = 0;
  let skippedConfirmedCount = 0;

  for (const emp of employees) {
    const existing = await db.queryOne<{
      id: number;
      status: string;
      performance_bonus: number;
      other_allowance: number;
      advance_deduction: number;
      other_deduction: number;
      notes: string | null;
    }>(
      `SELECT id, status, performance_bonus, other_allowance, advance_deduction, other_deduction, notes
       FROM payroll_records WHERE \`year_month\` = ? AND employee_id = ?`,
      [params.yearMonth, emp.id]
    );

    if (existing && (existing.status === 'CONFIRMED' || existing.status === 'PAID')) {
      skippedConfirmedCount++;
      continue;
    }

    const effectiveResignDate = emp.status === 'RESIGNED' ? emp.resign_date || emp.ev_resign_date : null;
    const isResignedSettlement = emp.status === 'RESIGNED' ? 1 : 0;
    const effStart = emp.hire_date > monthStart ? emp.hire_date : monthStart;
    const effEnd = effectiveResignDate && effectiveResignDate < monthEnd ? effectiveResignDate : monthEnd;
    const effStartMs = Date.parse(`${effStart}T00:00:00Z`);
    const effEndMs = Date.parse(`${effEnd}T00:00:00Z`);
    const proratedDays = effEndMs >= effStartMs ? Math.round((effEndMs - effStartMs) / 86_400_000) + 1 : 0;

    // Count night shifts in this month
    const nightRow = await db.queryOne<{ cnt: number }>(
      `SELECT COUNT(*) AS cnt
       FROM shift_schedules
       WHERE employee_id = ? AND shift_type = 'NIGHT' AND shift_date >= ? AND shift_date <= ?`,
      [emp.id, monthStart, monthEnd]
    );
    const nightShifts = Number(nightRow?.cnt || 0);

    // Approved leave & overtime in this month (prorate cross-month leave days by overlap)
    const leaves = await db.query<{
      leave_type: string;
      start_date: string;
      end_date: string;
      days: number;
      hours: number;
    }>(
      `SELECT leave_type, start_date, end_date, days, hours
       FROM leave_requests
       WHERE employee_id = ? AND status = 'APPROVED' AND start_date <= ? AND end_date >= ?`,
      [emp.id, monthEnd, monthStart]
    );

    let overtimeHours = 0;
    let personalDays = 0;
    let sickDays = 0;

    for (const l of leaves) {
      if (l.leave_type === 'OVERTIME') {
        if (l.start_date >= monthStart && l.start_date <= monthEnd) {
          overtimeHours += Number(l.hours || 0);
        }
        continue;
      }
      const lStartMs = Date.parse(`${l.start_date}T00:00:00Z`);
      const lEndMs = Date.parse(`${l.end_date}T00:00:00Z`);
      const totalCalDays = Math.max(1, Math.round((lEndMs - lStartMs) / 86_400_000) + 1);
      const ovStart = Math.max(lStartMs, monthStartMs);
      const ovEnd = Math.min(lEndMs, monthEndMs);
      const overlapCalDays = ovEnd >= ovStart ? Math.round((ovEnd - ovStart) / 86_400_000) + 1 : 0;
      const proratedLeaveDays = roundMoney((Number(l.days || 0) * overlapCalDays) / totalCalDays);

      if (l.leave_type === 'PERSONAL') {
        personalDays += proratedLeaveDays;
      } else if (l.leave_type === 'SICK') {
        sickDays += proratedLeaveDays;
      }
    }

    const fullBase = roundMoney(Number(emp.base_salary));
    const probationRatio =
      emp.status === 'PROBATION'
        ? Number(emp.probation_salary_ratio ?? BUSINESS_RULES.payroll.probationSalaryRatio)
        : 1.0;
    const baseAfterProbation = roundMoney(fullBase * probationRatio);
    const baseSalary =
      proratedDays >= lastDay ? baseAfterProbation : roundMoney((baseAfterProbation * proratedDays) / lastDay);

    const nightAllowance = roundMoney(nightShifts * Number(emp.night_allowance_rate || 80));
    const hourlyRate = baseAfterProbation / BUSINESS_RULES.payroll.workingDaysPerMonth / 8;
    const overtimePay = roundMoney(hourlyRate * BUSINESS_RULES.overtime.workdayRate * overtimeHours);
    const leaveDeductionDays = roundMoney(
      personalDays * BUSINESS_RULES.payroll.personalLeaveDeductionRate +
        sickDays * BUSINESS_RULES.payroll.sickLeaveDeductionRate
    );
    const leaveDeduction = roundMoney((baseAfterProbation / BUSINESS_RULES.payroll.workingDaysPerMonth) * leaveDeductionDays);
    const performanceBonus = existing ? roundMoney(Number(existing.performance_bonus || 0)) : 0;
    const otherAllowance = existing ? roundMoney(Number(existing.other_allowance || 0)) : 0;
    const advanceDeduction = existing ? roundMoney(Number(existing.advance_deduction || 0)) : 0;
    const otherDeduction = existing ? roundMoney(Number(existing.other_deduction || 0)) : 0;
    const specialDeduction = roundMoney(Number(emp.special_additional_deduction || 0));

    const ssRule =
      ssRuleMap.get(emp.hotel_city) ??
      ssRuleMap.get((emp.hotel_city || '').replace(/市$/, ''));
    let citySsBase = baseSalary;
    let socialSecurity = roundMoney(baseSalary * BUSINESS_RULES.payroll.defaultSocialSecurityRate);
    if (ssRule) {
      citySsBase = roundMoney(
        Math.min(Math.max(baseAfterProbation, Number(ssRule.ss_base_min)), Number(ssRule.ss_base_max))
      );
      socialSecurity = roundMoney(citySsBase * Number(ssRule.total_personal_rate));
    }

    const grossPay = Math.max(
      0,
      roundMoney(baseSalary + nightAllowance + overtimePay + performanceBonus + otherAllowance - leaveDeduction)
    );

    const iit = await computeCumulativeIit(db, {
      employeeId: emp.id,
      yearMonth: params.yearMonth,
      grossPay,
      socialSecurity,
      specialDeduction,
    });

    const netPay = Math.max(
      0,
      roundMoney(grossPay - socialSecurity - iit.incomeTax - advanceDeduction - otherDeduction)
    );

    if (existing) {
      await db.execute(
        `UPDATE payroll_records
         SET hotel_id = ?, base_salary = ?, prorated_days = ?, total_month_days = ?,
             night_shifts = ?, night_allowance = ?, overtime_hours = ?, overtime_pay = ?,
             leave_deduction_days = ?, leave_deduction = ?, city_ss_base = ?, social_security = ?,
             special_deduction = ?, taxable_income = ?, ytd_taxable_income = ?, ytd_tax_paid = ?, income_tax = ?,
             gross_pay = ?, net_pay = ?, is_resigned_settlement = ?, updated_at = ?
         WHERE id = ?`,
        [
          emp.hotel_id,
          baseSalary,
          proratedDays,
          lastDay,
          nightShifts,
          nightAllowance,
          overtimeHours,
          overtimePay,
          leaveDeductionDays,
          leaveDeduction,
          citySsBase,
          socialSecurity,
          specialDeduction,
          iit.taxableIncome,
          iit.ytdTaxableIncome,
          iit.ytdTaxPaid,
          iit.incomeTax,
          grossPay,
          netPay,
          isResignedSettlement,
          ts,
          existing.id,
        ]
      );
    } else {
      await db.execute(
        `INSERT INTO payroll_records (
          \`year_month\`, employee_id, hotel_id, base_salary, prorated_days, total_month_days,
          night_shifts, night_allowance, overtime_hours, overtime_pay,
          leave_deduction_days, leave_deduction, performance_bonus, other_allowance,
          city_ss_base, social_security, special_deduction, taxable_income, ytd_taxable_income, ytd_tax_paid, income_tax,
          advance_deduction, other_deduction, gross_pay, net_pay,
          is_resigned_settlement, status, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'DRAFT', ?, ?)`,
        [
          params.yearMonth,
          emp.id,
          emp.hotel_id,
          baseSalary,
          proratedDays,
          lastDay,
          nightShifts,
          nightAllowance,
          overtimeHours,
          overtimePay,
          leaveDeductionDays,
          leaveDeduction,
          performanceBonus,
          otherAllowance,
          citySsBase,
          socialSecurity,
          specialDeduction,
          iit.taxableIncome,
          iit.ytdTaxableIncome,
          iit.ytdTaxPaid,
          iit.incomeTax,
          advanceDeduction,
          otherDeduction,
          grossPay,
          netPay,
          isResignedSettlement,
          ts,
          ts,
        ]
      );
    }
    processedCount++;
  }

  return { processedCount, skippedConfirmedCount };
}
