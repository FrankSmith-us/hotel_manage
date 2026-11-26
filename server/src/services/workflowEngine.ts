import { DbQueryRunner } from '../../db/adapter';
import { BUSINESS_RULES } from '../config/businessRules';
import { AuthUser, BizType, UserRole } from '../types';
import { nowIso, roundMoney, todayStr } from '../utils/numbers';

export interface PlannedStep {
  stepOrder: number;
  stepName: string;
  approverRole: UserRole;
  approverUserId?: number | null;
  skipReason?: string | null;
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
    if (totalAmount > BUSINESS_RULES.reimbursement.staffRegionThreshold || hasOverBudget) {
      steps.push({ stepName: '区域经理复核', approverRole: 'REGIONAL_MANAGER' });
    }
    steps.push({ stepName: '集团总经理终审', approverRole: 'GENERAL_MANAGER' });
  } else if (applicantRole === 'STORE_MANAGER') {
    steps.push({ stepName: '区域经理审批', approverRole: 'REGIONAL_MANAGER' });
    steps.push({ stepName: '集团总经理终审', approverRole: 'GENERAL_MANAGER' });
  } else if (applicantRole === 'GENERAL_MANAGER') {
    steps.push({ stepName: '集团财务负责人复核', approverRole: 'FINANCE' });
    steps.push({ stepName: '董事长终审', approverRole: 'CHAIRMAN' });
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

export function buildOnboardingRoute(params: { applicantRole: UserRole }): PlannedStep[] {
  const steps: { stepName: string; approverRole: UserRole }[] = [];
  if (params.applicantRole === 'STORE_MANAGER') {
    steps.push({ stepName: '区域经理审核', approverRole: 'REGIONAL_MANAGER' });
    steps.push({ stepName: '集团HR总监审批', approverRole: 'HR_MANAGER' });
  } else if (params.applicantRole === 'HR_MANAGER') {
    steps.push({ stepName: '集团总经理审批', approverRole: 'GENERAL_MANAGER' });
  } else {
    steps.push({ stepName: '集团HR总监审批', approverRole: 'HR_MANAGER' });
  }
  return steps.map((s, idx) => ({
    stepOrder: idx + 1,
    stepName: s.stepName,
    approverRole: s.approverRole,
  }));
}

export function buildOffboardingRoute(params: { targetRole: UserRole }): PlannedStep[] {
  const steps: { stepName: string; approverRole: UserRole }[] = [];
  if (params.targetRole === 'STAFF') {
    steps.push({ stepName: '门店店长审批', approverRole: 'STORE_MANAGER' });
    steps.push({ stepName: '集团HR离职复核', approverRole: 'HR_MANAGER' });
  } else if (params.targetRole === 'STORE_MANAGER') {
    steps.push({ stepName: '区域经理审批', approverRole: 'REGIONAL_MANAGER' });
    steps.push({ stepName: '集团HR离职复核', approverRole: 'HR_MANAGER' });
  } else if (params.targetRole === 'HR_MANAGER') {
    steps.push({ stepName: '集团总经理审批', approverRole: 'GENERAL_MANAGER' });
  } else {
    steps.push({ stepName: '集团HR离职复核', approverRole: 'HR_MANAGER' });
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

const ESCALATION_CHAIN: Partial<Record<UserRole, UserRole>> = {
  STORE_MANAGER: 'REGIONAL_MANAGER',
  REGIONAL_MANAGER: 'GENERAL_MANAGER',
  HR_MANAGER: 'GENERAL_MANAGER',
  FINANCE: 'GENERAL_MANAGER',
};

const ROLE_STEP_NAMES: Partial<Record<UserRole, string>> = {
  STORE_MANAGER: '门店店长审批',
  REGIONAL_MANAGER: '区域经理审核',
  HR_MANAGER: '集团HR审批',
  FINANCE: '集团财务审批',
  GENERAL_MANAGER: '集团总经理审批',
};

async function findActiveUserForRole(
  db: DbQueryRunner,
  role: UserRole,
  hotelId: number
): Promise<{ id: number; display_name: string } | null> {
  if (role === 'STORE_MANAGER') {
    return db.queryOne<{ id: number; display_name: string }>(
      `SELECT id, display_name FROM users WHERE role = 'STORE_MANAGER' AND hotel_id = ? AND is_active = 1 ORDER BY id ASC LIMIT 1`,
      [hotelId]
    );
  }
  if (role === 'REGIONAL_MANAGER') {
    const reg = await db.queryOne<{ id: number; manager_user_id: number | null }>(
      `SELECT r.id, r.manager_user_id FROM hotels h JOIN regions r ON r.id = h.region_id WHERE h.id = ?`,
      [hotelId]
    );
    if (reg?.manager_user_id) {
      const mgr = await db.queryOne<{ id: number; display_name: string }>(
        `SELECT id, display_name FROM users WHERE id = ? AND is_active = 1`,
        [reg.manager_user_id]
      );
      if (mgr) return mgr;
    }
    if (reg?.id) {
      return db.queryOne<{ id: number; display_name: string }>(
        `SELECT id, display_name FROM users WHERE role = 'REGIONAL_MANAGER' AND region_id = ? AND is_active = 1 ORDER BY id ASC LIMIT 1`,
        [reg.id]
      );
    }
    return null;
  }
  return db.queryOne<{ id: number; display_name: string }>(
    `SELECT id, display_name FROM users WHERE role = ? AND is_active = 1 ORDER BY id ASC LIMIT 1`,
    [role]
  );
}

export async function resolveApprover(
  db: DbQueryRunner,
  role: UserRole,
  hotelId: number,
  applicantUserId?: number | null
): Promise<{ userId: number | null; resolvedRole: UserRole; stepName: string | null; skipReason: string | null }> {
  let curRole: UserRole | undefined = role;
  const reasons: string[] = [];

  for (let depth = 0; depth < 5 && curRole; depth++) {
    const candidate = await findActiveUserForRole(db, curRole, hotelId);
    if (candidate && (!applicantUserId || Number(candidate.id) !== Number(applicantUserId))) {
      return {
        userId: Number(candidate.id),
        resolvedRole: curRole,
        stepName: depth > 0 ? ROLE_STEP_NAMES[curRole] || null : null,
        skipReason: reasons.length > 0 ? reasons.join('；') : null,
      };
    }
    const reasonText = !candidate
      ? `${curRole}岗位暂无在职审批人，已自动上推`
      : `审批人与申请人同为 ${candidate.display_name}，已自动上推`;
    reasons.push(reasonText);
    curRole = ESCALATION_CHAIN[curRole];
  }

  return {
    userId: null,
    resolvedRole: role,
    stepName: null,
    skipReason: reasons.length > 0 ? reasons.join('；') : null,
  };
}

export async function resolveApprovalRoute(
  db: DbQueryRunner,
  hotelId: number,
  rawSteps: PlannedStep[],
  applicantUserId?: number | null
): Promise<{
  steps: PlannedStep[];
  skippedRegionalManager: boolean;
  skipReason: string | null;
}> {
  const hasRegionalStep = rawSteps.some((s) => s.approverRole === 'REGIONAL_MANAGER');
  let skippedRegionalManager = false;
  let regionalSkipReason: string | null = null;
  let workingSteps = rawSteps;

  if (hasRegionalStep) {
    const { sameAsGm, gmName } = await isRegionalManagerSameAsGM(db, hotelId);
    if (sameAsGm) {
      skippedRegionalManager = true;
      regionalSkipReason = `区域经理与总经理为同一人（${gmName || '集团总经理'}），已自动跳过区域经理审核，直达总经理审批`;
      const alreadyHasGm = rawSteps.some((s) => s.approverRole === 'GENERAL_MANAGER');
      const mapped: PlannedStep[] = [];
      for (const s of rawSteps) {
        if (s.approverRole === 'REGIONAL_MANAGER') {
          if (!alreadyHasGm) {
            mapped.push({ stepOrder: s.stepOrder, stepName: '集团总经理审批', approverRole: 'GENERAL_MANAGER' });
          }
        } else {
          mapped.push(s);
        }
      }
      workingSteps = mapped;
    }
  }

  // Resolve concrete approver_user_id with fallback escalation
  const resolvedCandidates: Array<PlannedStep & { approverUserId: number | null; skipReason: string | null }> = [];
  for (const s of workingSteps) {
    const res = await resolveApprover(db, s.approverRole, hotelId, applicantUserId);
    resolvedCandidates.push({
      stepOrder: s.stepOrder,
      stepName: res.stepName || s.stepName,
      approverRole: res.resolvedRole,
      approverUserId: res.userId,
      skipReason: res.skipReason || s.skipReason || null,
    });
  }

  // Deduplicate repeated approverUserId (keep the last/highest step for that approver)
  // Also drop CHAIRMAN step when no active CHAIRMAN account exists and annotate previous step
  const deduped: typeof resolvedCandidates = [];
  for (let i = 0; i < resolvedCandidates.length; i++) {
    const cur = resolvedCandidates[i];
    if (cur.approverRole === 'CHAIRMAN' && cur.approverUserId === null) {
      if (deduped.length > 0) {
        const prev = deduped[deduped.length - 1];
        prev.skipReason = prev.skipReason
          ? `${prev.skipReason}；未配置董事长账号，财务复核后需线下签批`
          : '未配置董事长账号，财务复核后需线下签批';
      }
      continue;
    }
    const hasLaterSameUser =
      cur.approverUserId !== null &&
      resolvedCandidates.slice(i + 1).some((later) => later.approverUserId === cur.approverUserId);
    if (hasLaterSameUser) continue;
    deduped.push(cur);
  }

  const steps: PlannedStep[] = deduped.map((s, idx) => ({
    stepOrder: idx + 1,
    stepName: s.stepName,
    approverRole: s.approverRole,
    approverUserId: s.approverUserId,
    skipReason: s.skipReason,
  }));

  return {
    steps,
    skippedRegionalManager,
    skipReason: regionalSkipReason,
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
      `INSERT INTO approval_steps (biz_type, biz_id, step_order, step_name, approver_role, approver_user_id, skip_reason, status, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        bizType,
        bizId,
        s.stepOrder,
        s.stepName,
        s.approverRole,
        s.approverUserId ?? null,
        s.skipReason ?? null,
        s.stepOrder === 1 ? 'PENDING' : 'WAITING',
        ts,
      ]
    );
  }
}

export async function isActiveDelegateFor(
  db: DbQueryRunner,
  delegatorUserId: number,
  delegateUserId: number,
  bizType?: BizType
): Promise<boolean> {
  const today = todayStr();
  const rows = await db.query<{ biz_types: string }>(
    `SELECT biz_types FROM approval_delegations
     WHERE delegator_user_id = ? AND delegate_user_id = ? AND start_date <= ? AND end_date >= ?`,
    [delegatorUserId, delegateUserId, today, today]
  );
  for (const r of rows) {
    const list = r.biz_types.split(',').map((s) => s.trim().toUpperCase());
    if (list.includes('ALL') || (bizType && list.includes(bizType))) {
      return true;
    }
  }
  return false;
}

export async function canUserActOnStep(
  db: DbQueryRunner,
  user: AuthUser,
  approverRole: UserRole,
  bizHotelId: number,
  applicantUserId: number,
  opts?: { approverUserId?: number | null; bizType?: BizType }
): Promise<boolean> {
  if (Number(user.id) === Number(applicantUserId)) {
    return false;
  }
  if (opts?.approverUserId) {
    if (Number(user.id) === Number(opts.approverUserId)) {
      return true;
    }
    return isActiveDelegateFor(db, opts.approverUserId, user.id, opts.bizType);
  }
  if (user.role !== approverRole) {
    // Check if user is an active delegate of the resolved approver for this role/hotel
    const resolved = await findActiveUserForRole(db, approverRole, bizHotelId);
    if (resolved && (await isActiveDelegateFor(db, resolved.id, user.id, opts?.bizType))) {
      return true;
    }
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
    if (hotel.manager_user_id) {
      return Number(hotel.manager_user_id) === Number(user.id);
    }
    return Boolean(user.region_id && Number(hotel.region_id) === Number(user.region_id));
  }
  return true;
}

export async function reassignPendingSteps(db: DbQueryRunner, oldUserId: number): Promise<number> {
  const pendingRows = await db.query<{
    id: number;
    biz_type: BizType;
    biz_id: number;
    approver_role: UserRole;
  }>(
    `SELECT id, biz_type, biz_id, approver_role FROM approval_steps WHERE status = 'PENDING' AND approver_user_id = ?`,
    [oldUserId]
  );
  let count = 0;
  for (const st of pendingRows) {
    let hotelId: number | null = null;
    let applicantId: number | null = null;
    if (st.biz_type === 'REIMBURSEMENT') {
      const r = await db.queryOne<{ hotel_id: number; applicant_id: number }>('SELECT hotel_id, applicant_id FROM reimbursements WHERE id = ?', [st.biz_id]);
      hotelId = r?.hotel_id ?? null;
      applicantId = r?.applicant_id ?? null;
    } else if (st.biz_type === 'CASH_ADVANCE') {
      const r = await db.queryOne<{ hotel_id: number; applicant_id: number }>('SELECT hotel_id, applicant_id FROM cash_advances WHERE id = ?', [st.biz_id]);
      hotelId = r?.hotel_id ?? null;
      applicantId = r?.applicant_id ?? null;
    } else if (st.biz_type === 'HEADCOUNT') {
      const r = await db.queryOne<{ hotel_id: number; applicant_id: number }>('SELECT hotel_id, applicant_id FROM headcount_requests WHERE id = ?', [st.biz_id]);
      hotelId = r?.hotel_id ?? null;
      applicantId = r?.applicant_id ?? null;
    } else if (st.biz_type === 'LEAVE') {
      const r = await db.queryOne<{ hotel_id: number; employee_id: number }>('SELECT hotel_id, employee_id FROM leave_requests WHERE id = ?', [st.biz_id]);
      if (r) {
        hotelId = r.hotel_id;
        const u = await db.queryOne<{ id: number }>('SELECT id FROM users WHERE employee_id = ?', [r.employee_id]);
        applicantId = u?.id ?? null;
      }
    } else if (st.biz_type === 'ONBOARDING') {
      const r = await db.queryOne<{ hotel_id: number; applicant_id: number }>('SELECT hotel_id, applicant_id FROM onboarding_requests WHERE id = ?', [st.biz_id]);
      hotelId = r?.hotel_id ?? null;
      applicantId = r?.applicant_id ?? null;
    } else if (st.biz_type === 'OFFBOARDING') {
      const r = await db.queryOne<{ hotel_id: number; applicant_id: number }>('SELECT hotel_id, applicant_id FROM offboarding_requests WHERE id = ?', [st.biz_id]);
      hotelId = r?.hotel_id ?? null;
      applicantId = r?.applicant_id ?? null;
    }
    if (!hotelId) continue;
    const res = await resolveApprover(db, st.approver_role, hotelId, applicantId);
    if (res.userId && res.userId !== oldUserId) {
      await db.execute(
        `UPDATE approval_steps SET approver_user_id = ?, approver_role = ?, skip_reason = ? WHERE id = ?`,
        [res.userId, res.resolvedRole, res.skipReason || '原审批人离职/异动自动转派', st.id]
      );
      count++;
    }
  }
  return count;
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
  advance: {
    id: number;
    advance_no: string;
    applicant_id: number;
    hotel_id: number;
    amount: number;
    offset_amount: number;
    status: string;
  } | null;
  availableBalance: number;
}> {
  const advance = await db.queryOne<{
    id: number;
    advance_no: string;
    applicant_id: number;
    hotel_id: number;
    amount: number;
    offset_amount: number;
    status: string;
  }>(
    `SELECT id, advance_no, applicant_id, hotel_id, amount, offset_amount, status
     FROM cash_advances WHERE id = ?${db.forUpdateSuffix()}`,
    [advanceId]
  );
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

export interface WorkflowStepSummary {
  step_order: number;
  step_name: string;
  approver_role: UserRole;
  status: string;
  actor_name: string | null;
  acted_at: string | null;
}

export async function getWorkflowStepsWithActors(
  db: DbQueryRunner,
  bizType: BizType,
  bizId: number
): Promise<WorkflowStepSummary[]> {
  return db.query<WorkflowStepSummary>(
    `SELECT s.step_order, s.step_name, s.approver_role, s.status,
            u.display_name AS actor_name, s.acted_at
     FROM approval_steps s
     LEFT JOIN users u ON u.id = s.acted_by
     WHERE s.biz_type = ? AND s.biz_id = ?
     ORDER BY s.step_order ASC`,
    [bizType, bizId]
  );
}

export async function getUserLastHandledAction(
  db: DbQueryRunner,
  bizType: BizType,
  bizId: number,
  userId: number
): Promise<{ my_last_action: string | null; my_acted_at: string | null }> {
  const log = await db.queryOne<{ action: string; created_at: string }>(
    `SELECT action, created_at
     FROM approval_logs
     WHERE biz_type = ? AND biz_id = ? AND actor_id = ?
       AND action IN ('APPROVE', 'RETURN', 'REJECT', 'PAY', 'DISBURSE')
     ORDER BY id DESC LIMIT 1`,
    [bizType, bizId, userId]
  );
  if (log) {
    return { my_last_action: log.action, my_acted_at: log.created_at };
  }
  const step = await db.queryOne<{ status: string; acted_at: string | null }>(
    `SELECT status, acted_at
     FROM approval_steps
     WHERE biz_type = ? AND biz_id = ? AND acted_by = ?
     ORDER BY step_order DESC LIMIT 1`,
    [bizType, bizId, userId]
  );
  if (step) {
    const action =
      step.status === 'APPROVED'
        ? 'APPROVE'
        : step.status === 'RETURNED'
          ? 'RETURN'
          : step.status === 'REJECTED'
            ? 'REJECT'
            : null;
    return { my_last_action: action, my_acted_at: step.acted_at };
  }
  return { my_last_action: null, my_acted_at: null };
}

export async function hasUserActedOnBiz(
  db: DbQueryRunner,
  bizType: BizType,
  bizId: number,
  userId: number
): Promise<boolean> {
  const stepHit = await db.queryOne<{ id: number }>(
    `SELECT id FROM approval_steps WHERE biz_type = ? AND biz_id = ? AND acted_by = ? LIMIT 1`,
    [bizType, bizId, userId]
  );
  if (stepHit) return true;
  const logHit = await db.queryOne<{ id: number }>(
    `SELECT id FROM approval_logs
     WHERE biz_type = ? AND biz_id = ? AND actor_id = ?
       AND action IN ('APPROVE', 'RETURN', 'REJECT', 'PAY', 'DISBURSE')
     LIMIT 1`,
    [bizType, bizId, userId]
  );
  return Boolean(logHit);
}

export function buildStatusDetail(params: {
  bizType: BizType;
  status: string;
  currentStepName?: string | null;
  currentStep?: number;
  totalSteps?: number;
  returnedToName?: string | null;
  paymentRef?: string | null;
}): string {
  const { bizType, status, currentStepName, currentStep, totalSteps, returnedToName, paymentRef } = params;
  if (status === 'DRAFT') return '草稿（待提交）';
  if (status === 'CANCELLED') return '申请人已撤销';
  if (status === 'REJECTED') return '审批已驳回';
  if (status === 'RETURNED') {
    return `已退回至：${returnedToName || '申请人'}（待修改重提）`;
  }
  if (status === 'PENDING_APPROVAL') {
    const stepProg =
      currentStep && totalSteps && totalSteps > 0 ? `（第${currentStep}/${totalSteps}步）` : '';
    return currentStepName ? `待${currentStepName}${stepProg}` : '审批处理中';
  }
  if (bizType === 'REIMBURSEMENT') {
    if (status === 'APPROVED') return '总经理已终审 · 待财务付款';
    if (status === 'PAYMENT_FAILED') return '付款失败 · 待申请人更正收款信息后重付';
    if (status === 'PAID') return paymentRef ? `财务已打款（${paymentRef}）` : '财务已打款核销';
  } else if (bizType === 'CASH_ADVANCE') {
    if (status === 'APPROVED') return '审批已通过 · 待财务放款';
    if (status === 'DISBURSED') return paymentRef ? `已放款待冲销（${paymentRef}）` : '已放款 · 待报销冲销';
    if (status === 'SETTLED') return '已全额冲销结清';
  } else if (bizType === 'LEAVE') {
    if (status === 'APPROVED') return '审批已通过（已生效）';
  } else if (bizType === 'HEADCOUNT') {
    if (status === 'APPROVED') return '补编已批准 · 可推进招聘';
  } else if (bizType === 'ONBOARDING') {
    if (status === 'APPROVED') return '审批已通过 · 待确认入职建档';
    if (status === 'COMPLETED') return '已完成入职建档';
  } else if (bizType === 'OFFBOARDING') {
    if (status === 'APPROVED') return '审批已通过 · 待办理离职并归档';
    if (status === 'COMPLETED') return '已离职并完成档案归档';
  }
  return status;
}
