import { Router } from 'express';
import { z } from 'zod';
import { getDb } from '../../db';
import {
  AppError,
  asyncHandler,
  authenticate,
  canAccessHotel,
  getScopeFilter,
  requireRoles,
} from '../middleware/auth';
import { uploadInvoiceMiddleware } from '../middleware/upload';
import { logApprovalAction } from '../services/auditService';
import { evaluateReimbursementRisks, getStoreBudgetSummary } from '../services/budgetService';
import {
  buildReimbursementRoute,
  canUserActOnStep,
  getAvailableAdvanceBalance,
  replaceApprovalSteps,
  resolveApprovalRoute,
} from '../services/workflowEngine';
import { EXPENSE_CATEGORY_LABELS, ExpenseCategory, ROLE_LABELS, UserRole } from '../types';
import { buildCsv } from '../utils/csv';
import { currentYearMonth, generateCode, nowIso, roundMoney } from '../utils/numbers';

const router = Router();
router.use(authenticate);

const itemSchema = z.object({
  category: z.enum([
    'LINEN_SUPPLIES',
    'MAINTENANCE',
    'FB_PROCUREMENT',
    'UTILITIES',
    'MARKETING',
    'TRAVEL_TRAINING',
    'OTHER',
  ]),
  expense_date: z.string().min(8),
  description: z.string().min(1, '请填写费用明细说明'),
  amount: z.number().positive('明细金额必须大于0'),
  invoice_no: z.string().optional().nullable(),
  attachment_url: z.string().optional().nullable(),
  attachment_name: z.string().optional().nullable(),
});

const claimPayloadSchema = z.object({
  title: z.string().min(2, '请填写报销单标题'),
  hotel_id: z.number().int().positive(),
  department_id: z.number().int().positive().nullable().optional(),
  expense_month: z.string().regex(/^\d{4}-\d{2}$/),
  cash_advance_id: z.number().int().positive().nullable().optional(),
  offset_amount: z.number().min(0).default(0),
  remarks: z.string().optional().nullable(),
  payment_type: z.enum(['CORPORATE', 'PERSONAL']).default('PERSONAL'),
  payee_name: z.string().trim().min(1, '请填写收款人账户名称'),
  payee_bank: z.string().trim().min(2, '请填写开户银行'),
  payee_account: z.string().trim().min(4, '请填写收款账户号码'),
  submit: z.boolean().default(false),
  items: z.array(itemSchema).min(1, '至少添加一条费用明细'),
});

// List saved payee accounts (populated automatically after Finance completes payout)
router.get(
  '/payees',
  asyncHandler(async (req, res) => {
    const db = getDb();
    const conditions = ['1=1'];
    const params: unknown[] = [];

    if (req.query.paymentType) {
      conditions.push('payment_type = ?');
      params.push(String(req.query.paymentType));
    }
    if (req.query.keyword) {
      const kw = `%${String(req.query.keyword).trim()}%`;
      conditions.push('(account_name LIKE ? OR account_number LIKE ? OR bank_name LIKE ?)');
      params.push(kw, kw, kw);
    }

    const payees = await db.query(
      `SELECT id, payment_type, account_name, account_number, bank_name, hotel_id, last_paid_at, paid_count
       FROM payee_accounts
       WHERE ${conditions.join(' AND ')}
       ORDER BY paid_count DESC, last_paid_at DESC`,
      params
    );

    res.json({ payees });
  })
);

// Upload invoice/receipt attachment
router.post(
  '/upload',
  uploadInvoiceMiddleware.single('file'),
  asyncHandler(async (req, res) => {
    if (!req.file) {
      throw new AppError(400, '请选择要上传的发票或凭证文件');
    }
    res.status(201).json({
      url: `/uploads/${req.file.filename}`,
      originalName: req.file.originalname,
    });
  })
);

// Live preview: budget risk check + duplicate invoice + dynamic approval route
router.post(
  '/preview',
  asyncHandler(async (req, res) => {
    const body = z
      .object({
        hotel_id: z.number().int().positive(),
        expense_month: z.string().regex(/^\d{4}-\d{2}$/),
        exclude_id: z.number().int().positive().optional(),
        items: z.array(
          z.object({
            category: z.string(),
            amount: z.number().min(0),
            invoice_no: z.string().optional().nullable(),
          })
        ),
      })
      .parse(req.body);

    const db = getDb();
    const totalAmount = roundMoney(body.items.reduce((s, it) => s + Number(it.amount || 0), 0));
    const risks = await evaluateReimbursementRisks(db, {
      hotelId: body.hotel_id,
      expenseMonth: body.expense_month,
      items: body.items,
      excludeReimbursementId: body.exclude_id,
    });

    const rawRoute = buildReimbursementRoute({
      applicantRole: req.user!.role,
      totalAmount,
      hasOverBudget: risks.riskFlags.includes('OVER_BUDGET'),
    });
    const resolved = await resolveApprovalRoute(db, body.hotel_id, rawRoute);

    res.json({
      totalAmount,
      risks,
      skippedRegionalManager: resolved.skippedRegionalManager,
      skipReason: resolved.skipReason,
      route: resolved.steps.map((s) => ({
        ...s,
        roleLabel: ROLE_LABELS[s.approverRole],
      })),
    });
  })
);

// List reimbursements
router.get(
  '/',
  asyncHandler(async (req, res) => {
    const db = getDb();
    const user = req.user!;
    const tab = String(req.query.tab || 'all');
    const scope = await getScopeFilter(user);

    const conditions = ['1=1'];
    const params: unknown[] = [];

    if (tab === 'mine') {
      conditions.push('r.applicant_id = ?');
      params.push(user.id);
    } else if (tab === 'payout_queue') {
      if (!['HQ_ADMIN', 'FINANCE'].includes(user.role)) {
        throw new AppError(403, '仅财务与管理员可查看待打款核销队列');
      }
      conditions.push(`r.status = 'APPROVED'`);
    } else if (tab !== 'pending') {
      if (scope.type === 'REGION') {
        if (scope.hotelIds.length === 0) {
          res.json({ reimbursements: [] });
          return;
        }
        conditions.push(`r.hotel_id IN (${scope.hotelIds.map(() => '?').join(',')})`);
        params.push(...scope.hotelIds);
      } else if (scope.type === 'HOTEL') {
        conditions.push('r.hotel_id = ?');
        params.push(scope.hotelId);
      } else if (scope.type === 'SELF') {
        conditions.push('r.applicant_id = ?');
        params.push(user.id);
      }
    }

    if (req.query.status) {
      conditions.push('r.status = ?');
      params.push(String(req.query.status));
    }
    if (req.query.hotelId) {
      conditions.push('r.hotel_id = ?');
      params.push(Number(req.query.hotelId));
    }
    if (req.query.expenseMonth) {
      conditions.push('r.expense_month = ?');
      params.push(String(req.query.expenseMonth));
    }
    if (req.query.riskOnly === 'true') {
      conditions.push(`r.risk_flags != ''`);
    }
    if (req.query.keyword) {
      const kw = `%${String(req.query.keyword).trim()}%`;
      conditions.push('(r.claim_no LIKE ? OR r.title LIKE ? OR u.display_name LIKE ?)');
      params.push(kw, kw, kw);
    }

    const rows = await db.query<{
      id: number;
      claim_no: string;
      title: string;
      applicant_id: number;
      hotel_id: number;
      expense_month: string;
      total_amount: number;
      cash_advance_id: number | null;
      offset_amount: number;
      net_pay_amount: number;
      status: string;
      current_step: number;
      total_steps: number;
      risk_flags: string;
      risk_summary: string | null;
      payee_name: string;
      payment_channel: string | null;
      payment_ref: string | null;
      paid_at: string | null;
      created_at: string;
      hotel_name: string;
      hotel_code: string;
      applicant_name: string;
      department_name: string | null;
    }>(
      `SELECT r.*, h.name AS hotel_name, h.code AS hotel_code, u.display_name AS applicant_name, d.name AS department_name
       FROM reimbursements r
       JOIN hotels h ON h.id = r.hotel_id
       JOIN users u ON u.id = r.applicant_id
       LEFT JOIN departments d ON d.id = r.department_id
       WHERE ${conditions.join(' AND ')}
       ORDER BY r.id DESC`,
      params
    );

    const enriched = [];
    for (const r of rows) {
      const pendingStep =
        r.status === 'PENDING_APPROVAL'
          ? await db.queryOne<{ step_name: string; approver_role: UserRole }>(
              `SELECT step_name, approver_role FROM approval_steps
               WHERE biz_type = 'REIMBURSEMENT' AND biz_id = ? AND status = 'PENDING'
               ORDER BY step_order ASC LIMIT 1`,
              [r.id]
            )
          : null;

      const canApprove = pendingStep
        ? await canUserActOnStep(db, user, pendingStep.approver_role, r.hotel_id, r.applicant_id)
        : false;

      if (tab === 'pending' && !canApprove) continue;

      enriched.push({
        ...r,
        current_step_name: pendingStep?.step_name ?? null,
        canApprove,
      });
    }

    res.json({ reimbursements: enriched });
  })
);

router.get(
  '/export',
  requireRoles('HQ_ADMIN', 'FINANCE', 'GENERAL_MANAGER', 'REGIONAL_MANAGER', 'STORE_MANAGER'),
  asyncHandler(async (req, res) => {
    const db = getDb();
    const scope = await getScopeFilter(req.user!);
    const conditions = ['1=1'];
    const params: unknown[] = [];

    if (scope.type === 'REGION' && scope.hotelIds.length > 0) {
      conditions.push(`r.hotel_id IN (${scope.hotelIds.map(() => '?').join(',')})`);
      params.push(...scope.hotelIds);
    } else if (scope.type === 'HOTEL') {
      conditions.push('r.hotel_id = ?');
      params.push(scope.hotelId);
    }
    if (req.query.expenseMonth) {
      conditions.push('r.expense_month = ?');
      params.push(String(req.query.expenseMonth));
    }

    const rows = await db.query<{
      claim_no: string;
      title: string;
      hotel_name: string;
      applicant_name: string;
      expense_month: string;
      total_amount: number;
      offset_amount: number;
      net_pay_amount: number;
      status: string;
      risk_summary: string | null;
      payment_ref: string | null;
      paid_at: string | null;
      created_at: string;
    }>(
      `SELECT r.*, h.name AS hotel_name, u.display_name AS applicant_name
       FROM reimbursements r
       JOIN hotels h ON h.id = r.hotel_id
       JOIN users u ON u.id = r.applicant_id
       WHERE ${conditions.join(' AND ')}
       ORDER BY r.id DESC`,
      params
    );

    const csv = buildCsv(
      ['报销单号', '报销标题', '所属门店', '报销人', '费用月份', '打款类型', '收款人账户名称', '开户银行', '账户号码', '报销总额', '冲销借款', '实付金额', '状态', '风控预警', '打款流水号', '打款时间', '创建时间'],
      rows.map((r: any) => [
        r.claim_no,
        r.title,
        r.hotel_name,
        r.applicant_name,
        r.expense_month,
        r.payment_type === 'CORPORATE' ? '对公' : '对私',
        r.payee_name,
        r.payee_bank || '',
        r.payee_account || '',
        r.total_amount,
        r.offset_amount,
        r.net_pay_amount,
        r.status,
        r.risk_summary || '',
        r.payment_ref || '',
        r.paid_at || '',
        r.created_at,
      ])
    );

    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="reimbursements-${currentYearMonth()}.csv"`);
    res.send(csv);
  })
);

// Detail
router.get(
  '/:id',
  asyncHandler(async (req, res) => {
    const id = Number(req.params.id);
    const db = getDb();
    const user = req.user!;

    const claim = await db.queryOne<{
      id: number;
      claim_no: string;
      applicant_id: number;
      hotel_id: number;
      expense_month: string;
      cash_advance_id: number | null;
      status: string;
      current_step: number;
      total_amount: number;
      offset_amount: number;
      net_pay_amount: number;
      risk_flags: string;
      risk_summary: string | null;
    }>(
      `SELECT r.*, h.name AS hotel_name, h.code AS hotel_code, u.display_name AS applicant_name,
              u.role AS applicant_role, d.name AS department_name
       FROM reimbursements r
       JOIN hotels h ON h.id = r.hotel_id
       JOIN users u ON u.id = r.applicant_id
       LEFT JOIN departments d ON d.id = r.department_id
       WHERE r.id = ?`,
      [id]
    );
    if (!claim) throw new AppError(404, '报销单不存在');

    const isOwner = claim.applicant_id === user.id;
    const hasHotelAccess = await canAccessHotel(user, claim.hotel_id);
    if (!isOwner && !hasHotelAccess && user.role !== 'FINANCE' && user.role !== 'HQ_ADMIN' && user.role !== 'GENERAL_MANAGER') {
      throw new AppError(403, '无权查看此报销单');
    }

    const items = await db.query(
      'SELECT * FROM reimbursement_items WHERE reimbursement_id = ? ORDER BY id ASC',
      [id]
    );

    const approvalSteps = await db.query<{
      id: number;
      step_order: number;
      step_name: string;
      approver_role: UserRole;
      status: string;
      acted_by: number | null;
      acted_at: string | null;
      comment: string | null;
      actor_name: string | null;
    }>(
      `SELECT s.*, u.display_name AS actor_name
       FROM approval_steps s
       LEFT JOIN users u ON u.id = s.acted_by
       WHERE s.biz_type = 'REIMBURSEMENT' AND s.biz_id = ?
       ORDER BY s.step_order ASC`,
      [id]
    );

    const approvalLogs = await db.query(
      `SELECT * FROM approval_logs WHERE biz_type = 'REIMBURSEMENT' AND biz_id = ? ORDER BY id ASC`,
      [id]
    );

    const cashAdvance = claim.cash_advance_id
      ? await db.queryOne('SELECT * FROM cash_advances WHERE id = ?', [claim.cash_advance_id])
      : null;

    const budgetImpact = await getStoreBudgetSummary(db, {
      hotelId: claim.hotel_id,
      yearMonth: claim.expense_month,
    });

    const pendingStep = approvalSteps.find((s) => s.status === 'PENDING');
    const canApprove =
      claim.status === 'PENDING_APPROVAL' && pendingStep
        ? await canUserActOnStep(db, user, pendingStep.approver_role, claim.hotel_id, claim.applicant_id)
        : false;
    const canEdit = isOwner && (claim.status === 'DRAFT' || claim.status === 'RETURNED');
    const canWithdraw = isOwner && claim.status === 'PENDING_APPROVAL' && claim.current_step === 1;
    const canPay = claim.status === 'APPROVED' && ['HQ_ADMIN', 'FINANCE'].includes(user.role);

    res.json({
      claim,
      items: items.map((it: Record<string, unknown>) => ({
        ...it,
        category_label: EXPENSE_CATEGORY_LABELS[it.category as ExpenseCategory] || it.category,
      })),
      approvalSteps: approvalSteps.map((s) => ({
        ...s,
        role_label: ROLE_LABELS[s.approver_role] || s.approver_role,
      })),
      approvalLogs,
      cashAdvance,
      budgetImpact,
      permissions: { canApprove, canEdit, canWithdraw, canPay },
    });
  })
);

// Create reimbursement (DRAFT or SUBMIT)
router.post(
  '/',
  asyncHandler(async (req, res) => {
    const body = claimPayloadSchema.parse(req.body);
    const user = req.user!;
    if (!(await canAccessHotel(user, body.hotel_id))) {
      throw new AppError(403, '无权为其他门店创建报销单');
    }

    const db = getDb();
    const totalAmount = roundMoney(body.items.reduce((s, it) => s + Number(it.amount), 0));
    const offsetAmount = roundMoney(body.offset_amount || 0);

    if (offsetAmount > 0 && !body.cash_advance_id) {
      throw new AppError(400, '填写冲销金额时必须选择关联的借款/备用金单');
    }
    if (offsetAmount > totalAmount) {
      throw new AppError(400, '借款冲销金额不能大于报销总额');
    }

    const netPayAmount = roundMoney(totalAmount - offsetAmount);
    const ts = nowIso();
    const claimNo = generateCode('BX');

    // Load default bank info from employee if omitted
    const emp = user.employee_id
      ? await db.queryOne<{ name: string; bank_name: string | null; bank_account: string | null }>(
          'SELECT name, bank_name, bank_account FROM employees WHERE id = ?',
          [user.employee_id]
        )
      : null;

    const claimId = await db.transaction(async (tx) => {
      if (body.cash_advance_id) {
        const { advance, availableBalance } = await getAvailableAdvanceBalance(tx, body.cash_advance_id);
        if (!advance || advance.status !== 'DISBURSED') {
          throw new AppError(400, '所选借款单不可用或尚未放款');
        }
        if (offsetAmount > availableBalance) {
          throw new AppError(400, `借款可用冲销余额不足，当前可用 ¥${availableBalance.toFixed(2)}`);
        }
      }

      const risks = await evaluateReimbursementRisks(tx, {
        hotelId: body.hotel_id,
        expenseMonth: body.expense_month,
        items: body.items,
      });

      const dupInvoiceSet = new Set(risks.duplicateInvoices.map((d) => d.invoiceNo));
      const resolved = body.submit
        ? await resolveApprovalRoute(
            tx,
            body.hotel_id,
            buildReimbursementRoute({
              applicantRole: user.role,
              totalAmount,
              hasOverBudget: risks.riskFlags.includes('OVER_BUDGET'),
            })
          )
        : { steps: [], skippedRegionalManager: false, skipReason: null };
      const route = resolved.steps;

      const ins = await tx.execute(
        `INSERT INTO reimbursements (
          claim_no, title, applicant_id, employee_id, hotel_id, department_id, expense_month,
          total_amount, cash_advance_id, offset_amount, net_pay_amount, status, current_step, total_steps,
          risk_flags, risk_summary, remarks, payment_type, payee_name, payee_bank, payee_account, submitted_at, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          claimNo,
          body.title,
          user.id,
          user.employee_id,
          body.hotel_id,
          body.department_id ?? null,
          body.expense_month,
          totalAmount,
          body.cash_advance_id ?? null,
          offsetAmount,
          netPayAmount,
          body.submit ? 'PENDING_APPROVAL' : 'DRAFT',
          body.submit ? 1 : 0,
          body.submit ? route.length : 0,
          risks.riskFlags.join(','),
          risks.riskSummary || null,
          body.remarks ?? null,
          body.payment_type,
          body.payee_name,
          body.payee_bank,
          body.payee_account,
          body.submit ? ts : null,
          ts,
          ts,
        ]
      );

      for (const it of body.items) {
        const inv = (it.invoice_no || '').trim();
        await tx.execute(
          `INSERT INTO reimbursement_items (
            reimbursement_id, category, expense_date, description, amount, invoice_no,
            attachment_url, attachment_name, is_duplicate_invoice, created_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          [
            ins.insertId,
            it.category,
            it.expense_date,
            it.description,
            roundMoney(it.amount),
            inv || null,
            it.attachment_url ?? null,
            it.attachment_name ?? null,
            inv && dupInvoiceSet.has(inv) ? 1 : 0,
            ts,
          ]
        );
      }

      if (body.submit) {
        await replaceApprovalSteps(tx, 'REIMBURSEMENT', ins.insertId, route);
        await logApprovalAction(tx, {
          bizType: 'REIMBURSEMENT',
          bizId: ins.insertId,
          action: 'SUBMIT',
          actor: user,
          comment: body.remarks || '提交报销审批',
        });
        if (resolved.skippedRegionalManager && resolved.skipReason) {
          await logApprovalAction(tx, {
            bizType: 'REIMBURSEMENT',
            bizId: ins.insertId,
            action: 'AUTO_SKIP',
            actor: user,
            comment: resolved.skipReason,
          });
        }
      } else {
        await logApprovalAction(tx, {
          bizType: 'REIMBURSEMENT',
          bizId: ins.insertId,
          action: 'SAVE_DRAFT',
          actor: user,
          comment: '保存报销草稿',
        });
      }

      return ins.insertId;
    });

    const created = await db.queryOne('SELECT * FROM reimbursements WHERE id = ?', [claimId]);
    res.status(201).json({ claim: created });
  })
);

// Update DRAFT or RETURNED claim (and optionally submit/resubmit)
router.put(
  '/:id',
  asyncHandler(async (req, res) => {
    const id = Number(req.params.id);
    const body = claimPayloadSchema.parse(req.body);
    const user = req.user!;
    const db = getDb();

    const existing = await db.queryOne<{
      id: number;
      applicant_id: number;
      status: string;
    }>('SELECT id, applicant_id, status FROM reimbursements WHERE id = ?', [id]);
    if (!existing) throw new AppError(404, '报销单不存在');
    if (existing.applicant_id !== user.id) throw new AppError(403, '仅报销人本人可修改');
    if (existing.status !== 'DRAFT' && existing.status !== 'RETURNED') {
      throw new AppError(400, '仅草稿或已退回的报销单可编辑');
    }

    const totalAmount = roundMoney(body.items.reduce((s, it) => s + Number(it.amount), 0));
    const offsetAmount = roundMoney(body.offset_amount || 0);
    if (offsetAmount > 0 && !body.cash_advance_id) {
      throw new AppError(400, '填写冲销金额时必须选择关联的借款单');
    }
    if (offsetAmount > totalAmount) {
      throw new AppError(400, '借款冲销金额不能大于报销总额');
    }
    const netPayAmount = roundMoney(totalAmount - offsetAmount);
    const ts = nowIso();

    await db.transaction(async (tx) => {
      if (body.cash_advance_id) {
        const { advance, availableBalance } = await getAvailableAdvanceBalance(tx, body.cash_advance_id, id);
        if (!advance || advance.status !== 'DISBURSED') {
          throw new AppError(400, '所选借款单不可用');
        }
        if (offsetAmount > availableBalance) {
          throw new AppError(400, `借款可用冲销余额不足，当前可用 ¥${availableBalance.toFixed(2)}`);
        }
      }

      const risks = await evaluateReimbursementRisks(tx, {
        hotelId: body.hotel_id,
        expenseMonth: body.expense_month,
        items: body.items,
        excludeReimbursementId: id,
      });
      const dupInvoiceSet = new Set(risks.duplicateInvoices.map((d) => d.invoiceNo));
      const resolved = body.submit
        ? await resolveApprovalRoute(
            tx,
            body.hotel_id,
            buildReimbursementRoute({
              applicantRole: user.role,
              totalAmount,
              hasOverBudget: risks.riskFlags.includes('OVER_BUDGET'),
            })
          )
        : { steps: [], skippedRegionalManager: false, skipReason: null };
      const route = resolved.steps;

      const nextStatus = body.submit ? 'PENDING_APPROVAL' : existing.status;

      await tx.execute(
        `UPDATE reimbursements
         SET title = ?, hotel_id = ?, department_id = ?, expense_month = ?, total_amount = ?,
             cash_advance_id = ?, offset_amount = ?, net_pay_amount = ?, status = ?,
             current_step = ?, total_steps = ?, risk_flags = ?, risk_summary = ?, remarks = ?,
             payment_type = ?, payee_name = ?, payee_bank = ?, payee_account = ?,
             submitted_at = COALESCE(submitted_at, ?), updated_at = ?
         WHERE id = ?`,
        [
          body.title,
          body.hotel_id,
          body.department_id ?? null,
          body.expense_month,
          totalAmount,
          body.cash_advance_id ?? null,
          offsetAmount,
          netPayAmount,
          nextStatus,
          body.submit ? 1 : 0,
          body.submit ? route.length : 0,
          risks.riskFlags.join(','),
          risks.riskSummary || null,
          body.remarks ?? null,
          body.payment_type,
          body.payee_name,
          body.payee_bank,
          body.payee_account,
          body.submit ? ts : null,
          ts,
          id,
        ]
      );

      await tx.execute('DELETE FROM reimbursement_items WHERE reimbursement_id = ?', [id]);
      for (const it of body.items) {
        const inv = (it.invoice_no || '').trim();
        await tx.execute(
          `INSERT INTO reimbursement_items (
            reimbursement_id, category, expense_date, description, amount, invoice_no,
            attachment_url, attachment_name, is_duplicate_invoice, created_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          [
            id,
            it.category,
            it.expense_date,
            it.description,
            roundMoney(it.amount),
            inv || null,
            it.attachment_url ?? null,
            it.attachment_name ?? null,
            inv && dupInvoiceSet.has(inv) ? 1 : 0,
            ts,
          ]
        );
      }

      if (body.submit) {
        await replaceApprovalSteps(tx, 'REIMBURSEMENT', id, route);
        await logApprovalAction(tx, {
          bizType: 'REIMBURSEMENT',
          bizId: id,
          action: existing.status === 'RETURNED' ? 'RESUBMIT' : 'SUBMIT',
          actor: user,
          comment: body.remarks || (existing.status === 'RETURNED' ? '修改后重新提交审批' : '提交报销审批'),
        });
        if (resolved.skippedRegionalManager && resolved.skipReason) {
          await logApprovalAction(tx, {
            bizType: 'REIMBURSEMENT',
            bizId: id,
            action: 'AUTO_SKIP',
            actor: user,
            comment: resolved.skipReason,
          });
        }
      }
    });

    const updated = await db.queryOne('SELECT * FROM reimbursements WHERE id = ?', [id]);
    res.json({ claim: updated });
  })
);

router.delete(
  '/:id',
  asyncHandler(async (req, res) => {
    const id = Number(req.params.id);
    const db = getDb();
    const existing = await db.queryOne<{ id: number; applicant_id: number; status: string }>(
      'SELECT id, applicant_id, status FROM reimbursements WHERE id = ?',
      [id]
    );
    if (!existing) throw new AppError(404, '报销单不存在');
    if (existing.applicant_id !== req.user!.id) throw new AppError(403, '仅本人可删除草稿');
    if (existing.status !== 'DRAFT') throw new AppError(400, '仅草稿状态的报销单可删除');

    await db.execute('DELETE FROM reimbursements WHERE id = ?', [id]);
    res.json({ ok: true });
  })
);

router.post(
  '/:id/withdraw',
  asyncHandler(async (req, res) => {
    const id = Number(req.params.id);
    const db = getDb();
    const claim = await db.queryOne<{ id: number; applicant_id: number; status: string; current_step: number }>(
      'SELECT id, applicant_id, status, current_step FROM reimbursements WHERE id = ?',
      [id]
    );
    if (!claim) throw new AppError(404, '报销单不存在');
    if (claim.applicant_id !== req.user!.id) throw new AppError(403, '仅申请人本人可撤回');
    if (claim.status !== 'PENDING_APPROVAL' || claim.current_step !== 1) {
      throw new AppError(400, '仅在第一级待审且无人审批前可撤回');
    }

    const ts = nowIso();
    await db.transaction(async (tx) => {
      await tx.execute(
        `UPDATE reimbursements SET status = 'DRAFT', current_step = 0, total_steps = 0, updated_at = ? WHERE id = ?`,
        [ts, id]
      );
      await tx.execute(`DELETE FROM approval_steps WHERE biz_type = 'REIMBURSEMENT' AND biz_id = ?`, [id]);
      await logApprovalAction(tx, {
        bizType: 'REIMBURSEMENT',
        bizId: id,
        action: 'WITHDRAW',
        actor: req.user!,
        comment: '申请人主动撤回至草稿',
      });
    });

    res.json({ ok: true });
  })
);

// Approve / Return / Reject
router.post(
  '/:id/action',
  asyncHandler(async (req, res) => {
    const id = Number(req.params.id);
    const { action, comment } = z
      .object({
        action: z.enum(['APPROVE', 'RETURN', 'REJECT']),
        comment: z.string().optional().default(''),
      })
      .parse(req.body);

    if ((action === 'RETURN' || action === 'REJECT') && comment.trim().length < 2) {
      throw new AppError(400, '退回或驳回时请填写至少2个字的审批意见');
    }

    const db = getDb();
    const user = req.user!;

    await db.transaction(async (tx) => {
      const claim = await tx.queryOne<{
        id: number;
        hotel_id: number;
        applicant_id: number;
        status: string;
        current_step: number;
      }>(`SELECT id, hotel_id, applicant_id, status, current_step FROM reimbursements WHERE id = ?${tx.forUpdateSuffix()}`, [id]);

      if (!claim) throw new AppError(404, '报销单不存在');
      if (claim.status !== 'PENDING_APPROVAL') throw new AppError(400, '当前报销单不在审批中');

      const step = await tx.queryOne<{ id: number; step_order: number; approver_role: UserRole }>(
        `SELECT id, step_order, approver_role FROM approval_steps
         WHERE biz_type = 'REIMBURSEMENT' AND biz_id = ? AND status = 'PENDING'
         ORDER BY step_order ASC LIMIT 1`,
        [id]
      );
      if (!step) throw new AppError(400, '未找到当前待审批节点');

      const allowed = await canUserActOnStep(tx, user, step.approver_role, claim.hotel_id, claim.applicant_id);
      if (!allowed) throw new AppError(403, '您无权审批当前节点');

      const ts = nowIso();
      if (action === 'RETURN') {
        await tx.execute(
          `UPDATE approval_steps SET status = 'RETURNED', acted_by = ?, acted_at = ?, comment = ? WHERE id = ?`,
          [user.id, ts, comment, step.id]
        );
        await tx.execute(`UPDATE reimbursements SET status = 'RETURNED', updated_at = ? WHERE id = ?`, [ts, id]);
      } else if (action === 'REJECT') {
        await tx.execute(
          `UPDATE approval_steps SET status = 'REJECTED', acted_by = ?, acted_at = ?, comment = ? WHERE id = ?`,
          [user.id, ts, comment, step.id]
        );
        await tx.execute(`UPDATE reimbursements SET status = 'REJECTED', updated_at = ? WHERE id = ?`, [ts, id]);
      } else {
        await tx.execute(
          `UPDATE approval_steps SET status = 'APPROVED', acted_by = ?, acted_at = ?, comment = ? WHERE id = ?`,
          [user.id, ts, comment || '同意', step.id]
        );
        const nextStep = await tx.queryOne<{ id: number; step_order: number }>(
          `SELECT id, step_order FROM approval_steps
           WHERE biz_type = 'REIMBURSEMENT' AND biz_id = ? AND step_order > ?
           ORDER BY step_order ASC LIMIT 1`,
          [id, step.step_order]
        );
        if (nextStep) {
          await tx.execute(`UPDATE approval_steps SET status = 'PENDING' WHERE id = ?`, [nextStep.id]);
          await tx.execute(`UPDATE reimbursements SET current_step = ?, updated_at = ? WHERE id = ?`, [
            nextStep.step_order,
            ts,
            id,
          ]);
        } else {
          await tx.execute(`UPDATE reimbursements SET status = 'APPROVED', updated_at = ? WHERE id = ?`, [ts, id]);
        }
      }

      await logApprovalAction(tx, {
        bizType: 'REIMBURSEMENT',
        bizId: id,
        action,
        actor: user,
        comment: comment || (action === 'APPROVE' ? '审核通过' : ''),
      });
    });

    const updated = await db.queryOne('SELECT * FROM reimbursements WHERE id = ?', [id]);
    res.json({ claim: updated });
  })
);

// Finance payout (single or batch) + cash advance settlement
router.post(
  '/payout',
  requireRoles('HQ_ADMIN', 'FINANCE'),
  asyncHandler(async (req, res) => {
    const body = z
      .object({
        reimbursement_ids: z.array(z.number().int().positive()).min(1, '请选择至少一条待打款报销单'),
        payment_channel: z.enum(['BANK_TRANSFER', 'ALIPAY_CORP', 'WECHAT_CORP', 'CASH']).default('BANK_TRANSFER'),
        payment_ref: z.string().min(2, '请填写打款流水号'),
      })
      .parse(req.body);

    const db = getDb();
    const ts = nowIso();

    await db.transaction(async (tx) => {
      for (const claimId of body.reimbursement_ids) {
        const claim = await tx.queryOne<{
          id: number;
          hotel_id: number;
          status: string;
          cash_advance_id: number | null;
          offset_amount: number;
          net_pay_amount: number;
          payment_type: string;
          payee_name: string;
          payee_bank: string | null;
          payee_account: string | null;
        }>(
          `SELECT id, hotel_id, status, cash_advance_id, offset_amount, net_pay_amount,
                  payment_type, payee_name, payee_bank, payee_account
           FROM reimbursements WHERE id = ?${tx.forUpdateSuffix()}`,
          [claimId]
        );

        if (!claim) throw new AppError(404, `报销单 ${claimId} 不存在`);
        if (claim.status !== 'APPROVED') {
          throw new AppError(400, `报销单 ${claimId} 当前状态不是待打款(APPROVED)`);
        }

        await tx.execute(
          `UPDATE reimbursements
           SET status = 'PAID', payment_channel = ?, payment_ref = ?, paid_by = ?, paid_at = ?, updated_at = ?
           WHERE id = ?`,
          [body.payment_channel, body.payment_ref, req.user!.id, ts, ts, claimId]
        );

        // Save or update payee account in payee_accounts once Finance completes payout
        if (claim.payee_account && claim.payee_bank && claim.payee_name) {
          const pType = claim.payment_type || 'PERSONAL';
          const existingPayee = await tx.queryOne<{ id: number; paid_count: number }>(
            'SELECT id, paid_count FROM payee_accounts WHERE payment_type = ? AND account_number = ?',
            [pType, claim.payee_account]
          );
          if (existingPayee) {
            await tx.execute(
              `UPDATE payee_accounts
               SET account_name = ?, bank_name = ?, hotel_id = ?, last_paid_at = ?, paid_count = ?, updated_at = ?
               WHERE id = ?`,
              [
                claim.payee_name,
                claim.payee_bank,
                claim.hotel_id,
                ts,
                Number(existingPayee.paid_count || 0) + 1,
                ts,
                existingPayee.id,
              ]
            );
          } else {
            await tx.execute(
              `INSERT INTO payee_accounts (
                payment_type, account_name, account_number, bank_name, hotel_id,
                last_paid_at, paid_count, created_by, created_at, updated_at
              ) VALUES (?, ?, ?, ?, ?, ?, 1, ?, ?, ?)`,
              [
                pType,
                claim.payee_name,
                claim.payee_account,
                claim.payee_bank,
                claim.hotel_id,
                ts,
                req.user!.id,
                ts,
                ts,
              ]
            );
          }
        }

        if (claim.cash_advance_id && Number(claim.offset_amount) > 0) {
          const adv = await tx.queryOne<{ id: number; amount: number; offset_amount: number }>(
            `SELECT id, amount, offset_amount FROM cash_advances WHERE id = ?${tx.forUpdateSuffix()}`,
            [claim.cash_advance_id]
          );
          if (adv) {
            const newOffset = roundMoney(Number(adv.offset_amount) + Number(claim.offset_amount));
            const settled = newOffset >= roundMoney(Number(adv.amount));
            await tx.execute(
              `UPDATE cash_advances
               SET offset_amount = ?, status = ?, updated_at = ?
               WHERE id = ?`,
              [newOffset, settled ? 'SETTLED' : 'DISBURSED', ts, adv.id]
            );
          }
        }

        await logApprovalAction(tx, {
          bizType: 'REIMBURSEMENT',
          bizId: claimId,
          action: 'PAY',
          actor: req.user!,
          comment: `财务打款完成（${body.payment_channel}，流水号 ${body.payment_ref}），实付 ¥${Number(
            claim.net_pay_amount
          ).toFixed(2)}`,
        });
      }
    });

    res.json({ ok: true, paidCount: body.reimbursement_ids.length });
  })
);

export default router;
