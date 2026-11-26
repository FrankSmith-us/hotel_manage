import { DbAdapter, DbQueryRunner } from '../../db/adapter';
import { AuthUser } from '../types';
import { nowIso, todayStr } from '../utils/numbers';
import { archiveEmployeeRecords } from './archiveService';
import { logApprovalAction } from './auditService';
import { reassignPendingSteps } from './workflowEngine';

export async function completeOffboardingTx(
  tx: DbQueryRunner,
  off: {
    id: number;
    request_no: string;
    employee_id: number;
    hotel_id: number;
    resign_reason_detail: string;
    last_working_date: string;
  },
  actor: AuthUser,
  options?: {
    checklist?: Record<string, boolean>;
    settlementStatus?: string;
  }
): Promise<number> {
  const ts = nowIso();
  const emp = await tx.queryOne<{ id: number; position: string; hotel_id: number }>(
    'SELECT id, position, hotel_id FROM employees WHERE id = ?',
    [off.employee_id]
  );
  if (!emp) throw new Error(`员工 ${off.employee_id} 不存在`);

  await tx.execute(
    `UPDATE employees SET status = 'RESIGNED', resign_date = ?, updated_at = ? WHERE id = ?`,
    [off.last_working_date, ts, off.employee_id]
  );

  const empUsers = await tx.query<{ id: number }>('SELECT id FROM users WHERE employee_id = ? AND is_active = 1', [
    off.employee_id,
  ]);
  await tx.execute(`UPDATE users SET is_active = 0 WHERE employee_id = ?`, [off.employee_id]);
  for (const u of empUsers) {
    await reassignPendingSteps(tx, u.id);
  }

  await tx.execute(
    `INSERT INTO employee_lifecycle_events (
      employee_id, event_type, from_hotel_id, to_hotel_id, from_position, to_position,
      effective_date, reason, operator_id, created_at
    ) VALUES (?, 'RESIGN', ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      off.employee_id,
      emp.hotel_id,
      emp.hotel_id,
      emp.position,
      emp.position,
      off.last_working_date,
      `离职流程（${off.request_no}）办结：${off.resign_reason_detail}`,
      actor.id,
      ts,
    ]
  );

  const archId = await archiveEmployeeRecords(tx, {
    employeeId: off.employee_id,
    resignDate: off.last_working_date,
    resignReason: off.resign_reason_detail,
    offboardingRequestId: off.id,
    operator: actor,
  });

  await tx.execute(
    `UPDATE offboarding_requests
     SET status = 'COMPLETED', archive_id = ?, checklist_json = ?,
         effective_executed_at = ?, settlement_status = COALESCE(?, settlement_status),
         scheduled_execute = 0, updated_at = ?
     WHERE id = ?`,
    [
      archId,
      JSON.stringify(options?.checklist || { work_handover: true, assets_returned: true, finance_settled: true }),
      ts,
      options?.settlementStatus ?? 'SETTLED',
      ts,
      off.id,
    ]
  );

  await logApprovalAction(tx, {
    bizType: 'OFFBOARDING',
    bizId: off.id,
    action: 'COMPLETE',
    actor,
    comment: `离职办结，员工状态已变更为已离职并完成历史档案归档（归档ID #${archId}）`,
  });

  return archId;
}

export async function runScheduledJobs(
  db: DbAdapter,
  triggeredBy?: AuthUser
): Promise<{ executedOffboardings: number }> {
  const today = todayStr();
  const dueList = await db.query<{
    id: number;
    request_no: string;
    employee_id: number;
    hotel_id: number;
    applicant_id: number;
    resign_reason_detail: string;
    last_working_date: string;
    settlement_status: string;
  }>(
    `SELECT id, request_no, employee_id, hotel_id, applicant_id, resign_reason_detail, last_working_date, settlement_status
     FROM offboarding_requests
     WHERE status = 'APPROVED' AND scheduled_execute = 1 AND last_working_date <= ?`,
    [today]
  );

  let executedOffboardings = 0;
  for (const off of dueList) {
    const blocked = await db.queryOne<{ cnt: number }>(
      `SELECT COUNT(*) AS cnt FROM offboarding_clearance_items WHERE offboarding_id = ? AND status = 'BLOCKED'`,
      [off.id]
    );
    if (blocked && Number(blocked.cnt) > 0) continue;

    let actor = triggeredBy;
    if (!actor) {
      const appUser = await db.queryOne<{
        id: number;
        username: string;
        display_name: string;
        role: AuthUser['role'];
        employee_id: number | null;
        hotel_id: number | null;
        region_id: number | null;
      }>(
        `SELECT id, username, display_name, role, employee_id, hotel_id, region_id
         FROM users WHERE id = ?`,
        [off.applicant_id]
      );
      if (appUser) actor = appUser;
    }
    if (!actor) continue;

    await db.transaction(async (tx) => {
      await completeOffboardingTx(tx, off, actor!, {
        settlementStatus: off.settlement_status === 'SALARY_DEDUCT' ? 'SALARY_DEDUCT' : 'SETTLED',
      });
    });
    executedOffboardings++;
  }

  return { executedOffboardings };
}

export function startScheduler(getDbFn: () => DbAdapter): void {
  const timer = setInterval(() => {
    runScheduledJobs(getDbFn()).catch((err) => {
      console.error('[scheduler] scheduled job error:', err);
    });
  }, 60 * 60 * 1000);
  timer.unref();
}
