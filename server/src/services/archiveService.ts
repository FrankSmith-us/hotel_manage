import { DbQueryRunner } from '../../db/adapter';
import { AuthUser } from '../types';
import { nowIso, roundMoney } from '../utils/numbers';

export interface ArchiveEmployeeParams {
  employeeId: number;
  resignDate: string;
  resignReason: string;
  offboardingRequestId?: number | null;
  operator: AuthUser;
}

export async function archiveEmployeeRecords(
  tx: DbQueryRunner,
  params: ArchiveEmployeeParams
): Promise<number> {
  const emp = await tx.queryOne<Record<string, unknown> & {
    id: number;
    emp_no: string;
    name: string;
    hotel_id: number;
    hotel_name: string;
    department_name: string;
    position: string;
    hire_date: string;
  }>(
    `SELECT e.*, h.name AS hotel_name, d.name AS department_name
     FROM employees e
     JOIN hotels h ON h.id = e.hotel_id
     JOIN departments d ON d.id = e.department_id
     WHERE e.id = ?`,
    [params.employeeId]
  );

  if (!emp) {
    throw new Error(`Employee ${params.employeeId} not found for archiving`);
  }

  const userRow = await tx.queryOne<{ id: number; username: string; role: string }>(
    'SELECT id, username, role FROM users WHERE employee_id = ?',
    [params.employeeId]
  );

  const lifecycleEvents = await tx.query<Record<string, unknown>>(
    `SELECT ev.*, fh.name AS from_hotel_name, th.name AS to_hotel_name, u.display_name AS operator_name
     FROM employee_lifecycle_events ev
     LEFT JOIN hotels fh ON fh.id = ev.from_hotel_id
     LEFT JOIN hotels th ON th.id = ev.to_hotel_id
     LEFT JOIN users u ON u.id = ev.operator_id
     WHERE ev.employee_id = ?
     ORDER BY ev.effective_date DESC, ev.id DESC`,
    [params.employeeId]
  );

  const reimbursements = userRow
    ? await tx.query<Record<string, unknown>>(
        `SELECT r.id, r.claim_no, r.title, r.expense_month, r.total_amount, r.net_pay_amount, r.status, r.created_at, r.paid_at, h.name AS hotel_name
         FROM reimbursements r
         JOIN hotels h ON h.id = r.hotel_id
         WHERE r.applicant_id = ?
         ORDER BY r.id DESC`,
        [userRow.id]
      )
    : [];

  const cashAdvances = userRow
    ? await tx.query<Record<string, unknown>>(
        `SELECT ca.id, ca.advance_no, ca.purpose, ca.amount, ca.offset_amount, (ca.amount - ca.offset_amount) AS remaining_amount, ca.status, ca.created_at, h.name AS hotel_name
         FROM cash_advances ca
         JOIN hotels h ON h.id = ca.hotel_id
         WHERE ca.applicant_id = ?
         ORDER BY ca.id DESC`,
        [userRow.id]
      )
    : [];

  const leaveRequests = await tx.query<Record<string, unknown>>(
    `SELECT lr.id, lr.request_no, lr.leave_type, lr.start_date, lr.end_date, lr.days, lr.hours, lr.reason, lr.status, lr.created_at
     FROM leave_requests lr
     WHERE lr.employee_id = ?
     ORDER BY lr.id DESC`,
    [params.employeeId]
  );

  const payrollRecords = await tx.query<Record<string, unknown>>(
    `SELECT pr.id, pr.\`year_month\`, pr.base_salary, pr.night_shifts, pr.night_allowance, pr.overtime_pay, pr.performance_bonus, pr.leave_deduction, pr.social_security, pr.gross_pay, pr.net_pay, pr.status
     FROM payroll_records pr
     WHERE pr.employee_id = ?
     ORDER BY pr.\`year_month\` DESC, pr.id DESC`,
    [params.employeeId]
  );

  const shiftSchedules = await tx.query<Record<string, unknown>>(
    `SELECT ss.id, ss.shift_date, ss.shift_type, h.name AS hotel_name
     FROM shift_schedules ss
     JOIN hotels h ON h.id = ss.assigned_hotel_id
     WHERE ss.employee_id = ?
     ORDER BY ss.shift_date DESC, ss.id DESC`,
    [params.employeeId]
  );

  const reimbursementTotal = roundMoney(
    reimbursements.reduce((sum, r) => sum + Number(r.total_amount || 0), 0)
  );
  const advanceTotal = roundMoney(
    cashAdvances.reduce((sum, a) => sum + Number(a.amount || 0), 0)
  );

  const summary = {
    eventCount: lifecycleEvents.length,
    reimbursementCount: reimbursements.length,
    reimbursementTotal,
    advanceCount: cashAdvances.length,
    advanceTotal,
    leaveCount: leaveRequests.length,
    payrollCount: payrollRecords.length,
    shiftCount: shiftSchedules.length,
  };

  const snapshot = {
    ...emp,
    username: userRow?.username ?? null,
    user_role: userRow?.role ?? null,
  };

  const records = {
    lifecycleEvents,
    reimbursements,
    cashAdvances,
    leaveRequests,
    payrollRecords,
    shiftSchedules,
  };

  const ts = nowIso();
  const existing = await tx.queryOne<{ id: number }>(
    'SELECT id FROM employee_archives WHERE employee_id = ?',
    [params.employeeId]
  );

  if (existing) {
    await tx.execute(
      `UPDATE employee_archives
       SET emp_no = ?, employee_name = ?, hotel_id = ?, hotel_name = ?, department_name = ?,
           position = ?, hire_date = ?, resign_date = ?, resign_reason = ?,
           offboarding_request_id = ?, employee_snapshot_json = ?, summary_json = ?,
           records_json = ?, archived_by = ?, archived_by_name = ?, archived_at = ?
       WHERE id = ?`,
      [
        emp.emp_no,
        emp.name,
        emp.hotel_id,
        emp.hotel_name,
        emp.department_name,
        emp.position,
        emp.hire_date,
        params.resignDate,
        params.resignReason,
        params.offboardingRequestId ?? null,
        JSON.stringify(snapshot),
        JSON.stringify(summary),
        JSON.stringify(records),
        params.operator.id,
        params.operator.display_name,
        ts,
        existing.id,
      ]
    );
    return existing.id;
  }

  const ins = await tx.execute(
    `INSERT INTO employee_archives (
      employee_id, emp_no, employee_name, hotel_id, hotel_name, department_name,
      position, hire_date, resign_date, resign_reason, offboarding_request_id,
      employee_snapshot_json, summary_json, records_json, archived_by, archived_by_name, archived_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      params.employeeId,
      emp.emp_no,
      emp.name,
      emp.hotel_id,
      emp.hotel_name,
      emp.department_name,
      emp.position,
      emp.hire_date,
      params.resignDate,
      params.resignReason,
      params.offboardingRequestId ?? null,
      JSON.stringify(snapshot),
      JSON.stringify(summary),
      JSON.stringify(records),
      params.operator.id,
      params.operator.display_name,
      ts,
    ]
  );
  return ins.insertId;
}
