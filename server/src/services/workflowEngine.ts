import { DbQueryRunner } from '../../db/adapter';
import { AuthUser, BizType, UserRole } from '../types';
import { nowIso, roundMoney } from '../utils/numbers';

export interface PlannedStep {
  stepOrder: number;
  stepName: string;
  approverRole: UserRole;
}

export function buildReimbursementRoute(params: {
  applicantRole: UserRole;
  totalAmount: number;
  hasOverBudget: boolean;
}): PlannedStep[] {
  const { applicantRole, totalAmount, hasOverBudget } = params;
  const steps: { stepName: string; approverRole: UserRole }[] = [];
  const needGm = totalAmount > 5000 || hasOverBudget;

  if (applicantRole === 'STAFF') {
    steps.push({ stepName: '门店店长审批', approverRole: 'STORE_MANAGER' });
    if (totalAmount > 1000) {
      steps.push({ stepName: '区域经理复核', approverRole: 'REGIONAL_MANAGER' });
    }
    steps.push({ stepName: '集团财务审核', approverRole: 'FINANCE' });
    if (needGm) {
      steps.push({ stepName: '集团总经理终审', approverRole: 'GENERAL_MANAGER' });
    }
  } else if (applicantRole === 'STORE_MANAGER') {
    steps.push({ stepName: '区域经理审批', approverRole: 'REGIONAL_MANAGER' });
    steps.push({ stepName: '集团财务审核', approverRole: 'FINANCE' });
    if (needGm) {
      steps.push({ stepName: '集团总经理终审', approverRole: 'GENERAL_MANAGER' });
    }
  } else if (applicantRole === 'FINANCE') {
    steps.push({ stepName: '集团总经理终审', approverRole: 'GENERAL_MANAGER' });
  } else if (applicantRole === 'GENERAL_MANAGER') {
    steps.push({ stepName: '集团财务审核', approverRole: 'FINANCE' });
    if (needGm) {
      steps.push({ stepName: '集团系统管理员复核', approverRole: 'HQ_ADMIN' });
    }
  } else {
    // HQ_ADMIN, HR_MANAGER, REGIONAL_MANAGER
    steps.push({ stepName: '集团财务审核', approverRole: 'FINANCE' });
    if (needGm) {
      steps.push({ stepName: '集团总经理终审', approverRole: 'GENERAL_MANAGER' });
    }
  }

  return steps.map((s, idx) => ({
    stepOrder: idx + 1,
    stepName: s.stepName,
    approverRole: s.approverRole,
  }));
}

export function buildLeaveRoute(params: { applicantRole: UserRole; days: number }): PlannedStep[] {
  const steps: { stepName: string; approverRole: UserRole }[] = [];
  if (params.applicantRole === 'STAFF') {
    steps.push({ stepName: '门店店长审批', approverRole: 'STORE_MANAGER' });
    if (params.days >= 3) {
      steps.push({ stepName: '集团HR备案审批', approverRole: 'HR_MANAGER' });
    }
  } else if (params.applicantRole === 'STORE_MANAGER') {
    steps.push({ stepName: '区域经理审批', approverRole: 'REGIONAL_MANAGER' });
    steps.push({ stepName: '集团HR审批', approverRole: 'HR_MANAGER' });
  } else if (params.applicantRole === 'HR_MANAGER') {
    steps.push({ stepName: '集团总经理审批', approverRole: 'GENERAL_MANAGER' });
  } else {
    steps.push({ stepName: '集团HR审批', approverRole: 'HR_MANAGER' });
  }
  return steps.map((s, idx) => ({
    stepOrder: idx + 1,
    stepName: s.stepName,
    approverRole: s.approverRole,
  }));
}

export function buildHeadcountRoute(params: { headcount: number; urgency: string }): PlannedStep[] {
  const steps: { stepName: string; approverRole: UserRole }[] = [
    { stepName: '区域经理审核', approverRole: 'REGIONAL_MANAGER' },
    { stepName: '集团HR总监审批', approverRole: 'HR_MANAGER' },
  ];
  if (params.headcount >= 3 || params.urgency === 'URGENT') {
    steps.push({ stepName: '集团总经理终审', approverRole: 'GENERAL_MANAGER' });
  }
  return steps.map((s, idx) => ({
    stepOrder: idx + 1,
    stepName: s.stepName,
    approverRole: s.approverRole,
  }));
}

export function buildCashAdvanceRoute(params: {
  applicantRole: UserRole;
  amount: number;
}): PlannedStep[] {
  const steps: { stepName: string; approverRole: UserRole }[] = [];
  if (params.applicantRole === 'STAFF') {
    steps.push({ stepName: '门店店长审批', approverRole: 'STORE_MANAGER' });
    if (params.amount > 3000) {
      steps.push({ stepName: '区域经理复核', approverRole: 'REGIONAL_MANAGER' });
    }
    steps.push({ stepName: '集团财务审批', approverRole: 'FINANCE' });
    if (params.amount > 3000) {
      steps.push({ stepName: '集团总经理终审', approverRole: 'GENERAL_MANAGER' });
    }
  } else if (params.applicantRole === 'STORE_MANAGER') {
    steps.push({ stepName: '区域经理审批', approverRole: 'REGIONAL_MANAGER' });
    steps.push({ stepName: '集团财务审批', approverRole: 'FINANCE' });
    if (params.amount > 3000) {
      steps.push({ stepName: '集团总经理终审', approverRole: 'GENERAL_MANAGER' });
    }
  } else if (params.applicantRole === 'FINANCE') {
    steps.push({ stepName: '集团总经理终审', approverRole: 'GENERAL_MANAGER' });
  } else {
    steps.push({ stepName: '集团财务审批', approverRole: 'FINANCE' });
    if (params.amount > 3000) {
      steps.push({ stepName: '集团总经理终审', approverRole: 'GENERAL_MANAGER' });
    }
  }
  return steps.map((s, idx) => ({
    stepOrder: idx + 1,
    stepName: s.stepName,
    approverRole: s.approverRole,
  }));
}

export async function replaceApprovalSteps(
  db: DbQueryRunner,
  bizType: BizType,
  bizId: number,
  plannedSteps: PlannedStep[]
): Promise<void> {
  await db.execute('DELETE FROM approval_steps WHERE biz_type = ? AND biz_id = ?', [bizType, bizId]);
  const ts = nowIso();
  for (const s of plannedSteps) {
    await db.execute(
      `INSERT INTO approval_steps (biz_type, biz_id, step_order, step_name, approver_role, status, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [bizType, bizId, s.stepOrder, s.stepName, s.approverRole, s.stepOrder === 1 ? 'PENDING' : 'WAITING', ts]
    );
  }
}

export async function canUserActOnStep(
  db: DbQueryRunner,
  user: AuthUser,
  approverRole: UserRole,
  bizHotelId: number,
  applicantUserId: number
): Promise<boolean> {
  if (user.id === applicantUserId) {
    return false;
  }
  if (user.role !== approverRole) {
    return false;
  }
  if (approverRole === 'STORE_MANAGER') {
    return Number(user.hotel_id) === Number(bizHotelId);
  }
  if (approverRole === 'REGIONAL_MANAGER') {
    if (!user.region_id) return false;
    const hotel = await db.queryOne<{ region_id: number }>('SELECT region_id FROM hotels WHERE id = ?', [
      bizHotelId,
    ]);
    return Boolean(hotel && Number(hotel.region_id) === Number(user.region_id));
  }
  return true;
}

export async function getAvailableAdvanceBalance(
  db: DbQueryRunner,
  advanceId: number,
  excludeReimbursementId?: number
): Promise<{
  advance: { id: number; advance_no: string; hotel_id: number; amount: number; offset_amount: number; status: string } | null;
  availableBalance: number;
}> {
  const advance = await db.queryOne<{
    id: number;
    advance_no: string;
    hotel_id: number;
    amount: number;
    offset_amount: number;
    status: string;
  }>('SELECT id, advance_no, hotel_id, amount, offset_amount, status FROM cash_advances WHERE id = ?', [
    advanceId,
  ]);
  if (!advance) {
    return { advance: null, availableBalance: 0 };
  }

  const excludeSql = excludeReimbursementId ? 'AND id != ?' : '';
  const params: unknown[] = [advanceId];
  if (excludeReimbursementId) params.push(excludeReimbursementId);

  const reservedRow = await db.queryOne<{ reserved: number }>(
    `SELECT COALESCE(SUM(offset_amount), 0) AS reserved
     FROM reimbursements
     WHERE cash_advance_id = ?
       AND status IN ('PENDING_APPROVAL', 'RETURNED', 'APPROVED')
       ${excludeSql}`,
    params
  );

  const available = roundMoney(
    Number(advance.amount) - Number(advance.offset_amount) - Number(reservedRow?.reserved || 0)
  );
  return {
    advance,
    availableBalance: Math.max(0, available),
  };
}
