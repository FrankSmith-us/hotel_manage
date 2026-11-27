import { Router } from 'express';
import { getDb } from '../../db';
import { asyncHandler, authenticate, buildHotelScopeSql, getScopeFilter, requireRoles } from '../middleware/auth';
import { EXPENSE_CATEGORY_LABELS, ExpenseCategory } from '../types';
import { buildCsv } from '../utils/csv';
import { currentYearMonth, offsetYearMonth, roundMoney } from '../utils/numbers';

const router = Router();
router.use(authenticate);

router.get(
  '/expenses',
  asyncHandler(async (req, res) => {
    const db = getDb();
    const yearMonth = String(req.query.yearMonth || currentYearMonth());
    const scope = await getScopeFilter(req.user!);

    let hotelWhere = '1=1';
    const hotelParams: unknown[] = [];
    if (scope.type === 'REGION') {
      if (scope.hotelIds.length === 0) {
        res.json({ yearMonth, byHotel: [], byCategory: [], trend: [] });
        return;
      }
      hotelWhere = `r.hotel_id IN (${scope.hotelIds.map(() => '?').join(',')})`;
      hotelParams.push(...scope.hotelIds);
    } else if (scope.type === 'HOTEL' || scope.type === 'SELF') {
      hotelWhere = 'r.hotel_id = ?';
      hotelParams.push(scope.hotelId);
    }

    const byHotel = await db.query<{
      hotel_id: number;
      hotel_name: string;
      paid_amount: number;
      pending_amount: number;
      claim_count: number;
    }>(
      `SELECT h.id AS hotel_id, h.name AS hotel_name,
              COALESCE(SUM(CASE WHEN r.status = 'PAID' THEN r.total_amount ELSE 0 END), 0) AS paid_amount,
              COALESCE(SUM(CASE WHEN r.status IN ('PENDING_APPROVAL', 'APPROVED') THEN r.total_amount ELSE 0 END), 0) AS pending_amount,
              COUNT(r.id) AS claim_count
       FROM hotels h
       LEFT JOIN reimbursements r
         ON r.hotel_id = h.id
        AND r.expense_month = ?
        AND r.status IN ('PENDING_APPROVAL', 'APPROVED', 'PAID')
       WHERE ${hotelWhere.replace(/r\.hotel_id/g, 'h.id')}
       GROUP BY h.id, h.name
       ORDER BY (paid_amount + pending_amount) DESC`,
      [yearMonth, ...hotelParams]
    );

    const byCategoryRaw = await db.query<{ category: ExpenseCategory; total_amount: number }>(
      `SELECT ri.category, COALESCE(SUM(ri.amount), 0) AS total_amount
       FROM reimbursement_items ri
       JOIN reimbursements r ON r.id = ri.reimbursement_id
       WHERE r.expense_month = ?
         AND r.status IN ('PENDING_APPROVAL', 'APPROVED', 'PAID')
         AND ${hotelWhere}
       GROUP BY ri.category
       ORDER BY total_amount DESC`,
      [yearMonth, ...hotelParams]
    );

    const months = [-5, -4, -3, -2, -1, 0].map((d) => offsetYearMonth(yearMonth, d));
    const trend = [];
    for (const m of months) {
      const row = await db.queryOne<{ total_amt: number }>(
        `SELECT COALESCE(SUM(r.total_amount), 0) AS total_amt
         FROM reimbursements r
         WHERE r.expense_month = ?
           AND r.status IN ('PENDING_APPROVAL', 'APPROVED', 'PAID')
           AND ${hotelWhere}`,
        [m, ...hotelParams]
      );
      trend.push({ month: m, total_amount: roundMoney(Number(row?.total_amt || 0)) });
    }

    res.json({
      yearMonth,
      byHotel: byHotel.map((h) => ({
        ...h,
        paid_amount: roundMoney(Number(h.paid_amount)),
        pending_amount: roundMoney(Number(h.pending_amount)),
        total_amount: roundMoney(Number(h.paid_amount) + Number(h.pending_amount)),
      })),
      byCategory: byCategoryRaw.map((c) => ({
        category: c.category,
        category_label: EXPENSE_CATEGORY_LABELS[c.category] || c.category,
        total_amount: roundMoney(Number(c.total_amount)),
      })),
      trend,
    });
  })
);

router.get(
  '/expenses/export',
  requireRoles('HQ_ADMIN', 'FINANCE', 'GENERAL_MANAGER', 'REGIONAL_MANAGER', 'STORE_MANAGER'),
  asyncHandler(async (req, res) => {
    const db = getDb();
    const yearMonth = String(req.query.yearMonth || currentYearMonth());
    const scope = await getScopeFilter(req.user!);
    const scopeSql = buildHotelScopeSql(scope, 'r.hotel_id');
    const rows = await db.query<{
      hotel_name: string;
      category: ExpenseCategory;
      total_amount: number;
    }>(
      `SELECT h.name AS hotel_name, ri.category, COALESCE(SUM(ri.amount), 0) AS total_amount
       FROM reimbursement_items ri
       JOIN reimbursements r ON r.id = ri.reimbursement_id
       JOIN hotels h ON h.id = r.hotel_id
       WHERE r.expense_month = ? AND r.status IN ('PENDING_APPROVAL', 'APPROVED', 'PAID') AND ${scopeSql.sql}
       GROUP BY h.name, ri.category
       ORDER BY h.name ASC, total_amount DESC`,
      [yearMonth, ...scopeSql.params]
    );

    const csv = buildCsv(
      ['月份', '门店', '费用科目', '合计金额'],
      rows.map((r) => [
        yearMonth,
        r.hotel_name,
        EXPENSE_CATEGORY_LABELS[r.category] || r.category,
        roundMoney(Number(r.total_amount)),
      ])
    );

    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="expense-report-${yearMonth}.csv"`);
    res.send(csv);
  })
);

async function queryOperatingSummary(user: Express.Request['user'], yearMonth: string) {
  const db = getDb();
  const scope = await getScopeFilter(user!);
  const hotelScope = buildHotelScopeSql(scope, 'h.id');

  const hotels = await db.query<{ id: number; name: string }>(
    `SELECT h.id, h.name FROM hotels h WHERE ${hotelScope.sql} ORDER BY h.id ASC`,
    hotelScope.params
  );

  const budgets = await db.query<{ hotel_id: number; total_amount: number }>(
    `SELECT hotel_id, COALESCE(SUM(budget_amount), 0) AS total_amount
     FROM store_budgets WHERE \`year_month\` = ? GROUP BY hotel_id`,
    [yearMonth]
  );
  const reimbs = await db.query<{ hotel_id: number; total_amount: number }>(
    `SELECT hotel_id, COALESCE(SUM(total_amount), 0) AS total_amount
     FROM reimbursements
     WHERE expense_month = ? AND status IN ('PENDING_APPROVAL', 'APPROVED', 'PAID')
     GROUP BY hotel_id`,
    [yearMonth]
  );
  const vps = await db.query<{ hotel_id: number; total_amount: number }>(
    `SELECT hotel_id, COALESCE(SUM(amount), 0) AS total_amount
     FROM vendor_payments
     WHERE expense_month = ? AND status IN ('PENDING_APPROVAL', 'APPROVED', 'PAID')
     GROUP BY hotel_id`,
    [yearMonth]
  );
  const payrolls = await db.query<{
    hotel_id: number;
    headcount: number;
    gross_salary: number;
    social_security: number;
    income_tax: number;
    net_salary: number;
  }>(
    `SELECT hotel_id, COUNT(*) AS headcount,
            COALESCE(SUM(gross_pay), 0) AS gross_salary,
            COALESCE(SUM(social_security), 0) AS social_security,
            COALESCE(SUM(income_tax), 0) AS income_tax,
            COALESCE(SUM(net_pay), 0) AS net_salary
     FROM payroll_records WHERE \`year_month\` = ? GROUP BY hotel_id`,
    [yearMonth]
  );

  const budgetMap = new Map(budgets.map((b) => [Number(b.hotel_id), roundMoney(Number(b.total_amount))]));
  const reimbMap = new Map(reimbs.map((r) => [Number(r.hotel_id), roundMoney(Number(r.total_amount))]));
  const vpMap = new Map(vps.map((v) => [Number(v.hotel_id), roundMoney(Number(v.total_amount))]));
  const payMap = new Map(payrolls.map((p) => [Number(p.hotel_id), p]));

  return hotels.map((h) => {
    const budgetAmount = budgetMap.get(Number(h.id)) ?? 0;
    const reimbAmount = reimbMap.get(Number(h.id)) ?? 0;
    const vpAmount = vpMap.get(Number(h.id)) ?? 0;
    const totalExpense = roundMoney(reimbAmount + vpAmount);
    const pay = payMap.get(Number(h.id));
    return {
      hotel_id: h.id,
      hotel_name: h.name,
      budget_amount: budgetAmount,
      reimbursement_amount: reimbAmount,
      vendor_payment_amount: vpAmount,
      total_expense: totalExpense,
      budget_utilization_pct: budgetAmount > 0 ? roundMoney((totalExpense / budgetAmount) * 100) : null,
      headcount: pay ? Number(pay.headcount) : 0,
      gross_salary: pay ? roundMoney(Number(pay.gross_salary)) : 0,
      social_security: pay ? roundMoney(Number(pay.social_security)) : 0,
      income_tax: pay ? roundMoney(Number(pay.income_tax)) : 0,
      net_salary: pay ? roundMoney(Number(pay.net_salary)) : 0,
    };
  });
}

router.get(
  '/labor-cost',
  asyncHandler(async (req, res) => {
    const yearMonth = String(req.query.yearMonth || currentYearMonth());
    const rows = await queryOperatingSummary(req.user, yearMonth);
    res.json({
      yearMonth,
      labor_costs: rows.map((r) => ({
        hotel_id: r.hotel_id,
        hotel_name: r.hotel_name,
        headcount: r.headcount,
        gross_salary: r.gross_salary,
        social_security: r.social_security,
        income_tax: r.income_tax,
        net_salary: r.net_salary,
      })),
    });
  })
);

router.get(
  '/expense-summary',
  asyncHandler(async (req, res) => {
    const yearMonth = String(req.query.yearMonth || currentYearMonth());
    const rows = await queryOperatingSummary(req.user, yearMonth);
    res.json({
      yearMonth,
      summary: rows.map((r) => ({
        hotel_id: r.hotel_id,
        hotel_name: r.hotel_name,
        budget_amount: r.budget_amount,
        reimbursement_amount: r.reimbursement_amount,
        vendor_payment_amount: r.vendor_payment_amount,
        total_expense: r.total_expense,
        budget_utilization_pct: r.budget_utilization_pct,
      })),
    });
  })
);

router.get(
  '/summary/export',
  requireRoles('HQ_ADMIN', 'FINANCE', 'GENERAL_MANAGER', 'REGIONAL_MANAGER', 'STORE_MANAGER'),
  asyncHandler(async (req, res) => {
    const yearMonth = String(req.query.yearMonth || currentYearMonth());
    const rows = await queryOperatingSummary(req.user, yearMonth);
    const csv = buildCsv(
      ['月份', '门店', '月度预算', '报销支出', '对公付款', '费用合计', '人力成本(实发)'],
      rows.map((r) => [
        yearMonth,
        r.hotel_name,
        r.budget_amount,
        r.reimbursement_amount,
        r.vendor_payment_amount,
        r.total_expense,
        r.net_salary,
      ])
    );
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="operating-summary-${yearMonth}.csv"`);
    res.send(csv);
  })
);

export default router;
