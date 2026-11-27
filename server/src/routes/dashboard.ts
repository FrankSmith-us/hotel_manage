import { Router } from 'express';
import { getDb } from '../../db';
import { asyncHandler, authenticate, getScopeFilter } from '../middleware/auth';
import {
  buildStatusDetail,
  canUserActOnStep,
  getUserLastHandledAction,
  getWorkflowStepsWithActors,
  isUserReturnTarget,
} from '../services/workflowEngine';
import { BizType, UserRole } from '../types';
import { addDays, currentYearMonth, offsetYearMonth, roundMoney, todayStr } from '../utils/numbers';

const router = Router();
router.use(authenticate);

router.get(
  '/summary',
  asyncHandler(async (req, res) => {
    const db = getDb();
    const user = req.user!;
    const scope = await getScopeFilter(user);
    const curYm = currentYearMonth();
    const today = todayStr();
    const alertEnd = addDays(today, 30);

    // 1. Build hotel scope condition
    let hotelWhere = '1=1';
    const hotelParams: unknown[] = [];
    if (scope.type === 'REGION') {
      if (scope.hotelIds.length === 0) {
        hotelWhere = '1=0';
      } else {
        hotelWhere = `hotel_id IN (${scope.hotelIds.map(() => '?').join(',')})`;
        hotelParams.push(...scope.hotelIds);
      }
    } else if (scope.type === 'HOTEL' || scope.type === 'SELF') {
      hotelWhere = 'hotel_id = ?';
      hotelParams.push(scope.hotelId);
    }

    // 2. Active headcount
    const empRow = await db.queryOne<{ cnt: number }>(
      `SELECT COUNT(*) AS cnt FROM employees WHERE status IN ('ACTIVE', 'PROBATION') AND ${hotelWhere}`,
      hotelParams
    );

    // 3. Compliance alerts (health cert / contract expiring <= 30d)
    const alertEmployees = await db.query<{
      id: number;
      emp_no: string;
      name: string;
      position: string;
      hotel_name: string;
      health_cert_expiry: string | null;
      contract_end_date: string | null;
    }>(
      `SELECT e.id, e.emp_no, e.name, e.position, h.name AS hotel_name, e.health_cert_expiry, e.contract_end_date
       FROM employees e
       JOIN hotels h ON h.id = e.hotel_id
       WHERE e.status IN ('ACTIVE', 'PROBATION')
         AND ${hotelWhere.replace(/hotel_id/g, 'e.hotel_id')}
         AND (
           (e.health_cert_expiry IS NOT NULL AND e.health_cert_expiry <= ?)
           OR (e.contract_end_date IS NOT NULL AND e.contract_end_date <= ?)
         )
       ORDER BY COALESCE(e.health_cert_expiry, e.contract_end_date) ASC
       LIMIT 10`,
      [...hotelParams, alertEnd, alertEnd]
    );

    // 4. Current month expense & budget
    const expRow = await db.queryOne<{ total_amt: number }>(
      `SELECT COALESCE(SUM(total_amount), 0) AS total_amt
       FROM reimbursements
       WHERE expense_month = ? AND status IN ('PENDING_APPROVAL', 'APPROVED', 'PAID') AND ${hotelWhere}`,
      [curYm, ...hotelParams]
    );
    const budgetRow = await db.queryOne<{ total_budget: number }>(
      `SELECT COALESCE(SUM(budget_amount), 0) AS total_budget
       FROM store_budgets
       WHERE \`year_month\` = ? AND ${hotelWhere}`,
      [curYm, ...hotelParams]
    );

    const monthlyExpense = roundMoney(Number(expRow?.total_amt || 0));
    const monthlyBudget = roundMoney(Number(budgetRow?.total_budget || 0));
    const budgetExecutionPct =
      monthlyBudget > 0 ? roundMoney((monthlyExpense / monthlyBudget) * 100) : 0;

    // 5. Pending my approvals across all 4 workflows
    const pendingSteps = await db.query<{
      biz_type: string;
      biz_id: number;
      step_order: number;
      step_name: string;
      approver_role: UserRole;
      approver_user_id: number | null;
    }>(
      `SELECT biz_type, biz_id, step_order, step_name, approver_role, approver_user_id
       FROM approval_steps WHERE status = 'PENDING'`
    );

    type InboxItem = {
      biz_type: string;
      biz_id: number;
      code: string;
      title: string;
      hotel_name: string;
      applicant_name: string;
      amount: number | null;
      step_name: string;
      risk_flags: string;
      urgency: 'NORMAL' | 'URGENT';
      created_at: string;
    };

    const expenseInbox: InboxItem[] = [];
    const otherInbox: InboxItem[] = [];

    for (const st of pendingSteps) {
      if (st.biz_type === 'REIMBURSEMENT') {
        const r = await db.queryOne<{
          id: number;
          claim_no: string;
          title: string;
          hotel_id: number;
          applicant_id: number;
          total_amount: number;
          risk_flags: string;
          urgency: string;
          created_at: string;
          hotel_name: string;
          applicant_name: string;
        }>(
          `SELECT r.id, r.claim_no, r.title, r.hotel_id, r.applicant_id, r.total_amount, r.risk_flags, r.urgency, r.created_at,
                  h.name AS hotel_name, u.display_name AS applicant_name
           FROM reimbursements r
           JOIN hotels h ON h.id = r.hotel_id
           JOIN users u ON u.id = r.applicant_id
           WHERE r.id = ? AND r.status = 'PENDING_APPROVAL'`,
          [st.biz_id]
        );
        if (
          r &&
          (await canUserActOnStep(db, user, st.approver_role, r.hotel_id, r.applicant_id, {
            approverUserId: st.approver_user_id,
            bizType: 'REIMBURSEMENT',
          }))
        ) {
          expenseInbox.push({
            biz_type: 'REIMBURSEMENT',
            biz_id: r.id,
            code: r.claim_no,
            title: r.title,
            hotel_name: r.hotel_name,
            applicant_name: r.applicant_name,
            amount: Number(r.total_amount),
            step_name: st.step_name,
            risk_flags: r.risk_flags || '',
            urgency: r.urgency === 'URGENT' ? 'URGENT' : 'NORMAL',
            created_at: r.created_at,
          });
        }
      } else if (st.biz_type === 'CASH_ADVANCE') {
        const a = await db.queryOne<{
          id: number;
          advance_no: string;
          purpose: string;
          hotel_id: number;
          applicant_id: number;
          amount: number;
          urgency: string;
          created_at: string;
          hotel_name: string;
          applicant_name: string;
        }>(
          `SELECT a.id, a.advance_no, a.purpose, a.hotel_id, a.applicant_id, a.amount, a.urgency, a.created_at,
                  h.name AS hotel_name, u.display_name AS applicant_name
           FROM cash_advances a
           JOIN hotels h ON h.id = a.hotel_id
           JOIN users u ON u.id = a.applicant_id
           WHERE a.id = ? AND a.status = 'PENDING_APPROVAL'`,
          [st.biz_id]
        );
        if (
          a &&
          (await canUserActOnStep(db, user, st.approver_role, a.hotel_id, a.applicant_id, {
            approverUserId: st.approver_user_id,
            bizType: 'CASH_ADVANCE',
          }))
        ) {
          expenseInbox.push({
            biz_type: 'CASH_ADVANCE',
            biz_id: a.id,
            code: a.advance_no,
            title: a.purpose,
            hotel_name: a.hotel_name,
            applicant_name: a.applicant_name,
            amount: Number(a.amount),
            step_name: st.step_name,
            risk_flags: '',
            urgency: a.urgency === 'URGENT' ? 'URGENT' : 'NORMAL',
            created_at: a.created_at,
          });
        }
      } else if (st.biz_type === 'LEAVE') {
        const l = await db.queryOne<{
          id: number;
          request_no: string;
          reason: string;
          hotel_id: number;
          applicant_user_id: number | null;
          urgency: string;
          created_at: string;
          hotel_name: string;
          emp_name: string;
        }>(
          `SELECT l.id, l.request_no, l.reason, l.hotel_id, u.id AS applicant_user_id, l.urgency, l.created_at,
                  h.name AS hotel_name, e.name AS emp_name
           FROM leave_requests l
           JOIN hotels h ON h.id = l.hotel_id
           JOIN employees e ON e.id = l.employee_id
           LEFT JOIN users u ON u.employee_id = e.id
           WHERE l.id = ? AND l.status = 'PENDING_APPROVAL'`,
          [st.biz_id]
        );
        if (
          l &&
          (await canUserActOnStep(db, user, st.approver_role, l.hotel_id, l.applicant_user_id ?? -1, {
            approverUserId: st.approver_user_id,
            bizType: 'LEAVE',
          }))
        ) {
          otherInbox.push({
            biz_type: 'LEAVE',
            biz_id: l.id,
            code: l.request_no,
            title: l.reason,
            hotel_name: l.hotel_name,
            applicant_name: l.emp_name,
            amount: null,
            step_name: st.step_name,
            risk_flags: '',
            urgency: l.urgency === 'URGENT' ? 'URGENT' : 'NORMAL',
            created_at: l.created_at,
          });
        }
      } else if (st.biz_type === 'HEADCOUNT') {
        const hc = await db.queryOne<{
          id: number;
          request_no: string;
          position: string;
          headcount: number;
          hotel_id: number;
          applicant_id: number;
          urgency: string;
          created_at: string;
          hotel_name: string;
          applicant_name: string;
        }>(
          `SELECT hc.id, hc.request_no, hc.position, hc.headcount, hc.hotel_id, hc.applicant_id, hc.urgency, hc.created_at,
                  h.name AS hotel_name, u.display_name AS applicant_name
           FROM headcount_requests hc
           JOIN hotels h ON h.id = hc.hotel_id
           JOIN users u ON u.id = hc.applicant_id
           WHERE hc.id = ? AND hc.status = 'PENDING_APPROVAL'`,
          [st.biz_id]
        );
        if (
          hc &&
          (await canUserActOnStep(db, user, st.approver_role, hc.hotel_id, hc.applicant_id, {
            approverUserId: st.approver_user_id,
            bizType: 'HEADCOUNT',
          }))
        ) {
          otherInbox.push({
            biz_type: 'HEADCOUNT',
            biz_id: hc.id,
            code: hc.request_no,
            title: `补编 ${hc.position} × ${hc.headcount}人`,
            hotel_name: hc.hotel_name,
            applicant_name: hc.applicant_name,
            amount: null,
            step_name: st.step_name,
            risk_flags: '',
            urgency: hc.urgency === 'URGENT' ? 'URGENT' : 'NORMAL',
            created_at: hc.created_at,
          });
        }
      } else if (st.biz_type === 'HOTEL_CLOSURE') {
        const c = await db.queryOne<{
          id: number;
          request_no: string;
          hotel_id: number;
          applicant_id: number;
          reason: string;
          created_at: string;
          hotel_name: string;
          applicant_name: string;
        }>(
          `SELECT c.id, c.request_no, c.hotel_id, c.applicant_id, c.reason, c.created_at,
                  h.name AS hotel_name, u.display_name AS applicant_name
           FROM hotel_closure_requests c
           JOIN hotels h ON h.id = c.hotel_id
           JOIN users u ON u.id = c.applicant_id
           WHERE c.id = ? AND c.status = 'PENDING_APPROVAL'`,
          [st.biz_id]
        );
        if (
          c &&
          (await canUserActOnStep(db, user, st.approver_role, c.hotel_id, c.applicant_id, {
            approverUserId: st.approver_user_id,
            bizType: 'HOTEL_CLOSURE',
          }))
        ) {
          otherInbox.push({
            biz_type: 'HOTEL_CLOSURE',
            biz_id: c.id,
            code: c.request_no,
            title: `关闭门店：${c.hotel_name}`,
            hotel_name: c.hotel_name,
            applicant_name: c.applicant_name,
            amount: null,
            step_name: st.step_name,
            risk_flags: '',
            urgency: 'NORMAL',
            created_at: c.created_at,
          });
        }
      } else if (st.biz_type === 'OFFBOARDING') {
        const o = await db.queryOne<{
          id: number;
          request_no: string;
          employee_id: number;
          hotel_id: number;
          applicant_id: number;
          created_at: string;
          employee_name: string;
          employee_position: string;
          hotel_name: string;
          applicant_name: string;
        }>(
          `SELECT off.id, off.request_no, off.employee_id, off.hotel_id, off.applicant_id, off.created_at,
                  e.name AS employee_name, e.position AS employee_position,
                  h.name AS hotel_name, u.display_name AS applicant_name
           FROM offboarding_requests off
           JOIN employees e ON e.id = off.employee_id
           JOIN hotels h ON h.id = off.hotel_id
           JOIN users u ON u.id = off.applicant_id
           WHERE off.id = ? AND off.status = 'PENDING_APPROVAL'`,
          [st.biz_id]
        );
        const isSelfOffboardingTarget = Boolean(user.employee_id && o && Number(user.employee_id) === Number(o.employee_id));
        if (
          o &&
          !isSelfOffboardingTarget &&
          (await canUserActOnStep(db, user, st.approver_role, o.hotel_id, o.applicant_id, {
            approverUserId: st.approver_user_id,
            bizType: 'OFFBOARDING',
          }))
        ) {
          otherInbox.push({
            biz_type: 'OFFBOARDING',
            biz_id: o.id,
            code: o.request_no,
            title: `离职申请：${o.employee_name}（${o.employee_position}）`,
            hotel_name: o.hotel_name,
            applicant_name: o.applicant_name,
            amount: null,
            step_name: st.step_name,
            risk_flags: '',
            urgency: 'NORMAL',
            created_at: o.created_at,
          });
        }
      } else if (st.biz_type === 'ONBOARDING') {
        const ob = await db.queryOne<{
          id: number;
          request_no: string;
          candidate_name: string;
          position: string;
          hotel_id: number;
          applicant_id: number;
          created_at: string;
          hotel_name: string;
          applicant_name: string;
        }>(
          `SELECT ob.id, ob.request_no, ob.candidate_name, ob.position, ob.hotel_id, ob.applicant_id, ob.created_at,
                  h.name AS hotel_name, u.display_name AS applicant_name
           FROM onboarding_requests ob
           JOIN hotels h ON h.id = ob.hotel_id
           JOIN users u ON u.id = ob.applicant_id
           WHERE ob.id = ? AND ob.status = 'PENDING_APPROVAL'`,
          [st.biz_id]
        );
        if (
          ob &&
          (await canUserActOnStep(db, user, st.approver_role, ob.hotel_id, ob.applicant_id, {
            approverUserId: st.approver_user_id,
            bizType: 'ONBOARDING',
          }))
        ) {
          otherInbox.push({
            biz_type: 'ONBOARDING',
            biz_id: ob.id,
            code: ob.request_no,
            title: `入职申请：${ob.candidate_name}（${ob.position}）`,
            hotel_name: ob.hotel_name,
            applicant_name: ob.applicant_name,
            amount: null,
            step_name: st.step_name,
            risk_flags: '',
            urgency: 'NORMAL',
            created_at: ob.created_at,
          });
        }
      } else if (st.biz_type === 'EMPLOYEE_CHANGE') {
        const ec = await db.queryOne<{
          id: number;
          request_no: string;
          change_type: string;
          from_hotel_id: number;
          applicant_id: number;
          created_at: string;
          employee_name: string;
          hotel_name: string;
          applicant_name: string;
        }>(
          `SELECT ec.id, ec.request_no, ec.change_type, ec.from_hotel_id, ec.applicant_id, ec.created_at,
                  e.name AS employee_name, h.name AS hotel_name, u.display_name AS applicant_name
           FROM employee_change_requests ec
           JOIN employees e ON e.id = ec.employee_id
           JOIN hotels h ON h.id = ec.from_hotel_id
           JOIN users u ON u.id = ec.applicant_id
           WHERE ec.id = ? AND ec.status = 'PENDING_APPROVAL'`,
          [st.biz_id]
        );
        if (
          ec &&
          (await canUserActOnStep(db, user, st.approver_role, ec.from_hotel_id, ec.applicant_id, {
            approverUserId: st.approver_user_id,
            bizType: 'EMPLOYEE_CHANGE',
          }))
        ) {
          otherInbox.push({
            biz_type: 'EMPLOYEE_CHANGE',
            biz_id: ec.id,
            code: ec.request_no,
            title: `人事异动：${ec.employee_name}（${ec.change_type}）`,
            hotel_name: ec.hotel_name,
            applicant_name: ec.applicant_name,
            amount: null,
            step_name: st.step_name,
            risk_flags: '',
            urgency: 'NORMAL',
            created_at: ec.created_at,
          });
        }
      } else if (st.biz_type === 'CONTRACT_RENEWAL') {
        const cr = await db.queryOne<{
          id: number;
          request_no: string;
          hotel_id: number;
          applicant_id: number;
          created_at: string;
          employee_name: string;
          hotel_name: string;
          applicant_name: string;
        }>(
          `SELECT cr.id, cr.request_no, cr.hotel_id, cr.applicant_id, cr.created_at,
                  e.name AS employee_name, h.name AS hotel_name, u.display_name AS applicant_name
           FROM contract_renewals cr
           JOIN employees e ON e.id = cr.employee_id
           JOIN hotels h ON h.id = cr.hotel_id
           JOIN users u ON u.id = cr.applicant_id
           WHERE cr.id = ? AND cr.status = 'PENDING_APPROVAL'`,
          [st.biz_id]
        );
        if (
          cr &&
          (await canUserActOnStep(db, user, st.approver_role, cr.hotel_id, cr.applicant_id, {
            approverUserId: st.approver_user_id,
            bizType: 'CONTRACT_RENEWAL',
          }))
        ) {
          otherInbox.push({
            biz_type: 'CONTRACT_RENEWAL',
            biz_id: cr.id,
            code: cr.request_no,
            title: `合同续签：${cr.employee_name}`,
            hotel_name: cr.hotel_name,
            applicant_name: cr.applicant_name,
            amount: null,
            step_name: st.step_name,
            risk_flags: '',
            urgency: 'NORMAL',
            created_at: cr.created_at,
          });
        }
      } else if (st.biz_type === 'OVERTIME') {
        const ot = await db.queryOne<{
          id: number;
          request_no: string;
          hotel_id: number;
          hours: number;
          applicant_user_id: number | null;
          created_at: string;
          emp_name: string;
          hotel_name: string;
        }>(
          `SELECT ot.id, ot.request_no, ot.hotel_id, ot.hours, u.id AS applicant_user_id, ot.created_at,
                  e.name AS emp_name, h.name AS hotel_name
           FROM overtime_requests ot
           JOIN employees e ON e.id = ot.employee_id
           JOIN hotels h ON h.id = ot.hotel_id
           LEFT JOIN users u ON u.employee_id = e.id
           WHERE ot.id = ? AND ot.status = 'PENDING_APPROVAL'`,
          [st.biz_id]
        );
        if (
          ot &&
          (await canUserActOnStep(db, user, st.approver_role, ot.hotel_id, ot.applicant_user_id ?? -1, {
            approverUserId: st.approver_user_id,
            bizType: 'OVERTIME',
          }))
        ) {
          otherInbox.push({
            biz_type: 'OVERTIME',
            biz_id: ot.id,
            code: ot.request_no,
            title: `加班申请：${ot.emp_name}（${ot.hours}h）`,
            hotel_name: ot.hotel_name,
            applicant_name: ot.emp_name,
            amount: null,
            step_name: st.step_name,
            risk_flags: '',
            urgency: 'NORMAL',
            created_at: ot.created_at,
          });
        }
      } else if (st.biz_type === 'ATTENDANCE_CORRECTION') {
        const ac = await db.queryOne<{
          id: number;
          request_no: string;
          hotel_id: number;
          attendance_date: string;
          applicant_user_id: number | null;
          created_at: string;
          emp_name: string;
          hotel_name: string;
        }>(
          `SELECT ac.id, ac.request_no, ac.hotel_id, ac.attendance_date, u.id AS applicant_user_id, ac.created_at,
                  e.name AS emp_name, h.name AS hotel_name
           FROM attendance_corrections ac
           JOIN employees e ON e.id = ac.employee_id
           JOIN hotels h ON h.id = ac.hotel_id
           LEFT JOIN users u ON u.employee_id = e.id
           WHERE ac.id = ? AND ac.status = 'PENDING_APPROVAL'`,
          [st.biz_id]
        );
        if (
          ac &&
          (await canUserActOnStep(db, user, st.approver_role, ac.hotel_id, ac.applicant_user_id ?? -1, {
            approverUserId: st.approver_user_id,
            bizType: 'ATTENDANCE_CORRECTION',
          }))
        ) {
          otherInbox.push({
            biz_type: 'ATTENDANCE_CORRECTION',
            biz_id: ac.id,
            code: ac.request_no,
            title: `考勤补卡：${ac.emp_name}（${ac.attendance_date}）`,
            hotel_name: ac.hotel_name,
            applicant_name: ac.emp_name,
            amount: null,
            step_name: st.step_name,
            risk_flags: '',
            urgency: 'NORMAL',
            created_at: ac.created_at,
          });
        }
      } else if (st.biz_type === 'SHIFT_SWAP') {
        const ss = await db.queryOne<{
          id: number;
          request_no: string;
          hotel_id: number;
          requester_shift_date: string;
          applicant_user_id: number | null;
          created_at: string;
          emp_name: string;
          hotel_name: string;
        }>(
          `SELECT ss.id, ss.request_no, ss.hotel_id, ss.requester_shift_date, u.id AS applicant_user_id, ss.created_at,
                  e.name AS emp_name, h.name AS hotel_name
           FROM shift_swap_requests ss
           JOIN employees e ON e.id = ss.requester_emp_id
           JOIN hotels h ON h.id = ss.hotel_id
           LEFT JOIN users u ON u.employee_id = e.id
           WHERE ss.id = ? AND ss.status = 'PENDING_APPROVAL'`,
          [st.biz_id]
        );
        if (
          ss &&
          (await canUserActOnStep(db, user, st.approver_role, ss.hotel_id, ss.applicant_user_id ?? -1, {
            approverUserId: st.approver_user_id,
            bizType: 'SHIFT_SWAP',
          }))
        ) {
          otherInbox.push({
            biz_type: 'SHIFT_SWAP',
            biz_id: ss.id,
            code: ss.request_no,
            title: `换班申请：${ss.emp_name}（${ss.requester_shift_date}）`,
            hotel_name: ss.hotel_name,
            applicant_name: ss.emp_name,
            amount: null,
            step_name: st.step_name,
            risk_flags: '',
            urgency: 'NORMAL',
            created_at: ss.created_at,
          });
        }
      } else if (st.biz_type === 'PAYROLL_BATCH') {
        const pb = await db.queryOne<{
          id: number;
          batch_no: string;
          year_month: string;
          hotel_id: number | null;
          submitted_by: number;
          total_employees: number;
          total_net: number;
          created_at: string;
          hotel_name: string | null;
          applicant_name: string;
        }>(
          `SELECT pb.id, pb.batch_no, pb.\`year_month\`, pb.hotel_id, pb.submitted_by, pb.total_employees, pb.total_net, pb.created_at,
                  h.name AS hotel_name, u.display_name AS applicant_name
           FROM payroll_batches pb
           LEFT JOIN hotels h ON h.id = pb.hotel_id
           JOIN users u ON u.id = pb.submitted_by
           WHERE pb.id = ? AND pb.status = 'PENDING_APPROVAL'`,
          [st.biz_id]
        );
        if (
          pb &&
          (await canUserActOnStep(db, user, st.approver_role, pb.hotel_id ?? 1, pb.submitted_by, {
            approverUserId: st.approver_user_id,
            bizType: 'PAYROLL_BATCH',
          }))
        ) {
          expenseInbox.push({
            biz_type: 'PAYROLL_BATCH',
            biz_id: pb.id,
            code: pb.batch_no,
            title: `薪资批次：${pb.year_month}（${pb.total_employees}人）`,
            hotel_name: pb.hotel_name || '全集团',
            applicant_name: pb.applicant_name,
            amount: Number(pb.total_net),
            step_name: st.step_name,
            risk_flags: '',
            urgency: 'NORMAL',
            created_at: pb.created_at,
          });
        }
      } else if (st.biz_type === 'VENDOR_PAYMENT') {
        const vp = await db.queryOne<{
          id: number;
          payment_no: string;
          hotel_id: number;
          applicant_id: number;
          amount: number;
          created_at: string;
          supplier_name: string;
          hotel_name: string;
          applicant_name: string;
        }>(
          `SELECT vp.id, vp.payment_no, vp.hotel_id, vp.applicant_id, vp.amount, vp.created_at,
                  s.name AS supplier_name, h.name AS hotel_name, u.display_name AS applicant_name
           FROM vendor_payments vp
           JOIN suppliers s ON s.id = vp.supplier_id
           JOIN hotels h ON h.id = vp.hotel_id
           JOIN users u ON u.id = vp.applicant_id
           WHERE vp.id = ? AND vp.status = 'PENDING_APPROVAL'`,
          [st.biz_id]
        );
        if (
          vp &&
          (await canUserActOnStep(db, user, st.approver_role, vp.hotel_id, vp.applicant_id, {
            approverUserId: st.approver_user_id,
            bizType: 'VENDOR_PAYMENT',
          }))
        ) {
          expenseInbox.push({
            biz_type: 'VENDOR_PAYMENT',
            biz_id: vp.id,
            code: vp.payment_no,
            title: `对公付款：${vp.supplier_name}`,
            hotel_name: vp.hotel_name,
            applicant_name: vp.applicant_name,
            amount: Number(vp.amount),
            step_name: st.step_name,
            risk_flags: '',
            urgency: 'NORMAL',
            created_at: vp.created_at,
          });
        }
      }
    }

    // 5b. Returned reimbursements waiting for current user to edit & resubmit
    const returnedClaims = await db.query<{
      id: number;
      claim_no: string;
      title: string;
      hotel_id: number;
      applicant_id: number;
      total_amount: number;
      risk_flags: string;
      urgency: string;
      status: string;
      returned_to_step: number | null;
      returned_to_user_id: number | null;
      returned_to_role: string | null;
      created_at: string;
      hotel_name: string;
      applicant_name: string;
    }>(
      `SELECT r.id, r.claim_no, r.title, r.hotel_id, r.applicant_id, r.total_amount, r.risk_flags, r.urgency, r.status,
              r.returned_to_step, r.returned_to_user_id, r.returned_to_role, r.created_at,
              h.name AS hotel_name, u.display_name AS applicant_name
       FROM reimbursements r
       JOIN hotels h ON h.id = r.hotel_id
       JOIN users u ON u.id = r.applicant_id
       WHERE r.status = 'RETURNED'`
    );
    for (const rc of returnedClaims) {
      if (await isUserReturnTarget(db, user, rc)) {
        expenseInbox.push({
          biz_type: 'REIMBURSEMENT',
          biz_id: rc.id,
          code: rc.claim_no,
          title: rc.title,
          hotel_name: rc.hotel_name,
          applicant_name: rc.applicant_name,
          amount: Number(rc.total_amount),
          step_name: '退回待修改',
          risk_flags: rc.risk_flags || '',
          urgency: rc.urgency === 'URGENT' ? 'URGENT' : 'NORMAL',
          created_at: rc.created_at,
        });
      }
    }

    const sortByUrgencyThenNewest = (a: InboxItem, b: InboxItem) => {
      if (a.urgency !== b.urgency) return a.urgency === 'URGENT' ? -1 : 1;
      return b.biz_id - a.biz_id;
    };
    expenseInbox.sort(sortByUrgencyThenNewest);
    otherInbox.sort(sortByUrgencyThenNewest);
    const inbox = [...expenseInbox, ...otherInbox];

    // 5c. Track "我申请的" & "我审批过的" across all 4 workflows with live status
    type TrackedWorkflowItem = {
      biz_type: BizType;
      biz_id: number;
      code: string;
      title: string;
      hotel_name: string;
      applicant_name: string;
      amount: number | null;
      status: string;
      status_detail: string;
      urgency: 'NORMAL' | 'URGENT';
      my_action?: string | null;
      my_acted_at?: string | null;
      created_at: string;
      updated_at: string;
    };

    const loadMyApplications = async (): Promise<TrackedWorkflowItem[]> => {
      const list: TrackedWorkflowItem[] = [];
      const myClaims = await db.query<{
        id: number;
        claim_no: string;
        title: string;
        total_amount: number;
        status: string;
        current_step: number;
        total_steps: number;
        urgency: string;
        payment_ref: string | null;
        created_at: string;
        updated_at: string;
        hotel_name: string;
        returned_to_name: string | null;
      }>(
        `SELECT r.id, r.claim_no, r.title, r.total_amount, r.status, r.current_step, r.total_steps,
                r.urgency, r.payment_ref, r.created_at, r.updated_at,
                h.name AS hotel_name, rt.display_name AS returned_to_name
         FROM reimbursements r
         JOIN hotels h ON h.id = r.hotel_id
         LEFT JOIN users rt ON rt.id = r.returned_to_user_id
         WHERE r.applicant_id = ?
         ORDER BY r.id DESC
         LIMIT 10`,
        [user.id]
      );
      for (const r of myClaims) {
        const pendingStep =
          r.status === 'PENDING_APPROVAL'
            ? await db.queryOne<{ step_name: string }>(
                `SELECT step_name FROM approval_steps WHERE biz_type = 'REIMBURSEMENT' AND biz_id = ? AND status = 'PENDING' ORDER BY step_order ASC LIMIT 1`,
                [r.id]
              )
            : null;
        list.push({
          biz_type: 'REIMBURSEMENT',
          biz_id: r.id,
          code: r.claim_no,
          title: r.title,
          hotel_name: r.hotel_name,
          applicant_name: user.display_name,
          amount: Number(r.total_amount),
          status: r.status,
          status_detail: buildStatusDetail({
            bizType: 'REIMBURSEMENT',
            status: r.status,
            currentStepName: pendingStep?.step_name ?? null,
            currentStep: r.current_step,
            totalSteps: r.total_steps,
            returnedToName: r.returned_to_name,
            paymentRef: r.payment_ref,
          }),
          urgency: r.urgency === 'URGENT' ? 'URGENT' : 'NORMAL',
          created_at: r.created_at,
          updated_at: r.updated_at,
        });
      }

      const myAdvances = await db.query<{
        id: number;
        advance_no: string;
        purpose: string;
        amount: number;
        status: string;
        current_step: number;
        urgency: string;
        payment_ref: string | null;
        created_at: string;
        updated_at: string;
        hotel_name: string;
      }>(
        `SELECT a.id, a.advance_no, a.purpose, a.amount, a.status, a.current_step, a.urgency, a.payment_ref,
                a.created_at, a.updated_at, h.name AS hotel_name
         FROM cash_advances a
         JOIN hotels h ON h.id = a.hotel_id
         WHERE a.applicant_id = ?
         ORDER BY a.id DESC
         LIMIT 10`,
        [user.id]
      );
      for (const a of myAdvances) {
        const steps = await getWorkflowStepsWithActors(db, 'CASH_ADVANCE', a.id);
        const pendingStep = steps.find((s) => s.status === 'PENDING');
        list.push({
          biz_type: 'CASH_ADVANCE',
          biz_id: a.id,
          code: a.advance_no,
          title: a.purpose,
          hotel_name: a.hotel_name,
          applicant_name: user.display_name,
          amount: Number(a.amount),
          status: a.status,
          status_detail: buildStatusDetail({
            bizType: 'CASH_ADVANCE',
            status: a.status,
            currentStepName: pendingStep?.step_name ?? null,
            currentStep: a.current_step,
            totalSteps: steps.length,
            paymentRef: a.payment_ref,
          }),
          urgency: a.urgency === 'URGENT' ? 'URGENT' : 'NORMAL',
          created_at: a.created_at,
          updated_at: a.updated_at,
        });
      }

      if (user.employee_id) {
        const myLeaves = await db.query<{
          id: number;
          request_no: string;
          reason: string;
          status: string;
          current_step: number;
          urgency: string;
          created_at: string;
          updated_at: string;
          hotel_name: string;
        }>(
          `SELECT l.id, l.request_no, l.reason, l.status, l.current_step, l.urgency, l.created_at, l.updated_at, h.name AS hotel_name
           FROM leave_requests l
           JOIN hotels h ON h.id = l.hotel_id
           WHERE l.employee_id = ?
           ORDER BY l.id DESC
           LIMIT 10`,
          [user.employee_id]
        );
        for (const l of myLeaves) {
          const steps = await getWorkflowStepsWithActors(db, 'LEAVE', l.id);
          const pendingStep = steps.find((s) => s.status === 'PENDING');
          list.push({
            biz_type: 'LEAVE',
            biz_id: l.id,
            code: l.request_no,
            title: l.reason,
            hotel_name: l.hotel_name,
            applicant_name: user.display_name,
            amount: null,
            status: l.status,
            status_detail: buildStatusDetail({
              bizType: 'LEAVE',
              status: l.status,
              currentStepName: pendingStep?.step_name ?? null,
              currentStep: l.current_step,
              totalSteps: steps.length,
            }),
            urgency: l.urgency === 'URGENT' ? 'URGENT' : 'NORMAL',
            created_at: l.created_at,
            updated_at: l.updated_at,
          });
        }
      }

      const myHcs = await db.query<{
        id: number;
        request_no: string;
        position: string;
        headcount: number;
        status: string;
        current_step: number;
        urgency: string;
        created_at: string;
        updated_at: string;
        hotel_name: string;
      }>(
        `SELECT hc.id, hc.request_no, hc.position, hc.headcount, hc.status, hc.current_step, hc.urgency,
                hc.created_at, hc.updated_at, h.name AS hotel_name
         FROM headcount_requests hc
         JOIN hotels h ON h.id = hc.hotel_id
         WHERE hc.applicant_id = ?
         ORDER BY hc.id DESC
         LIMIT 10`,
        [user.id]
      );
      for (const hc of myHcs) {
        const steps = await getWorkflowStepsWithActors(db, 'HEADCOUNT', hc.id);
        const pendingStep = steps.find((s) => s.status === 'PENDING');
        list.push({
          biz_type: 'HEADCOUNT',
          biz_id: hc.id,
          code: hc.request_no,
          title: `补编 ${hc.position} × ${hc.headcount}人`,
          hotel_name: hc.hotel_name,
          applicant_name: user.display_name,
          amount: null,
          status: hc.status,
          status_detail: buildStatusDetail({
            bizType: 'HEADCOUNT',
            status: hc.status,
            currentStepName: pendingStep?.step_name ?? null,
            currentStep: hc.current_step,
            totalSteps: steps.length,
          }),
          urgency: hc.urgency === 'URGENT' ? 'URGENT' : 'NORMAL',
          created_at: hc.created_at,
          updated_at: hc.updated_at,
        });
      }

      const myClosures = await db.query<{
        id: number;
        request_no: string;
        status: string;
        current_step: number;
        created_at: string;
        updated_at: string;
        hotel_name: string;
      }>(
        `SELECT c.id, c.request_no, c.status, c.current_step, c.created_at, c.updated_at, h.name AS hotel_name
         FROM hotel_closure_requests c
         JOIN hotels h ON h.id = c.hotel_id
         WHERE c.applicant_id = ?
         ORDER BY c.id DESC
         LIMIT 10`,
        [user.id]
      );
      for (const c of myClosures) {
        const steps = await getWorkflowStepsWithActors(db, 'HOTEL_CLOSURE', c.id);
        const pendingStep = steps.find((s) => s.status === 'PENDING');
        list.push({
          biz_type: 'HOTEL_CLOSURE',
          biz_id: c.id,
          code: c.request_no,
          title: `关闭门店：${c.hotel_name}`,
          hotel_name: c.hotel_name,
          applicant_name: user.display_name,
          amount: null,
          status: c.status,
          status_detail: buildStatusDetail({
            bizType: 'HOTEL_CLOSURE',
            status: c.status,
            currentStepName: pendingStep?.step_name ?? null,
            currentStep: c.current_step,
            totalSteps: steps.length,
          }),
          urgency: 'NORMAL',
          created_at: c.created_at,
          updated_at: c.updated_at,
        });
      }

      const myOnboardings = await db.query<{
        id: number;
        request_no: string;
        candidate_name: string;
        position: string;
        status: string;
        current_step: number;
        created_at: string;
        updated_at: string;
        hotel_name: string;
      }>(
        `SELECT ob.id, ob.request_no, ob.candidate_name, ob.position, ob.status, ob.current_step,
                ob.created_at, ob.updated_at, h.name AS hotel_name
         FROM onboarding_requests ob
         JOIN hotels h ON h.id = ob.hotel_id
         WHERE ob.applicant_id = ?
         ORDER BY ob.id DESC
         LIMIT 10`,
        [user.id]
      );
      for (const ob of myOnboardings) {
        const steps = await getWorkflowStepsWithActors(db, 'ONBOARDING', ob.id);
        const pendingStep = steps.find((s) => s.status === 'PENDING');
        list.push({
          biz_type: 'ONBOARDING',
          biz_id: ob.id,
          code: ob.request_no,
          title: `入职申请：${ob.candidate_name}（${ob.position}）`,
          hotel_name: ob.hotel_name,
          applicant_name: user.display_name,
          amount: null,
          status: ob.status,
          status_detail: buildStatusDetail({
            bizType: 'ONBOARDING',
            status: ob.status,
            currentStepName: pendingStep?.step_name ?? null,
            currentStep: ob.current_step,
            totalSteps: steps.length,
          }),
          urgency: 'NORMAL',
          created_at: ob.created_at,
          updated_at: ob.updated_at,
        });
      }

      const myOffboardings = await db.query<{
        id: number;
        request_no: string;
        status: string;
        current_step: number;
        created_at: string;
        updated_at: string;
        employee_name: string;
        employee_position: string;
        hotel_name: string;
        applicant_name: string;
      }>(
        `SELECT off.id, off.request_no, off.status, off.current_step, off.created_at, off.updated_at,
                e.name AS employee_name, e.position AS employee_position,
                h.name AS hotel_name, u.display_name AS applicant_name
         FROM offboarding_requests off
         JOIN employees e ON e.id = off.employee_id
         JOIN hotels h ON h.id = off.hotel_id
         JOIN users u ON u.id = off.applicant_id
         WHERE off.applicant_id = ? OR off.employee_id = ?
         ORDER BY off.id DESC
         LIMIT 10`,
        [user.id, user.employee_id ?? -1]
      );
      for (const off of myOffboardings) {
        const steps = await getWorkflowStepsWithActors(db, 'OFFBOARDING', off.id);
        const pendingStep = steps.find((s) => s.status === 'PENDING');
        list.push({
          biz_type: 'OFFBOARDING',
          biz_id: off.id,
          code: off.request_no,
          title: `离职申请：${off.employee_name}（${off.employee_position}）`,
          hotel_name: off.hotel_name,
          applicant_name: off.applicant_name,
          amount: null,
          status: off.status,
          status_detail: buildStatusDetail({
            bizType: 'OFFBOARDING',
            status: off.status,
            currentStepName: pendingStep?.step_name ?? null,
            currentStep: off.current_step,
            totalSteps: steps.length,
          }),
          urgency: 'NORMAL',
          created_at: off.created_at,
          updated_at: off.updated_at,
        });
      }

      list.sort((a, b) => b.updated_at.localeCompare(a.updated_at) || b.biz_id - a.biz_id);
      return list.slice(0, 20);
    };

    const loadMyHandledApprovals = async (): Promise<TrackedWorkflowItem[]> => {
      const list: TrackedWorkflowItem[] = [];
      const handledClaims = await db.query<{
        id: number;
        claim_no: string;
        title: string;
        total_amount: number;
        status: string;
        current_step: number;
        total_steps: number;
        urgency: string;
        payment_ref: string | null;
        created_at: string;
        updated_at: string;
        hotel_name: string;
        applicant_name: string;
        returned_to_name: string | null;
      }>(
        `SELECT r.id, r.claim_no, r.title, r.total_amount, r.status, r.current_step, r.total_steps,
                r.urgency, r.payment_ref, r.created_at, r.updated_at,
                h.name AS hotel_name, u.display_name AS applicant_name, rt.display_name AS returned_to_name
         FROM reimbursements r
         JOIN hotels h ON h.id = r.hotel_id
         JOIN users u ON u.id = r.applicant_id
         LEFT JOIN users rt ON rt.id = r.returned_to_user_id
         WHERE EXISTS (SELECT 1 FROM approval_steps s WHERE s.biz_type = 'REIMBURSEMENT' AND s.biz_id = r.id AND s.acted_by = ?)
            OR EXISTS (SELECT 1 FROM approval_logs l WHERE l.biz_type = 'REIMBURSEMENT' AND l.biz_id = r.id AND l.actor_id = ? AND l.action IN ('APPROVE', 'RETURN', 'REJECT', 'PAY'))
         ORDER BY r.id DESC
         LIMIT 10`,
        [user.id, user.id]
      );
      for (const r of handledClaims) {
        const pendingStep =
          r.status === 'PENDING_APPROVAL'
            ? await db.queryOne<{ step_name: string }>(
                `SELECT step_name FROM approval_steps WHERE biz_type = 'REIMBURSEMENT' AND biz_id = ? AND status = 'PENDING' ORDER BY step_order ASC LIMIT 1`,
                [r.id]
              )
            : null;
        const act = await getUserLastHandledAction(db, 'REIMBURSEMENT', r.id, user.id);
        list.push({
          biz_type: 'REIMBURSEMENT',
          biz_id: r.id,
          code: r.claim_no,
          title: r.title,
          hotel_name: r.hotel_name,
          applicant_name: r.applicant_name,
          amount: Number(r.total_amount),
          status: r.status,
          status_detail: buildStatusDetail({
            bizType: 'REIMBURSEMENT',
            status: r.status,
            currentStepName: pendingStep?.step_name ?? null,
            currentStep: r.current_step,
            totalSteps: r.total_steps,
            returnedToName: r.returned_to_name,
            paymentRef: r.payment_ref,
          }),
          urgency: r.urgency === 'URGENT' ? 'URGENT' : 'NORMAL',
          my_action: act.my_last_action,
          my_acted_at: act.my_acted_at,
          created_at: r.created_at,
          updated_at: r.updated_at,
        });
      }

      const handledAdvances = await db.query<{
        id: number;
        advance_no: string;
        purpose: string;
        amount: number;
        status: string;
        current_step: number;
        urgency: string;
        payment_ref: string | null;
        created_at: string;
        updated_at: string;
        hotel_name: string;
        applicant_name: string;
      }>(
        `SELECT a.id, a.advance_no, a.purpose, a.amount, a.status, a.current_step, a.urgency, a.payment_ref,
                a.created_at, a.updated_at, h.name AS hotel_name, u.display_name AS applicant_name
         FROM cash_advances a
         JOIN hotels h ON h.id = a.hotel_id
         JOIN users u ON u.id = a.applicant_id
         WHERE EXISTS (SELECT 1 FROM approval_steps s WHERE s.biz_type = 'CASH_ADVANCE' AND s.biz_id = a.id AND s.acted_by = ?)
            OR EXISTS (SELECT 1 FROM approval_logs l WHERE l.biz_type = 'CASH_ADVANCE' AND l.biz_id = a.id AND l.actor_id = ? AND l.action IN ('APPROVE', 'REJECT', 'DISBURSE'))
         ORDER BY a.id DESC
         LIMIT 10`,
        [user.id, user.id]
      );
      for (const a of handledAdvances) {
        const steps = await getWorkflowStepsWithActors(db, 'CASH_ADVANCE', a.id);
        const pendingStep = steps.find((s) => s.status === 'PENDING');
        const act = await getUserLastHandledAction(db, 'CASH_ADVANCE', a.id, user.id);
        list.push({
          biz_type: 'CASH_ADVANCE',
          biz_id: a.id,
          code: a.advance_no,
          title: a.purpose,
          hotel_name: a.hotel_name,
          applicant_name: a.applicant_name,
          amount: Number(a.amount),
          status: a.status,
          status_detail: buildStatusDetail({
            bizType: 'CASH_ADVANCE',
            status: a.status,
            currentStepName: pendingStep?.step_name ?? null,
            currentStep: a.current_step,
            totalSteps: steps.length,
            paymentRef: a.payment_ref,
          }),
          urgency: a.urgency === 'URGENT' ? 'URGENT' : 'NORMAL',
          my_action: act.my_last_action,
          my_acted_at: act.my_acted_at,
          created_at: a.created_at,
          updated_at: a.updated_at,
        });
      }

      const handledLeaves = await db.query<{
        id: number;
        request_no: string;
        reason: string;
        status: string;
        current_step: number;
        urgency: string;
        created_at: string;
        updated_at: string;
        hotel_name: string;
        emp_name: string;
      }>(
        `SELECT l.id, l.request_no, l.reason, l.status, l.current_step, l.urgency, l.created_at, l.updated_at,
                h.name AS hotel_name, e.name AS emp_name
         FROM leave_requests l
         JOIN hotels h ON h.id = l.hotel_id
         JOIN employees e ON e.id = l.employee_id
         WHERE EXISTS (SELECT 1 FROM approval_steps s WHERE s.biz_type = 'LEAVE' AND s.biz_id = l.id AND s.acted_by = ?)
            OR EXISTS (SELECT 1 FROM approval_logs al WHERE al.biz_type = 'LEAVE' AND al.biz_id = l.id AND al.actor_id = ? AND al.action IN ('APPROVE', 'REJECT'))
         ORDER BY l.id DESC
         LIMIT 10`,
        [user.id, user.id]
      );
      for (const l of handledLeaves) {
        const steps = await getWorkflowStepsWithActors(db, 'LEAVE', l.id);
        const pendingStep = steps.find((s) => s.status === 'PENDING');
        const act = await getUserLastHandledAction(db, 'LEAVE', l.id, user.id);
        list.push({
          biz_type: 'LEAVE',
          biz_id: l.id,
          code: l.request_no,
          title: l.reason,
          hotel_name: l.hotel_name,
          applicant_name: l.emp_name,
          amount: null,
          status: l.status,
          status_detail: buildStatusDetail({
            bizType: 'LEAVE',
            status: l.status,
            currentStepName: pendingStep?.step_name ?? null,
            currentStep: l.current_step,
            totalSteps: steps.length,
          }),
          urgency: l.urgency === 'URGENT' ? 'URGENT' : 'NORMAL',
          my_action: act.my_last_action,
          my_acted_at: act.my_acted_at,
          created_at: l.created_at,
          updated_at: l.updated_at,
        });
      }

      const handledHcs = await db.query<{
        id: number;
        request_no: string;
        position: string;
        headcount: number;
        status: string;
        current_step: number;
        urgency: string;
        created_at: string;
        updated_at: string;
        hotel_name: string;
        applicant_name: string;
      }>(
        `SELECT hc.id, hc.request_no, hc.position, hc.headcount, hc.status, hc.current_step, hc.urgency,
                hc.created_at, hc.updated_at, h.name AS hotel_name, u.display_name AS applicant_name
         FROM headcount_requests hc
         JOIN hotels h ON h.id = hc.hotel_id
         JOIN users u ON u.id = hc.applicant_id
         WHERE EXISTS (SELECT 1 FROM approval_steps s WHERE s.biz_type = 'HEADCOUNT' AND s.biz_id = hc.id AND s.acted_by = ?)
            OR EXISTS (SELECT 1 FROM approval_logs l WHERE l.biz_type = 'HEADCOUNT' AND l.biz_id = hc.id AND l.actor_id = ? AND l.action IN ('APPROVE', 'REJECT'))
         ORDER BY hc.id DESC
         LIMIT 10`,
        [user.id, user.id]
      );
      for (const hc of handledHcs) {
        const steps = await getWorkflowStepsWithActors(db, 'HEADCOUNT', hc.id);
        const pendingStep = steps.find((s) => s.status === 'PENDING');
        const act = await getUserLastHandledAction(db, 'HEADCOUNT', hc.id, user.id);
        list.push({
          biz_type: 'HEADCOUNT',
          biz_id: hc.id,
          code: hc.request_no,
          title: `补编 ${hc.position} × ${hc.headcount}人`,
          hotel_name: hc.hotel_name,
          applicant_name: hc.applicant_name,
          amount: null,
          status: hc.status,
          status_detail: buildStatusDetail({
            bizType: 'HEADCOUNT',
            status: hc.status,
            currentStepName: pendingStep?.step_name ?? null,
            currentStep: hc.current_step,
            totalSteps: steps.length,
          }),
          urgency: hc.urgency === 'URGENT' ? 'URGENT' : 'NORMAL',
          my_action: act.my_last_action,
          my_acted_at: act.my_acted_at,
          created_at: hc.created_at,
          updated_at: hc.updated_at,
        });
      }

      const handledClosures = await db.query<{
        id: number;
        request_no: string;
        status: string;
        current_step: number;
        created_at: string;
        updated_at: string;
        hotel_name: string;
        applicant_name: string;
      }>(
        `SELECT c.id, c.request_no, c.status, c.current_step, c.created_at, c.updated_at,
                h.name AS hotel_name, u.display_name AS applicant_name
         FROM hotel_closure_requests c
         JOIN hotels h ON h.id = c.hotel_id
         JOIN users u ON u.id = c.applicant_id
         WHERE EXISTS (SELECT 1 FROM approval_steps s WHERE s.biz_type = 'HOTEL_CLOSURE' AND s.biz_id = c.id AND s.acted_by = ?)
            OR EXISTS (SELECT 1 FROM approval_logs l WHERE l.biz_type = 'HOTEL_CLOSURE' AND l.biz_id = c.id AND l.actor_id = ? AND l.action IN ('APPROVE', 'REJECT'))
         ORDER BY c.id DESC
         LIMIT 10`,
        [user.id, user.id]
      );
      for (const c of handledClosures) {
        const steps = await getWorkflowStepsWithActors(db, 'HOTEL_CLOSURE', c.id);
        const pendingStep = steps.find((s) => s.status === 'PENDING');
        const act = await getUserLastHandledAction(db, 'HOTEL_CLOSURE', c.id, user.id);
        list.push({
          biz_type: 'HOTEL_CLOSURE',
          biz_id: c.id,
          code: c.request_no,
          title: `关闭门店：${c.hotel_name}`,
          hotel_name: c.hotel_name,
          applicant_name: c.applicant_name,
          amount: null,
          status: c.status,
          status_detail: buildStatusDetail({
            bizType: 'HOTEL_CLOSURE',
            status: c.status,
            currentStepName: pendingStep?.step_name ?? null,
            currentStep: c.current_step,
            totalSteps: steps.length,
          }),
          urgency: 'NORMAL',
          my_action: act.my_last_action,
          my_acted_at: act.my_acted_at,
          created_at: c.created_at,
          updated_at: c.updated_at,
        });
      }

      const handledOnboardings = await db.query<{
        id: number;
        request_no: string;
        candidate_name: string;
        position: string;
        status: string;
        current_step: number;
        created_at: string;
        updated_at: string;
        hotel_name: string;
        applicant_name: string;
      }>(
        `SELECT ob.id, ob.request_no, ob.candidate_name, ob.position, ob.status, ob.current_step,
                ob.created_at, ob.updated_at, h.name AS hotel_name, u.display_name AS applicant_name
         FROM onboarding_requests ob
         JOIN hotels h ON h.id = ob.hotel_id
         JOIN users u ON u.id = ob.applicant_id
         WHERE EXISTS (SELECT 1 FROM approval_steps s WHERE s.biz_type = 'ONBOARDING' AND s.biz_id = ob.id AND s.acted_by = ?)
            OR EXISTS (SELECT 1 FROM approval_logs l WHERE l.biz_type = 'ONBOARDING' AND l.biz_id = ob.id AND l.actor_id = ? AND l.action IN ('APPROVE', 'REJECT'))
         ORDER BY ob.id DESC
         LIMIT 10`,
        [user.id, user.id]
      );
      for (const ob of handledOnboardings) {
        const steps = await getWorkflowStepsWithActors(db, 'ONBOARDING', ob.id);
        const pendingStep = steps.find((s) => s.status === 'PENDING');
        const act = await getUserLastHandledAction(db, 'ONBOARDING', ob.id, user.id);
        list.push({
          biz_type: 'ONBOARDING',
          biz_id: ob.id,
          code: ob.request_no,
          title: `入职申请：${ob.candidate_name}（${ob.position}）`,
          hotel_name: ob.hotel_name,
          applicant_name: ob.applicant_name,
          amount: null,
          status: ob.status,
          status_detail: buildStatusDetail({
            bizType: 'ONBOARDING',
            status: ob.status,
            currentStepName: pendingStep?.step_name ?? null,
            currentStep: ob.current_step,
            totalSteps: steps.length,
          }),
          urgency: 'NORMAL',
          my_action: act.my_last_action,
          my_acted_at: act.my_acted_at,
          created_at: ob.created_at,
          updated_at: ob.updated_at,
        });
      }

      const handledOffboardings = await db.query<{
        id: number;
        request_no: string;
        status: string;
        current_step: number;
        created_at: string;
        updated_at: string;
        employee_name: string;
        employee_position: string;
        hotel_name: string;
        applicant_name: string;
      }>(
        `SELECT off.id, off.request_no, off.status, off.current_step, off.created_at, off.updated_at,
                e.name AS employee_name, e.position AS employee_position,
                h.name AS hotel_name, u.display_name AS applicant_name
         FROM offboarding_requests off
         JOIN employees e ON e.id = off.employee_id
         JOIN hotels h ON h.id = off.hotel_id
         JOIN users u ON u.id = off.applicant_id
         WHERE EXISTS (SELECT 1 FROM approval_steps s WHERE s.biz_type = 'OFFBOARDING' AND s.biz_id = off.id AND s.acted_by = ?)
            OR EXISTS (SELECT 1 FROM approval_logs l WHERE l.biz_type = 'OFFBOARDING' AND l.biz_id = off.id AND l.actor_id = ? AND l.action IN ('APPROVE', 'REJECT'))
         ORDER BY off.id DESC
         LIMIT 10`,
        [user.id, user.id]
      );
      for (const off of handledOffboardings) {
        const steps = await getWorkflowStepsWithActors(db, 'OFFBOARDING', off.id);
        const pendingStep = steps.find((s) => s.status === 'PENDING');
        const act = await getUserLastHandledAction(db, 'OFFBOARDING', off.id, user.id);
        list.push({
          biz_type: 'OFFBOARDING',
          biz_id: off.id,
          code: off.request_no,
          title: `离职申请：${off.employee_name}（${off.employee_position}）`,
          hotel_name: off.hotel_name,
          applicant_name: off.applicant_name,
          amount: null,
          status: off.status,
          status_detail: buildStatusDetail({
            bizType: 'OFFBOARDING',
            status: off.status,
            currentStepName: pendingStep?.step_name ?? null,
            currentStep: off.current_step,
            totalSteps: steps.length,
          }),
          urgency: 'NORMAL',
          my_action: act.my_last_action,
          my_acted_at: act.my_acted_at,
          created_at: off.created_at,
          updated_at: off.updated_at,
        });
      }

      list.sort((a, b) => (b.my_acted_at || b.updated_at).localeCompare(a.my_acted_at || a.updated_at) || b.biz_id - a.biz_id);
      return list.slice(0, 20);
    };

    const myApplications = await loadMyApplications();
    const myHandledApprovals = await loadMyHandledApprovals();

    // 6. 6-month expense trend
    const months = [-5, -4, -3, -2, -1, 0].map((d) => offsetYearMonth(curYm, d));
    const trend: Array<{ month: string; paid: number; pending: number }> = [];
    for (const m of months) {
      const row = await db.queryOne<{ paid_amt: number; pending_amt: number }>(
        `SELECT
           COALESCE(SUM(CASE WHEN status = 'PAID' THEN total_amount ELSE 0 END), 0) AS paid_amt,
           COALESCE(SUM(CASE WHEN status IN ('PENDING_APPROVAL', 'APPROVED') THEN total_amount ELSE 0 END), 0) AS pending_amt
         FROM reimbursements
         WHERE expense_month = ? AND ${hotelWhere}`,
        [m, ...hotelParams]
      );
      trend.push({
        month: m,
        paid: roundMoney(Number(row?.paid_amt || 0)),
        pending: roundMoney(Number(row?.pending_amt || 0)),
      });
    }

    // 7. Hotel comparison for current month
    const hotelBreakdown = await db.query<{ hotel_name: string; total_amount: number }>(
      `SELECT h.name AS hotel_name, COALESCE(SUM(r.total_amount), 0) AS total_amount
       FROM hotels h
       LEFT JOIN reimbursements r
         ON r.hotel_id = h.id
        AND r.expense_month = ?
        AND r.status IN ('PENDING_APPROVAL', 'APPROVED', 'PAID')
       WHERE ${hotelWhere.replace(/hotel_id/g, 'h.id')}
       GROUP BY h.id, h.name
       ORDER BY total_amount DESC`,
      [curYm, ...hotelParams]
    );

    const overdueAdvances = await db.query<{
      id: number;
      advance_no: string;
      purpose: string;
      amount: number;
      offset_amount: number;
      repaid_amount: number;
      expected_settle_date: string;
      hotel_name: string;
      applicant_name: string;
    }>(
      `SELECT a.id, a.advance_no, a.purpose, a.amount, a.offset_amount, a.repaid_amount,
              a.expected_settle_date, h.name AS hotel_name, u.display_name AS applicant_name
       FROM cash_advances a
       JOIN hotels h ON h.id = a.hotel_id
       JOIN users u ON u.id = a.applicant_id
       WHERE a.status = 'DISBURSED' AND a.expected_settle_date < ?
         AND ${hotelWhere.replace(/hotel_id/g, 'a.hotel_id')}
       ORDER BY a.expected_settle_date ASC`,
      [today, ...hotelParams]
    );

    res.json({
      yearMonth: curYm,
      kpis: {
        pendingApprovalsCount: inbox.length,
        pendingExpenseCount: expenseInbox.length,
        urgentExpenseCount: expenseInbox.filter((i) => i.urgency === 'URGENT').length,
        pendingOtherCount: otherInbox.length,
        urgentOtherCount: otherInbox.filter((i) => i.urgency === 'URGENT').length,
        monthlyExpense,
        monthlyBudget,
        budgetExecutionPct,
        activeHeadcount: Number(empRow?.cnt || 0),
        complianceAlertsCount: alertEmployees.length,
        overdueAdvanceCount: overdueAdvances.length,
        myApplicationsCount: myApplications.length,
        myHandledCount: myHandledApprovals.length,
      },
      expenseInbox: expenseInbox.slice(0, 8),
      otherInbox: otherInbox.slice(0, 8),
      inbox: inbox.slice(0, 10),
      myApplications,
      myHandledApprovals,
      complianceAlerts: alertEmployees,
      overdueAdvances,
      expenseTrend: trend,
      hotelBreakdown: hotelBreakdown.map((h) => ({
        hotel_name: h.hotel_name,
        total_amount: roundMoney(Number(h.total_amount)),
      })),
    });
  })
);

export default router;
