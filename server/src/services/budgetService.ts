import { DbQueryRunner } from '../../db/adapter';
import { EXPENSE_CATEGORY_LABELS, ExpenseCategory } from '../types';
import { roundMoney } from '../utils/numbers';

export interface BudgetSummaryRow {
  hotel_id: number;
  hotel_name: string;
  hotel_code: string;
  year_month: string;
  category: ExpenseCategory;
  category_label: string;
  budget_amount: number;
  paid_amount: number;
  pending_amount: number;
  used_amount: number;
  remaining_amount: number;
  utilization_pct: number;
  is_over_budget: boolean;
}

export async function getStoreBudgetSummary(
  db: DbQueryRunner,
  params: {
    hotelId?: number;
    hotelIds?: number[];
    yearMonth: string;
    category?: string;
  }
): Promise<BudgetSummaryRow[]> {
  const conditions: string[] = ['b.`year_month` = ?'];
  const values: unknown[] = [params.yearMonth];

  if (params.hotelId) {
    conditions.push('b.hotel_id = ?');
    values.push(params.hotelId);
  } else if (params.hotelIds && params.hotelIds.length > 0) {
    conditions.push(`b.hotel_id IN (${params.hotelIds.map(() => '?').join(',')})`);
    values.push(...params.hotelIds);
  }

  if (params.category) {
    conditions.push('b.category = ?');
    values.push(params.category);
  }

  const budgets = await db.query<{
    hotel_id: number;
    hotel_name: string;
    hotel_code: string;
    year_month: string;
    category: ExpenseCategory;
    budget_amount: number;
  }>(
    `SELECT b.hotel_id, h.name AS hotel_name, h.code AS hotel_code, b.\`year_month\`, b.category, b.budget_amount
     FROM store_budgets b
     JOIN hotels h ON h.id = b.hotel_id
     WHERE ${conditions.join(' AND ')}
     ORDER BY h.id ASC, b.category ASC`,
    values
  );

  const usageRows = await db.query<{
    hotel_id: number;
    category: string;
    status: string;
    total_cat_amount: number;
  }>(
    `SELECT r.hotel_id, ri.category, r.status, COALESCE(SUM(ri.amount), 0) AS total_cat_amount
     FROM reimbursement_items ri
     JOIN reimbursements r ON r.id = ri.reimbursement_id
     WHERE r.expense_month = ?
       AND r.status IN ('PENDING_APPROVAL', 'APPROVED', 'PAID')
     GROUP BY r.hotel_id, ri.category, r.status`,
    [params.yearMonth]
  );

  const usageMap = new Map<string, { paid: number; pending: number }>();
  for (const row of usageRows) {
    const key = `${row.hotel_id}:${row.category}`;
    const cur = usageMap.get(key) || { paid: 0, pending: 0 };
    if (row.status === 'PAID') {
      cur.paid = roundMoney(cur.paid + Number(row.total_cat_amount));
    } else {
      cur.pending = roundMoney(cur.pending + Number(row.total_cat_amount));
    }
    usageMap.set(key, cur);
  }

  return budgets.map((b) => {
    const key = `${b.hotel_id}:${b.category}`;
    const usage = usageMap.get(key) || { paid: 0, pending: 0 };
    const budgetAmt = roundMoney(Number(b.budget_amount));
    const usedAmt = roundMoney(usage.paid + usage.pending);
    const remainingAmt = roundMoney(budgetAmt - usedAmt);
    const utilizationPct = budgetAmt > 0 ? roundMoney((usedAmt / budgetAmt) * 100) : usedAmt > 0 ? 100 : 0;

    return {
      hotel_id: Number(b.hotel_id),
      hotel_name: b.hotel_name,
      hotel_code: b.hotel_code,
      year_month: b.year_month,
      category: b.category,
      category_label: EXPENSE_CATEGORY_LABELS[b.category] || b.category,
      budget_amount: budgetAmt,
      paid_amount: usage.paid,
      pending_amount: usage.pending,
      used_amount: usedAmt,
      remaining_amount: remainingAmt,
      utilization_pct: utilizationPct,
      is_over_budget: usedAmt > budgetAmt,
    };
  });
}

export interface RiskItemInput {
  category: string;
  amount: number;
  invoice_no?: string | null;
}

export interface RiskEvaluationResult {
  riskFlags: string[];
  riskSummary: string;
  overBudgetCategories: Array<{
    category: string;
    categoryLabel: string;
    budgetAmount: number;
    alreadyUsed: number;
    claimAmount: number;
    projectedUsed: number;
    exceededBy: number;
  }>;
  noBudgetCategories: Array<{
    category: string;
    categoryLabel: string;
    claimAmount: number;
  }>;
  duplicateInvoices: Array<{
    invoiceNo: string;
    conflictClaimNos: string[];
  }>;
}

export async function evaluateReimbursementRisks(
  db: DbQueryRunner,
  params: {
    hotelId: number;
    expenseMonth: string;
    items: RiskItemInput[];
    excludeReimbursementId?: number;
  }
): Promise<RiskEvaluationResult> {
  const categorySums = new Map<string, number>();
  for (const item of params.items) {
    categorySums.set(
      item.category,
      roundMoney((categorySums.get(item.category) || 0) + Number(item.amount || 0))
    );
  }

  const overBudgetCategories: RiskEvaluationResult['overBudgetCategories'] = [];
  const noBudgetCategories: RiskEvaluationResult['noBudgetCategories'] = [];

  for (const [category, claimAmount] of categorySums.entries()) {
    const budgetRow = await db.queryOne<{ budget_amount: number }>(
      'SELECT budget_amount FROM store_budgets WHERE hotel_id = ? AND `year_month` = ? AND category = ?',
      [params.hotelId, params.expenseMonth, category]
    );
    if (!budgetRow) {
      noBudgetCategories.push({
        category,
        categoryLabel: EXPENSE_CATEGORY_LABELS[category as ExpenseCategory] || category,
        claimAmount,
      });
      continue;
    }
    const budgetAmount = roundMoney(Number(budgetRow.budget_amount));

    const excludeSql = params.excludeReimbursementId ? 'AND r.id != ?' : '';
    const usedParams: unknown[] = [params.hotelId, params.expenseMonth, category];
    if (params.excludeReimbursementId) usedParams.push(params.excludeReimbursementId);

    const usedRow = await db.queryOne<{ used_amt: number }>(
      `SELECT COALESCE(SUM(ri.amount), 0) AS used_amt
       FROM reimbursement_items ri
       JOIN reimbursements r ON r.id = ri.reimbursement_id
       WHERE r.hotel_id = ?
         AND r.expense_month = ?
         AND ri.category = ?
         AND r.status IN ('PENDING_APPROVAL', 'APPROVED', 'PAID')
         ${excludeSql}`,
      usedParams
    );

    const alreadyUsed = roundMoney(Number(usedRow?.used_amt || 0));
    const projectedUsed = roundMoney(alreadyUsed + claimAmount);

    if (projectedUsed > budgetAmount) {
      overBudgetCategories.push({
        category,
        categoryLabel: EXPENSE_CATEGORY_LABELS[category as ExpenseCategory] || category,
        budgetAmount,
        alreadyUsed,
        claimAmount,
        projectedUsed,
        exceededBy: roundMoney(projectedUsed - budgetAmount),
      });
    }
  }

  // Duplicate invoice check
  const duplicateInvoices: RiskEvaluationResult['duplicateInvoices'] = [];
  const seenInSelf = new Map<string, number>();
  for (const item of params.items) {
    const inv = (item.invoice_no || '').trim();
    if (!inv) continue;
    seenInSelf.set(inv, (seenInSelf.get(inv) || 0) + 1);
  }

  const checkedInvoices = new Set<string>();
  for (const item of params.items) {
    const inv = (item.invoice_no || '').trim();
    if (!inv || checkedInvoices.has(inv)) continue;
    checkedInvoices.add(inv);

    const excludeSql = params.excludeReimbursementId ? 'AND r.id != ?' : '';
    const invParams: unknown[] = [inv];
    if (params.excludeReimbursementId) invParams.push(params.excludeReimbursementId);

    const conflicts = await db.query<{ claim_no: string }>(
      `SELECT DISTINCT r.claim_no
       FROM reimbursement_items ri
       JOIN reimbursements r ON r.id = ri.reimbursement_id
       WHERE ri.invoice_no = ?
         AND r.status NOT IN ('REJECTED', 'DRAFT')
         ${excludeSql}`,
      invParams
    );

    const conflictClaimNos = conflicts.map((c) => c.claim_no);
    if ((seenInSelf.get(inv) || 0) > 1) {
      conflictClaimNos.push('当前报销单内重复');
    }

    if (conflictClaimNos.length > 0) {
      duplicateInvoices.push({
        invoiceNo: inv,
        conflictClaimNos,
      });
    }
  }

  const riskFlags: string[] = [];
  const summaryParts: string[] = [];

  if (overBudgetCategories.length > 0) {
    riskFlags.push('OVER_BUDGET');
    const detail = overBudgetCategories
      .map((c) => `${c.categoryLabel}超预算 ¥${c.exceededBy.toFixed(2)}`)
      .join('；');
    summaryParts.push(`预算超标：${detail}`);
  }

  if (noBudgetCategories.length > 0) {
    riskFlags.push('NO_BUDGET');
    const detail = noBudgetCategories.map((c) => c.categoryLabel).join('、');
    summaryParts.push(`尚未设置预算：${detail}`);
  }

  if (duplicateInvoices.length > 0) {
    riskFlags.push('DUPLICATE_INVOICE');
    const detail = duplicateInvoices
      .map((d) => `发票 ${d.invoiceNo} 关联 ${d.conflictClaimNos.join(', ')}`)
      .join('；');
    summaryParts.push(`疑似重复发票：${detail}`);
  }

  return {
    riskFlags,
    riskSummary: summaryParts.join(' | '),
    overBudgetCategories,
    noBudgetCategories,
    duplicateInvoices,
  };
}
