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
import { logApprovalAction } from '../services/auditService';
import {
  buildCashAdvanceRoute,
  canUserActOnStep,
  getAvailableAdvanceBalance,
  replaceApprovalSteps,
  resolveApprovalRoute,
} from '../services/workflowEngine';
import { UserRole } from '../types';
import { generateCode, nowIso, roundMoney } from '../utils/numbers';

const router = Router();
router.use(authenticate);

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
      conditions.push('a.applicant_id = ?');
      params.push(user.id);
    } else if (tab === 'available') {
      conditions.push(`a.status = 'DISBURSED'`);
      if (req.query.hotelId) {
        conditions.push('a.hotel_id = ?');
        params.push(Number(req.query.hotelId));
      } else if (user.role === 'STAFF') {
        conditions.push('a.applicant_id = ?');
        params.push(user.id);
      } else if (user.hotel_id && scope.type === 'HOTEL') {
        conditions.push('a.hotel_id = ?');
        params.push(scope.hotelId);
      }
    } else if (tab !== 'pending') {
      if (scope.type === 'REGION') {
        if (scope.hotelIds.length === 0) {
          res.json({ advances: [] });
          return;
        }
        conditions.push(`a.hotel_id IN (${scope.hotelIds.map(() => '?').join(',')})`);
        params.push(...scope.hotelIds);
      } else if (scope.type === 'HOTEL') {
        conditions.push('a.hotel_id = ?');
        params.push(scope.hotelId);
      } else if (scope.type === 'SELF') {
        conditions.push('a.applicant_id = ?');
        params.push(user.id);
      }
    }

    const rows = await db.query<{
      id: number;
      advance_no: string;
      applicant_id: number;
      hotel_id: number;
      advance_type: string;
      amount: number;
      offset_amount: number;
      purpose: string;
      expected_settle_date: string;
      status: string;
      current_step: number;
      payment_ref: string | null;
      disbursed_at: string | null;
      created_at: string;
      hotel_name: string;
      applicant_name: string;
    }>(
      `SELECT a.*, h.name AS hotel_name, u.display_name AS applicant_name
       FROM cash_advances a
       JOIN hotels h ON h.id = a.hotel_id
       JOIN users u ON u.id = a.applicant_id
       WHERE ${conditions.join(' AND ')}
       ORDER BY CASE WHEN a.urgency = 'URGENT' THEN 0 ELSE 1 END ASC, a.id DESC`,
      params
    );

    const enriched = [];
    for (const row of rows) {
      const { availableBalance } = await getAvailableAdvanceBalance(db, row.id);
      if (tab === 'available' && availableBalance <= 0) continue;

      const pendingStep =
        row.status === 'PENDING_APPROVAL'
          ? await db.queryOne<{ step_name: string; approver_role: UserRole }>(
              `SELECT step_name, approver_role FROM approval_steps
               WHERE biz_type = 'CASH_ADVANCE' AND biz_id = ? AND status = 'PENDING'
               ORDER BY step_order ASC LIMIT 1`,
              [row.id]
            )
          : null;

      const canApprove = pendingStep
        ? await canUserActOnStep(db, user, pendingStep.approver_role, row.hotel_id, row.applicant_id)
        : false;

      if (tab === 'pending' && !canApprove) continue;

      enriched.push({
        ...row,
        available_balance: availableBalance,
        current_step_name: pendingStep?.step_name ?? null,
        canApprove,
      });
    }

    res.json({ advances: enriched });
  })
);

const createAdvanceSchema = z.object({
  hotel_id: z.number().int().positive().optional(),
  advance_type: z.enum(['PETTY_CASH', 'TRAVEL']).default('PETTY_CASH'),
  amount: z.number().positive('借款金额必须大于0'),
  purpose: z.string().min(2, '请填写借款用途'),
  expected_settle_date: z.string().min(8),
  urgency: z.enum(['NORMAL', 'URGENT']).default('NORMAL'),
});

router.post(
  '/',
  asyncHandler(async (req, res) => {
    const body = createAdvanceSchema.parse(req.body);
    const user = req.user!;
    const hotelId = body.hotel_id ?? user.hotel_id;
    if (!hotelId) throw new AppError(400, '请选择所属门店');
    if (!(await canAccessHotel(user, hotelId))) {
      throw new AppError(403, '无权为其他门店申请备用金');
    }

    const db = getDb();
    const ts = nowIso();
    const advanceNo = generateCode('ADV');
    const amount = roundMoney(body.amount);
    const resolved = await resolveApprovalRoute(
      db,
      hotelId,
      buildCashAdvanceRoute({ applicantRole: user.role, amount })
    );
    const route = resolved.steps;

    const advId = await db.transaction(async (tx) => {
      const ins = await tx.execute(
        `INSERT INTO cash_advances (
          advance_no, applicant_id, employee_id, hotel_id, advance_type, amount, offset_amount,
          purpose, expected_settle_date, urgency, status, current_step, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, 0, ?, ?, ?, 'PENDING_APPROVAL', 1, ?, ?)`,
        [
          advanceNo,
          user.id,
          user.employee_id,
          hotelId,
          body.advance_type,
          amount,
          body.purpose,
          body.expected_settle_date,
          body.urgency,
          ts,
          ts,
        ]
      );
      await replaceApprovalSteps(tx, 'CASH_ADVANCE', ins.insertId, route);
      await logApprovalAction(tx, {
        bizType: 'CASH_ADVANCE',
        bizId: ins.insertId,
        action: 'SUBMIT',
        actor: user,
        comment: body.purpose,
      });
      if (resolved.skippedRegionalManager && resolved.skipReason) {
        await logApprovalAction(tx, {
          bizType: 'CASH_ADVANCE',
          bizId: ins.insertId,
          action: 'AUTO_SKIP',
          actor: user,
          comment: resolved.skipReason,
        });
      }
      return ins.insertId;
    });

    const advance = await db.queryOne('SELECT * FROM cash_advances WHERE id = ?', [advId]);
    res.status(201).json({ advance });
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
    const adv = await db.queryOne<{
      id: number;
      hotel_id: number;
      applicant_id: number;
      status: string;
    }>('SELECT id, hotel_id, applicant_id, status FROM cash_advances WHERE id = ?', [id]);
    if (!adv) throw new AppError(404, '借款/备用金单不存在');
    if (adv.status !== 'PENDING_APPROVAL') throw new AppError(400, '当前状态不可审批');

    const step = await db.queryOne<{ id: number; step_order: number; approver_role: UserRole }>(
      `SELECT id, step_order, approver_role FROM approval_steps
       WHERE biz_type = 'CASH_ADVANCE' AND biz_id = ? AND status = 'PENDING'
       ORDER BY step_order ASC LIMIT 1`,
      [id]
    );
    if (!step) throw new AppError(400, '未找到待审批节点');
    if (!(await canUserActOnStep(db, req.user!, step.approver_role, adv.hotel_id, adv.applicant_id))) {
      throw new AppError(403, '您无权审批当前借款节点');
    }

    const ts = nowIso();
    await db.transaction(async (tx) => {
      if (action === 'REJECT') {
        await tx.execute(
          `UPDATE approval_steps SET status = 'REJECTED', acted_by = ?, acted_at = ?, comment = ? WHERE id = ?`,
          [req.user!.id, ts, comment || '驳回', step.id]
        );
        await tx.execute(`UPDATE cash_advances SET status = 'REJECTED', updated_at = ? WHERE id = ?`, [ts, id]);
      } else {
        await tx.execute(
          `UPDATE approval_steps SET status = 'APPROVED', acted_by = ?, acted_at = ?, comment = ? WHERE id = ?`,
          [req.user!.id, ts, comment || '同意', step.id]
        );
        const nextStep = await tx.queryOne<{ id: number; step_order: number }>(
          `SELECT id, step_order FROM approval_steps
           WHERE biz_type = 'CASH_ADVANCE' AND biz_id = ? AND step_order > ?
           ORDER BY step_order ASC LIMIT 1`,
          [id, step.step_order]
        );
        if (nextStep) {
          await tx.execute(`UPDATE approval_steps SET status = 'PENDING' WHERE id = ?`, [nextStep.id]);
          await tx.execute(`UPDATE cash_advances SET current_step = ?, updated_at = ? WHERE id = ?`, [
            nextStep.step_order,
            ts,
            id,
          ]);
        } else {
          await tx.execute(`UPDATE cash_advances SET status = 'APPROVED', updated_at = ? WHERE id = ?`, [
            ts,
            id,
          ]);
        }
      }
      await logApprovalAction(tx, {
        bizType: 'CASH_ADVANCE',
        bizId: id,
        action,
        actor: req.user!,
        comment,
      });
    });

    res.json({ ok: true });
  })
);

router.post(
  '/:id/disburse',
  requireRoles('HQ_ADMIN', 'FINANCE'),
  asyncHandler(async (req, res) => {
    const id = Number(req.params.id);
    const { payment_ref } = z
      .object({
        payment_ref: z.string().min(2, '请填写财务打款流水号'),
      })
      .parse(req.body);

    const db = getDb();
    const adv = await db.queryOne<{ id: number; status: string }>('SELECT id, status FROM cash_advances WHERE id = ?', [
      id,
    ]);
    if (!adv) throw new AppError(404, '借款单不存在');
    if (adv.status !== 'APPROVED') throw new AppError(400, '仅已审批通过的借款单可放款');

    const ts = nowIso();
    await db.transaction(async (tx) => {
      await tx.execute(
        `UPDATE cash_advances SET status = 'DISBURSED', payment_ref = ?, disbursed_at = ?, updated_at = ? WHERE id = ?`,
        [payment_ref, ts, ts, id]
      );
      await logApprovalAction(tx, {
        bizType: 'CASH_ADVANCE',
        bizId: id,
        action: 'DISBURSE',
        actor: req.user!,
        comment: `已放款，流水号：${payment_ref}`,
      });
    });

    res.json({ ok: true });
  })
);

export default router;
