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

export default router;
