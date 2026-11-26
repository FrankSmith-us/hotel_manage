import { Router } from 'express';
import { getDb } from '../../db';
import { asyncHandler, authenticate, getScopeFilter } from '../middleware/auth';
import { canUserActOnStep, isUserReturnTarget } from '../services/workflowEngine';
import { UserRole } from '../types';
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
    }>(`SELECT biz_type, biz_id, step_order, step_name, approver_role FROM approval_steps WHERE status = 'PENDING'`);

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
      if (st.approver_role !== user.role) continue;
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
        if (r && (await canUserActOnStep(db, user, st.approver_role, r.hotel_id, r.applicant_id))) {
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
        if (a && (await canUserActOnStep(db, user, st.approver_role, a.hotel_id, a.applicant_id))) {
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
          (await canUserActOnStep(db, user, st.approver_role, l.hotel_id, l.applicant_user_id ?? -1))
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
        if (hc && (await canUserActOnStep(db, user, st.approver_role, hc.hotel_id, hc.applicant_id))) {
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
      },
      expenseInbox: expenseInbox.slice(0, 8),
      otherInbox: otherInbox.slice(0, 8),
      inbox: inbox.slice(0, 10),
      complianceAlerts: alertEmployees,
      expenseTrend: trend,
      hotelBreakdown: hotelBreakdown.map((h) => ({
        hotel_name: h.hotel_name,
        total_amount: roundMoney(Number(h.total_amount)),
      })),
    });
  })
);

export default router;
