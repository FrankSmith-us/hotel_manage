import { AppError } from '../middleware/auth';

export const BUSINESS_RULES = {
  // D-14: Unified Beijing timezone (UTC+8)
  timezoneOffsetMinutes: 8 * 60,

  // D-01, D-02, D-03, D-04: Reimbursement & approval thresholds
  reimbursement: {
    staffRegionThreshold: 1000,
    maxAgeDays: 90,
    receiptRequiredAbove: 200,
    allowCorporate: true,
    requireSameNameForPersonal: true,
  },

  // D-12: Cash advance limits & overdue guard
  advance: {
    maxUnsettledPerPerson: 20_000,
    blockWhenOverdue: true,
  },

  // D-13: Petty cash fund default quota
  pettyCash: {
    defaultQuota: 5_000,
  },

  // D-05, D-06, D-07, D-08: Payroll & 2026 IIT cumulative withholding brackets
  payroll: {
    workingDaysPerMonth: 21.75,
    probationSalaryRatio: 1.0,
    personalLeaveDeductionRate: 1.0,
    sickLeaveDeductionRate: 0.4,
    defaultSocialSecurityRate: 0.105,
    taxThresholdMonthly: 5_000,
    taxBrackets2026: [
      { upTo: 36_000, rate: 0.03, quickDeduction: 0 },
      { upTo: 144_000, rate: 0.1, quickDeduction: 2_520 },
      { upTo: 300_000, rate: 0.2, quickDeduction: 16_920 },
      { upTo: 420_000, rate: 0.25, quickDeduction: 31_920 },
      { upTo: 660_000, rate: 0.3, quickDeduction: 52_920 },
      { upTo: 960_000, rate: 0.35, quickDeduction: 85_920 },
      { upTo: Number.POSITIVE_INFINITY, rate: 0.45, quickDeduction: 181_920 },
    ],
  },

  // D-10: Overtime multipliers & statutory monthly limits
  overtime: {
    workdayRate: 1.5,
    restdayRate: 2.0,
    holidayRate: 3.0,
    maxHoursPerRequest: 4,
    maxHoursPerMonth: 36,
  },

  // D-11: Statutory annual leave entitlement by cumulative tenure years
  annualLeave: {
    under10Years: 5,
    under20Years: 10,
    over20Years: 15,
  },

  // D-16: Department categories requiring valid health certificate
  healthCert: {
    requiredDeptCategories: ['FB', 'HOUSEKEEPING'] as string[],
  },

  // T2-07: SLA reminder thresholds (hours)
  notifications: {
    urgentRemindHours: 4,
    normalRemindHours: 24,
  },
};

export function assertSegregation(
  userIdA: number | null | undefined,
  userIdB: number | null | undefined,
  message = '不相容岗位禁止由同一人操作'
): void {
  if (
    userIdA !== null &&
    userIdA !== undefined &&
    userIdB !== null &&
    userIdB !== undefined &&
    Number(userIdA) === Number(userIdB)
  ) {
    throw new AppError(403, message);
  }
}
