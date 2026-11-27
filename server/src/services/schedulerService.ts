import { DbAdapter, DbQueryRunner } from '../../db/adapter';
import { BUSINESS_RULES } from '../config/businessRules';
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
    await tx.execute(`UPDATE regions SET manager_user_id = NULL WHERE manager_user_id = ?`, [u.id]);
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

export interface EmployeeChangeRow {
  id: number;
  request_no: string;
  employee_id: number;
  change_type: string;
  from_hotel_id: number;
  to_hotel_id: number;
  from_department_id: number;
  to_department_id: number;
  from_position: string;
  to_position: string;
  from_salary: number;
  to_salary: number;
  effective_date: string;
  reason: string;
  applicant_id: number;
}

export async function executeEmployeeChangeTx(
  tx: DbQueryRunner,
  chg: EmployeeChangeRow,
  actor: AuthUser
): Promise<void> {
  const ts = nowIso();
  const emp = await tx.queryOne<{ id: number; status: string }>(
    'SELECT id, status FROM employees WHERE id = ?',
    [chg.employee_id]
  );
  if (!emp) throw new Error(`员工 ${chg.employee_id} 不存在`);

  const newStatus = chg.change_type === 'PROBATION_PASS' ? 'ACTIVE' : emp.status;
  await tx.execute(
    `UPDATE employees
     SET hotel_id = ?, department_id = ?, position = ?, base_salary = ?, status = ?, updated_at = ?
     WHERE id = ?`,
    [chg.to_hotel_id, chg.to_department_id, chg.to_position, chg.to_salary, newStatus, ts, chg.employee_id]
  );

  if (chg.change_type === 'TRANSFER' && Number(chg.to_hotel_id) !== Number(chg.from_hotel_id)) {
    const empUsers = await tx.query<{ id: number }>(
      'SELECT id FROM users WHERE employee_id = ? AND is_active = 1',
      [chg.employee_id]
    );
    const targetHotel = await tx.queryOne<{ region_id: number }>('SELECT region_id FROM hotels WHERE id = ?', [
      chg.to_hotel_id,
    ]);
    await tx.execute('UPDATE users SET hotel_id = ?, region_id = ? WHERE employee_id = ?', [
      chg.to_hotel_id,
      targetHotel?.region_id ?? null,
      chg.employee_id,
    ]);
    for (const u of empUsers) {
      await reassignPendingSteps(tx, u.id);
    }
  }

  const evType =
    chg.change_type === 'PROBATION_PASS'
      ? 'PROBATION_PASS'
      : chg.change_type === 'TRANSFER'
        ? 'TRANSFER'
        : chg.change_type === 'PROMOTE'
          ? 'PROMOTE'
          : 'SALARY_ADJUST';

  await tx.execute(
    `INSERT INTO employee_lifecycle_events (
      employee_id, event_type, from_hotel_id, to_hotel_id, from_position, to_position,
      effective_date, reason, operator_id, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      chg.employee_id,
      evType,
      chg.from_hotel_id,
      chg.to_hotel_id,
      chg.from_position,
      chg.to_position,
      chg.effective_date,
      `人事异动审批单（${chg.request_no}）生效执行：${chg.reason}`,
      actor.id,
      ts,
    ]
  );

  await tx.execute(
    `UPDATE employee_change_requests
     SET status = 'EXECUTED', executed_at = ?, updated_at = ?
     WHERE id = ?`,
    [ts, ts, chg.id]
  );

  await logApprovalAction(tx, {
    bizType: 'EMPLOYEE_CHANGE',
    bizId: chg.id,
    action: 'EXECUTE',
    actor,
    comment: `人事异动按生效日(${chg.effective_date})执行完成`,
  });
}

export async function runScheduledJobs(
  db: DbAdapter,
  triggeredBy?: AuthUser
): Promise<{ executedOffboardings: number; executedChanges: number; sentReminders: number }> {
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

  const dueChanges = await db.query<EmployeeChangeRow>(
    `SELECT * FROM employee_change_requests WHERE status = 'APPROVED' AND effective_date <= ?`,
    [today]
  );
  let executedChanges = 0;
  for (const chg of dueChanges) {
    let actor = triggeredBy;
    if (!actor) {
      const appUser = await db.queryOne<AuthUser>(
        `SELECT id, username, display_name, role, employee_id, hotel_id, region_id FROM users WHERE id = ?`,
        [chg.applicant_id]
      );
      if (appUser) actor = appUser;
    }
    if (!actor) continue;

    await db.transaction(async (tx) => {
      await executeEmployeeChangeTx(tx, chg, actor!);
    });
    executedChanges++;
  }

  const ts = nowIso();
  const pendingSteps = await db.query<{
    biz_type: string;
    biz_id: number;
    step_name: string;
    approver_user_id: number | null;
    created_at: string;
  }>(
    `SELECT biz_type, biz_id, step_name, approver_user_id, created_at
     FROM approval_steps
     WHERE status = 'PENDING' AND approver_user_id IS NOT NULL`
  );
  let sentReminders = 0;
  const nowMs = Date.now();
  const normalCutoffMs = BUSINESS_RULES.notifications.normalRemindHours * 3600 * 1000;
  for (const ps of pendingSteps) {
    if (!ps.approver_user_id || !ps.created_at) continue;
    const createdMs = Date.parse(ps.created_at.replace(' ', 'T') + '+08:00');
    if (Number.isNaN(createdMs) || nowMs - createdMs < normalCutoffMs) continue;
    const recent = await db.queryOne<{ id: number }>(
      `SELECT id FROM notifications
       WHERE user_id = ? AND biz_type = ? AND biz_id = ? AND level = 'SLA_REMINDER' AND created_at >= ?
       LIMIT 1`,
      [ps.approver_user_id, ps.biz_type, ps.biz_id, today]
    );
    if (recent) continue;
    await db.execute(
      `INSERT INTO notifications (user_id, biz_type, biz_id, title, content, level, is_read, created_at)
       VALUES (?, ?, ?, ?, ?, 'SLA_REMINDER', 0, ?)`,
      [
        ps.approver_user_id,
        ps.biz_type,
        ps.biz_id,
        `审批超时提醒：${ps.biz_type} #${ps.biz_id}`,
        `「${ps.step_name}」已超过 ${BUSINESS_RULES.notifications.normalRemindHours} 小时未处理，请及时审批。`,
        ts,
      ]
    );
    sentReminders++;
  }

  return { executedOffboardings, executedChanges, sentReminders };
}

export function startScheduler(getDbFn: () => DbAdapter): void {
  const timer = setInterval(() => {
    runScheduledJobs(getDbFn()).catch((err) => {
      console.error('[scheduler] scheduled job error:', err);
    });
  }, 60 * 60 * 1000);
  timer.unref();
}
