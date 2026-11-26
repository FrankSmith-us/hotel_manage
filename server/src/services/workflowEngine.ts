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

  if (applicantRole === 'STAFF') {
    steps.push({ stepName: '门店店长审批', approverRole: 'STORE_MANAGER' });
    if (totalAmount > 1000 || hasOverBudget) {
      steps.push({ stepName: '区域经理复核', approverRole: 'REGIONAL_MANAGER' });
    }
    steps.push({ stepName: '集团总经理终审', approverRole: 'GENERAL_MANAGER' });
  } else if (applicantRole === 'STORE_MANAGER') {
    steps.push({ stepName: '区域经理审批', approverRole: 'REGIONAL_MANAGER' });
    steps.push({ stepName: '集团总经理终审', approverRole: 'GENERAL_MANAGER' });
  } else if (applicantRole === 'GENERAL_MANAGER') {
    steps.push({ stepName: '集团系统管理员复核', approverRole: 'HQ_ADMIN' });
  } else {
    // FINANCE, HQ_ADMIN, HR_MANAGER, REGIONAL_MANAGER
    steps.push({ stepName: '集团总经理终审', approverRole: 'GENERAL_MANAGER' });
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

export async function isRegionalManagerSameAsGM(
  db: DbQueryRunner,
  hotelId: number
): Promise<{ sameAsGm: boolean; regionName: string | null; gmName: string | null }> {
  const region = await db.queryOne<{
    id: number;
    name: string;
    manager_user_id: number | null;
  }>(
    `SELECT r.id, r.name, r.manager_user_id
     FROM hotels h
     JOIN regions r ON r.id = h.region_id
     WHERE h.id = ?`,
    [hotelId]
  );
  if (!region) {
    return { sameAsGm: false, regionName: null, gmName: null };
  }

  const gmUsers = await db.query<{
    id: number;
    employee_id: number | null;
    display_name: string;
  }>(
    `SELECT id, employee_id, display_name
     FROM users
     WHERE role = 'GENERAL_MANAGER' AND is_active = 1`
  );
  if (gmUsers.length === 0) {
    return { sameAsGm: false, regionName: region.name, gmName: null };
  }

  const gmIds = new Set(gmUsers.map((g) => Number(g.id)));
  const gmEmpIds = new Set(
    gmUsers.filter((g) => g.employee_id !== null).map((g) => Number(g.employee_id))
  );

  if (region.manager_user_id) {
    const mgrId = Number(region.manager_user_id);
    if (gmIds.has(mgrId)) {
      const gm = gmUsers.find((g) => Number(g.id) === mgrId)!;
      return { sameAsGm: true, regionName: region.name, gmName: gm.display_name };
    }
    const mgrUser = await db.queryOne<{ employee_id: number | null; display_name: string }>(
      'SELECT employee_id, display_name FROM users WHERE id = ? AND is_active = 1',
      [mgrId]
    );
    if (mgrUser?.employee_id && gmEmpIds.has(Number(mgrUser.employee_id))) {
      return { sameAsGm: true, regionName: region.name, gmName: mgrUser.display_name };
    }
    return { sameAsGm: false, regionName: region.name, gmName: null };
  }

  // Fallback when manager_user_id is not explicitly configured: check if the region's REGIONAL_MANAGER shares employee_id with GM
  const regionalMgrs = await db.query<{ employee_id: number | null; display_name: string }>(
    `SELECT employee_id, display_name
     FROM users
     WHERE role = 'REGIONAL_MANAGER' AND region_id = ? AND is_active = 1`,
    [region.id]
  );
  for (const rm of regionalMgrs) {
    if (rm.employee_id && gmEmpIds.has(Number(rm.employee_id))) {
      return { sameAsGm: true, regionName: region.name, gmName: rm.display_name };
    }
  }

  return { sameAsGm: false, regionName: region.name, gmName: null };
}

export async function resolveApprovalRoute(
  db: DbQueryRunner,
  hotelId: number,
  rawSteps: PlannedStep[]
): Promise<{
  steps: PlannedStep[];
  skippedRegionalManager: boolean;
  skipReason: string | null;
}> {
  const hasRegionalStep = rawSteps.some((s) => s.approverRole === 'REGIONAL_MANAGER');
  if (!hasRegionalStep) {
    return { steps: rawSteps, skippedRegionalManager: false, skipReason: null };
  }

  const { sameAsGm, gmName } = await isRegionalManagerSameAsGM(db, hotelId);
  if (!sameAsGm) {
    return { steps: rawSteps, skippedRegionalManager: false, skipReason: null };
  }

  const alreadyHasGm = rawSteps.some((s) => s.approverRole === 'GENERAL_MANAGER');
  const mapped: Array<{ stepName: string; approverRole: UserRole }> = [];
  for (const s of rawSteps) {
    if (s.approverRole === 'REGIONAL_MANAGER') {
      if (!alreadyHasGm) {
        mapped.push({ stepName: '集团总经理审批', approverRole: 'GENERAL_MANAGER' });
      }
      // When GM is already in the route, skip REGIONAL_MANAGER directly
    } else {
      mapped.push({ stepName: s.stepName, approverRole: s.approverRole });
    }
  }

  const steps: PlannedStep[] = mapped.map((s, idx) => ({
    stepOrder: idx + 1,
    stepName: s.stepName,
    approverRole: s.approverRole,
  }));

  return {
    steps,
    skippedRegionalManager: true,
    skipReason: `区域经理与总经理为同一人（${gmName || '集团总经理'}），已自动跳过区域经理审核，直达总经理审批`,
  };
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
    const hotel = await db.queryOne<{ region_id: number; manager_user_id: number | null }>(
      `SELECT h.region_id, r.manager_user_id
       FROM hotels h
       JOIN regions r ON r.id = h.region_id
       WHERE h.id = ?`,
      [bizHotelId]
    );
    if (!hotel) return false;
    if (hotel.manager_user_id && Number(hotel.manager_user_id) === Number(user.id)) {
      return true;
    }
    return Boolean(user.region_id && Number(hotel.region_id) === Number(user.region_id));
  }
  return true;
}

export async function isUserReturnTarget(
  db: DbQueryRunner,
  user: AuthUser,
  claim: {
    status: string;
    applicant_id: number;
    hotel_id: number;
    returned_to_step: number | null;
    returned_to_user_id: number | null;
    returned_to_role: string | null;
  }
): Promise<boolean> {
  if (claim.status !== 'RETURNED') return false;
  if (claim.returned_to_step === null || Number(claim.returned_to_step) === 0) {
    return Number(user.id) === Number(claim.applicant_id);
  }
  if (claim.returned_to_user_id) {
    return Number(user.id) === Number(claim.returned_to_user_id);
  }
  if (claim.returned_to_role && claim.returned_to_role !== 'APPLICANT') {
    return canUserActOnStep(
      db,
      user,
      claim.returned_to_role as UserRole,
      claim.hotel_id,
      claim.applicant_id
    );
  }
  return false;
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
