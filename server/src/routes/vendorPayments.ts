import { Router } from 'express';
import { z } from 'zod';
import { getDb } from '../../db';
import { AppError, asyncHandler, authenticate, canAccessHotel, getScopeFilter, requireRoles } from '../middleware/auth';
import { assertSegregation } from '../config/businessRules';
import { logApprovalAction } from '../services/auditService';
import { replaceApprovalSteps, resolveApprovalRoute } from '../services/workflowEngine';
import { generateCode, nowIso, roundMoney } from '../utils/numbers';

const router = Router();
router.use(authenticate);

router.get(
  '/suppliers',
  asyncHandler(async (req, res) => {
    const db = getDb();
    const status = req.query.status ? String(req.query.status).toUpperCase() : undefined;
    const suppliers = status
      ? await db.query('SELECT * FROM suppliers WHERE status = ? ORDER BY id DESC', [status])
      : await db.query('SELECT * FROM suppliers ORDER BY id DESC');
    res.json({ suppliers });
  })
);

router.post(
  '/suppliers',
  requireRoles('HQ_ADMIN', 'FINANCE', 'REGIONAL_MANAGER', 'STORE_MANAGER'),
  asyncHandler(async (req, res) => {
    const body = z
      .object({
        code: z.string().trim().min(2).max(64),
        name: z.string().trim().min(2).max(128),
        tax_no: z.string().trim().max(64).optional().default(''),
        bank_name: z.string().trim().min(2).max(128),
        bank_account: z.string().trim().min(4).max(64),
        contact_name: z.string().trim().max(64).optional().default(''),
        contact_phone: z.string().trim().max(32).optional().default(''),
      })
      .parse(req.body);

    const db = getDb();
    const dup = await db.queryOne('SELECT id FROM suppliers WHERE code = ?', [body.code]);
    if (dup) throw new AppError(409, '供应商编码已存在');

    const ts = nowIso();
    const ins = await db.execute(
      `INSERT INTO suppliers (code, name, tax_no, bank_name, bank_account, contact_name, contact_phone, status, created_by, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, 'ACTIVE', ?, ?, ?)`,
      [body.code, body.name, body.tax_no || null, body.bank_name, body.bank_account, body.contact_name || null, body.contact_phone || null, req.user!.id, ts, ts]
    );
    const supplier = await db.queryOne('SELECT * FROM suppliers WHERE id = ?', [ins.insertId]);
    res.status(201).json({ supplier });
  })
);

router.patch(
  '/suppliers/:id/status',
  requireRoles('HQ_ADMIN', 'FINANCE'),
  asyncHandler(async (req, res) => {
    const id = Number(req.params.id);
    const { status } = z.object({ status: z.enum(['ACTIVE', 'DISABLED']) }).parse(req.body);
    const db = getDb();
    const existing = await db.queryOne('SELECT id FROM suppliers WHERE id = ?', [id]);
    if (!existing) throw new AppError(404, '供应商不存在');

    await db.execute('UPDATE suppliers SET status = ?, updated_at = ? WHERE id = ?', [status, nowIso(), id]);
    const supplier = await db.queryOne('SELECT * FROM suppliers WHERE id = ?', [id]);
    res.json({ supplier });
  })
);

router.get(
  '/',
  asyncHandler(async (req, res) => {
    const db = getDb();
    const scope = await getScopeFilter(req.user!);
    const conditions = ['1=1'];
    const params: unknown[] = [];

    if (scope.type === 'REGION') {
      if (scope.hotelIds.length === 0) {
        res.json({ payments: [] });
        return;
      }
      conditions.push(`vp.hotel_id IN (${scope.hotelIds.map(() => '?').join(',')})`);
      params.push(...scope.hotelIds);
    } else if (scope.type === 'HOTEL') {
      conditions.push('vp.hotel_id = ?');
      params.push(scope.hotelId);
    } else if (scope.type === 'SELF') {
      conditions.push('vp.applicant_id = ?');
      params.push(req.user!.id);
    }

    if (req.query.hotelId) {
      const hid = Number(req.query.hotelId);
      if (!(await canAccessHotel(req.user!, hid))) throw new AppError(403, '无权查看该门店对公付款');
      conditions.push('vp.hotel_id = ?');
      params.push(hid);
    }
    if (req.query.status) {
      conditions.push('vp.status = ?');
      params.push(String(req.query.status));
    }

    const payments = await db.query(
      `SELECT vp.*, s.name AS supplier_name, s.bank_name AS supplier_bank_name, s.bank_account AS supplier_bank_account,
              h.name AS hotel_name, u.display_name AS applicant_name
       FROM vendor_payments vp
       JOIN suppliers s ON s.id = vp.supplier_id
       JOIN hotels h ON h.id = vp.hotel_id
       JOIN users u ON u.id = vp.applicant_id
       WHERE ${conditions.join(' AND ')}
       ORDER BY vp.id DESC`,
      params
    );
    res.json({ payments });
  })
);

router.post(
  '/',
  asyncHandler(async (req, res) => {
    const body = z
      .object({
        supplier_id: z.number().int().positive(),
        hotel_id: z.number().int().positive(),
        expense_month: z.string().regex(/^\d{4}-\d{2}$/),
        category: z.string().trim().min(1).max(64),
        amount: z.number().positive(),
        invoice_no: z.string().trim().max(64).optional().default(''),
        description: z.string().trim().min(2),
      })
      .parse(req.body);

    if (!(await canAccessHotel(req.user!, body.hotel_id))) {
      throw new AppError(403, '无权为该门店发起对公付款');
    }

    const db = getDb();
    const supplier = await db.queryOne<{ id: number; status: string }>('SELECT id, status FROM suppliers WHERE id = ?', [body.supplier_id]);
    if (!supplier) throw new AppError(404, '供应商不存在');
    if (supplier.status !== 'ACTIVE') throw new AppError(400, '供应商已停用，无法发起对公付款');

    const amount = roundMoney(body.amount);
    const baseSteps: Array<{ stepOrder: number; stepName: string; approverRole: 'REGIONAL_MANAGER' | 'FINANCE' | 'GENERAL_MANAGER' }> = [
      { stepOrder: 1, stepName: '区域经理审核', approverRole: 'REGIONAL_MANAGER' },
      { stepOrder: 2, stepName: '集团财务审批', approverRole: 'FINANCE' },
    ];
    if (amount >= 5000) {
      baseSteps.push({ stepOrder: 3, stepName: '集团总经理审批', approverRole: 'GENERAL_MANAGER' });
    }

    const resolved = await resolveApprovalRoute(db, body.hotel_id, baseSteps, req.user!.id);
    const ts = nowIso();
    const paymentNo = generateCode('VP');

    const vpId = await db.transaction(async (tx) => {
      const ins = await tx.execute(
        `INSERT INTO vendor_payments (
          payment_no, supplier_id, hotel_id, expense_month, category, amount,
          invoice_no, description, applicant_id, status, current_step, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'PENDING_APPROVAL', 1, ?, ?)`,
        [paymentNo, body.supplier_id, body.hotel_id, body.expense_month, body.category, amount, body.invoice_no || null, body.description, req.user!.id, ts, ts]
      );
      await replaceApprovalSteps(tx, 'VENDOR_PAYMENT', ins.insertId, resolved.steps);
      await logApprovalAction(tx, {
        bizType: 'VENDOR_PAYMENT',
        bizId: ins.insertId,
        action: 'SUBMIT',
        actor: req.user!,
        comment: body.description,
      });
      return ins.insertId;
    });

    const payment = await db.queryOne('SELECT * FROM vendor_payments WHERE id = ?', [vpId]);
    res.status(201).json({ payment });
  })
);

router.post(
  '/:id/action',
  asyncHandler(async (req, res) => {
    const id = Number(req.params.id);
    const { action, comment } = z
      .object({
        action: z.enum(['APPROVE', 'REJECT']),
        comment: z.string().optional().default(''),
      })
      .parse(req.body);

    const db = getDb();
    const ts = nowIso();

    const payment = await db.transaction(async (tx) => {
      const row = await tx.queryOne<any>(
        `SELECT * FROM vendor_payments WHERE id = ?${tx.forUpdateSuffix()}`,
        [id]
      );
      if (!row) throw new AppError(404, '对公付款单不存在');
      if (row.status !== 'PENDING_APPROVAL') throw new AppError(409, '单据状态已变化，请刷新后重试');

      assertSegregation(req.user!.id, Number(row.applicant_id), '申请人不可审批自己的对公付款单');

      const step = await tx.queryOne<any>(
        `SELECT * FROM approval_steps
         WHERE biz_type = 'VENDOR_PAYMENT' AND biz_id = ? AND step_order = ?`,
        [id, row.current_step]
      );
      if (!step) throw new AppError(409, '未找到当前审批节点');

      const canAct =
        req.user!.role === 'HQ_ADMIN' ||
        step.approver_id === req.user!.id ||
        step.approver_role === req.user!.role;
      if (!canAct) throw new AppError(403, '当前节点无权审批');

      await tx.execute(
        `UPDATE approval_steps SET status = ?, acted_by = ?, acted_at = ?, comment = ? WHERE id = ?`,
        [action === 'APPROVE' ? 'APPROVED' : 'REJECTED', req.user!.id, ts, comment || null, step.id]
      );

      if (action === 'REJECT') {
        const upd = await tx.execute(
          `UPDATE vendor_payments SET status = 'REJECTED', updated_at = ? WHERE id = ? AND status = 'PENDING_APPROVAL'`,
          [ts, id]
        );
        if (upd.affectedRows !== 1) throw new AppError(409, '单据状态已变化，请刷新后重试');
      } else {
        const nextStep = await tx.queryOne<any>(
          `SELECT * FROM approval_steps WHERE biz_type = 'VENDOR_PAYMENT' AND biz_id = ? AND step_order = ?`,
          [id, Number(row.current_step) + 1]
        );
        if (nextStep) {
          const upd = await tx.execute(
            `UPDATE vendor_payments SET current_step = ?, updated_at = ? WHERE id = ? AND status = 'PENDING_APPROVAL'`,
            [Number(row.current_step) + 1, ts, id]
          );
          if (upd.affectedRows !== 1) throw new AppError(409, '单据状态已变化，请刷新后重试');
        } else {
          const upd = await tx.execute(
            `UPDATE vendor_payments SET status = 'APPROVED', updated_at = ? WHERE id = ? AND status = 'PENDING_APPROVAL'`,
            [ts, id]
          );
          if (upd.affectedRows !== 1) throw new AppError(409, '单据状态已变化，请刷新后重试');
        }
      }

      await logApprovalAction(tx, {
        bizType: 'VENDOR_PAYMENT',
        bizId: id,
        action,
        actor: req.user!,
        comment,
      });

      return tx.queryOne('SELECT * FROM vendor_payments WHERE id = ?', [id]);
    });

    res.json({ payment });
  })
);

router.post(
  '/:id/pay',
  requireRoles('FINANCE', 'HQ_ADMIN'),
  asyncHandler(async (req, res) => {
    const id = Number(req.params.id);
    const { pay_reference } = z
      .object({ pay_reference: z.string().trim().max(64).optional().default('') })
      .parse(req.body || {});

    const db = getDb();
    const ts = nowIso();
    const ref = pay_reference || generateCode('PAY');

    const payment = await db.transaction(async (tx) => {
      const row = await tx.queryOne<any>(
        `SELECT * FROM vendor_payments WHERE id = ?${tx.forUpdateSuffix()}`,
        [id]
      );
      if (!row) throw new AppError(404, '对公付款单不存在');
      if (row.status !== 'APPROVED') throw new AppError(409, '仅已审批通过的对公付款单可执行打款');

      assertSegregation(req.user!.id, Number(row.applicant_id), '申请人不可对自己的对公付款单执行打款');

      const upd = await tx.execute(
        `UPDATE vendor_payments SET status = 'PAID', paid_by = ?, paid_at = ?, pay_reference = ?, updated_at = ? WHERE id = ? AND status = 'APPROVED'`,
        [req.user!.id, ts, ref, ts, id]
      );
      if (upd.affectedRows !== 1) throw new AppError(409, '单据状态已变化，请刷新后重试');

      await logApprovalAction(tx, {
        bizType: 'VENDOR_PAYMENT',
        bizId: id,
        action: 'PAY',
        actor: req.user!,
        comment: `对公打款完成，流水号：${ref}`,
      });

      return tx.queryOne('SELECT * FROM vendor_payments WHERE id = ?', [id]);
    });

    res.json({ payment });
  })
);

export default router;
