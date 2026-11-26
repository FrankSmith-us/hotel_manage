import { Router } from 'express';
import { z } from 'zod';
import { getDb } from '../../db';
import {
  AppError,
  asyncHandler,
  authenticate,
  canAccessHotel,
  getScopeFilter,
  isOwnHotel,
  requireRoles,
} from '../middleware/auth';
import { BUSINESS_RULES, assertSegregation } from '../config/businessRules';
import { logApprovalAction } from '../services/auditService';
import {
  buildCashAdvanceRoute,
  buildStatusDetail,
  canUserActOnStep,
  getAvailableAdvanceBalance,
  getUserLastHandledAction,
  getWorkflowStepsWithActors,
  replaceApprovalSteps,
  resolveApprovalRoute,
} from '../services/workflowEngine';
import { UserRole } from '../types';
import { generateCode, isoDateSchema, nowIso, roundMoney, todayStr } from '../utils/numbers';

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
    } else if (tab === 'handled') {
      conditions.push(
        `(EXISTS (SELECT 1 FROM approval_steps s WHERE s.biz_type = 'CASH_ADVANCE' AND s.biz_id = a.id AND s.acted_by = ?)
          OR EXISTS (SELECT 1 FROM approval_logs l WHERE l.biz_type = 'CASH_ADVANCE' AND l.biz_id = a.id AND l.actor_id = ? AND l.action IN ('APPROVE', 'REJECT', 'DISBURSE')))`
      );
      params.push(user.id, user.id);
    } else if (tab === 'available') {
      conditions.push(`a.status = 'DISBURSED'`);
      conditions.push('a.applicant_id = ?');
      params.push(user.id);
      if (req.query.hotelId) {
        conditions.push('a.hotel_id = ?');
        params.push(Number(req.query.hotelId));
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
      repaid_amount: number;
      purpose: string;
      expected_settle_date: string;
      payee_name: string | null;
      payee_bank: string | null;
      payee_account: string | null;
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

    const today = todayStr();
    const enriched = [];
    for (const row of rows) {
      const { availableBalance } = await getAvailableAdvanceBalance(db, row.id);
      if (tab === 'available' && availableBalance <= 0) continue;

      const pendingStep =
        row.status === 'PENDING_APPROVAL'
          ? await db.queryOne<{ step_name: string; approver_role: UserRole; approver_user_id: number | null }>(
              `SELECT step_name, approver_role, approver_user_id FROM approval_steps
               WHERE biz_type = 'CASH_ADVANCE' AND biz_id = ? AND status = 'PENDING'
               ORDER BY step_order ASC LIMIT 1`,
              [row.id]
            )
          : null;

      const canApprove = pendingStep
        ? await canUserActOnStep(db, user, pendingStep.approver_role, row.hotel_id, row.applicant_id, {
            approverUserId: pendingStep.approver_user_id,
            bizType: 'CASH_ADVANCE',
          })
        : false;

      if (tab === 'pending' && !canApprove) continue;

      const steps = await getWorkflowStepsWithActors(db, 'CASH_ADVANCE', row.id);
      const handledInfo =
        tab === 'handled'
          ? await getUserLastHandledAction(db, 'CASH_ADVANCE', row.id, user.id)
          : { my_last_action: null, my_acted_at: null };

      const remainingDebt = Math.max(
        0,
        roundMoney(Number(row.amount) - Number(row.offset_amount || 0) - Number(row.repaid_amount || 0))
      );

      enriched.push({
        ...row,
        repaid_amount: roundMoney(Number(row.repaid_amount || 0)),
        available_balance: availableBalance,
        is_overdue: row.status === 'DISBURSED' && row.expected_settle_date < today,
        current_step_name: pendingStep?.step_name ?? null,
        steps,
        status_detail: buildStatusDetail({
          bizType: 'CASH_ADVANCE',
          status: row.status,
          currentStepName: pendingStep?.step_name ?? null,
          currentStep: row.current_step,
          totalSteps: steps.length,
          paymentRef: row.payment_ref,
        }),
        my_last_action: handledInfo.my_last_action,
        my_acted_at: handledInfo.my_acted_at,
        canApprove,
        canWithdraw:
          Number(row.applicant_id) === Number(user.id) &&
          (row.status === 'PENDING_APPROVAL' || row.status === 'RETURNED'),
        canEdit: Number(row.applicant_id) === Number(user.id) && row.status === 'RETURNED',
        canRepay:
          ['HQ_ADMIN', 'FINANCE'].includes(user.role) &&
          row.status === 'DISBURSED' &&
          remainingDebt > 0,
      });
    }

    res.json({ advances: enriched });
  })
);

const createAdvanceSchema = z.object({
  hotel_id: z.number().int().positive().optional(),
  advance_type: z.enum(['PETTY_CASH', 'TRAVEL']).default('PETTY_CASH'),
  amount: z.number().positive('借款金额必须大于0').max(10_000_000, '单笔借款金额不能超过 1000 万元'),
  purpose: z.string().min(2, '请填写借款用途'),
  expected_settle_date: isoDateSchema,
  payee_name: z.string().trim().optional(),
  payee_bank: z.string().trim().optional(),
  payee_account: z.string().trim().optional(),
  urgency: z.enum(['NORMAL', 'URGENT']).default('NORMAL'),
});

router.post(
  '/',
  asyncHandler(async (req, res) => {
    const body = createAdvanceSchema.parse(req.body);
    const user = req.user!;
    const hotelId = body.hotel_id ?? user.hotel_id;
    if (!hotelId) throw new AppError(400, '请选择所属门店');
    if (!(await canAccessHotel(user, hotelId)) && !isOwnHotel(user, hotelId)) {
      throw new AppError(403, '无权为其他门店申请备用金');
    }

    const today = todayStr();
    if (body.expected_settle_date < today) {
      throw new AppError(400, '预计冲销日期不能早于今天');
    }

    const payeeName = (body.payee_name || user.display_name).trim();
    if (payeeName !== user.display_name) {
      throw new AppError(400, '借款收款人必须为申请人本人');
    }

    const db = getDb();
    const overdueRow = await db.queryOne<{ id: number }>(
      `SELECT id FROM cash_advances
       WHERE applicant_id = ? AND status = 'DISBURSED' AND expected_settle_date < ?
       LIMIT 1`,
      [user.id, today]
    );
    if (overdueRow) {
      throw new AppError(400, '您有已逾期未结清的借款单，请先冲销或还款后再申请新借款');
    }

    const unsettledRow = await db.queryOne<{ total: number }>(
      `SELECT COALESCE(SUM(amount - offset_amount - repaid_amount), 0) AS total
       FROM cash_advances
       WHERE applicant_id = ? AND status IN ('PENDING_APPROVAL', 'RETURNED', 'APPROVED', 'DISBURSED')`,
      [user.id]
    );
    const amount = roundMoney(body.amount);
    const currentUnsettled = roundMoney(Number(unsettledRow?.total || 0));
    if (roundMoney(currentUnsettled + amount) > BUSINESS_RULES.advance.maxUnsettledPerPerson) {
      throw new AppError(
        400,
        `个人未结清借款总额不能超过 ¥${BUSINESS_RULES.advance.maxUnsettledPerPerson.toLocaleString()}（当前未结清 ¥${currentUnsettled.toFixed(2)}）`
      );
    }

    const ts = nowIso();
    const advanceNo = generateCode('ADV');
    const resolved = await resolveApprovalRoute(
      db,
      hotelId,
      buildCashAdvanceRoute({ applicantRole: user.role, amount }),
      user.id
    );
    const route = resolved.steps;

    const advId = await db.transaction(async (tx) => {
      const ins = await tx.execute(
        `INSERT INTO cash_advances (
          advance_no, applicant_id, employee_id, hotel_id, advance_type, amount, offset_amount, repaid_amount,
          purpose, expected_settle_date, payee_name, payee_bank, payee_account,
          urgency, status, current_step, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, 0, 0, ?, ?, ?, ?, ?, ?, 'PENDING_APPROVAL', 1, ?, ?)`,
        [
          advanceNo,
          user.id,
          user.employee_id,
          hotelId,
          body.advance_type,
          amount,
          body.purpose,
          body.expected_settle_date,
          payeeName,
          body.payee_bank || null,
          body.payee_account || null,
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

router.put(
  '/:id',
  asyncHandler(async (req, res) => {
    const id = Number(req.params.id);
    const body = createAdvanceSchema.parse(req.body);
    const user = req.user!;
    const db = getDb();

    const today = todayStr();
    if (body.expected_settle_date < today) {
      throw new AppError(400, '预计冲销日期不能早于今天');
    }

    const payeeName = (body.payee_name || user.display_name).trim();
    if (payeeName !== user.display_name) {
      throw new AppError(400, '借款收款人必须为申请人本人');
    }

    const ts = nowIso();
    const amount = roundMoney(body.amount);

    await db.transaction(async (tx) => {
      const adv = await tx.queryOne<{
        id: number;
        applicant_id: number;
        hotel_id: number;
        status: string;
      }>(`SELECT id, applicant_id, hotel_id, status FROM cash_advances WHERE id = ?${tx.forUpdateSuffix()}`, [id]);
      if (!adv) throw new AppError(404, '借款/备用金单不存在');
      if (Number(adv.applicant_id) !== Number(user.id)) {
        throw new AppError(403, '仅申请人本人可修改并重提借款单');
      }
      if (adv.status !== 'RETURNED') {
        throw new AppError(400, '仅已退回状态的借款单可修改重提');
      }

      const unsettledRow = await tx.queryOne<{ total: number }>(
        `SELECT COALESCE(SUM(amount - offset_amount - repaid_amount), 0) AS total
         FROM cash_advances
         WHERE applicant_id = ? AND id != ? AND status IN ('PENDING_APPROVAL', 'RETURNED', 'APPROVED', 'DISBURSED')`,
        [user.id, id]
      );
      const currentUnsettled = roundMoney(Number(unsettledRow?.total || 0));
      if (roundMoney(currentUnsettled + amount) > BUSINESS_RULES.advance.maxUnsettledPerPerson) {
        throw new AppError(
          400,
          `个人未结清借款总额不能超过 ¥${BUSINESS_RULES.advance.maxUnsettledPerPerson.toLocaleString()}`
        );
      }

      const hotelId = body.hotel_id ?? adv.hotel_id;
      const resolved = await resolveApprovalRoute(
        tx,
        hotelId,
        buildCashAdvanceRoute({ applicantRole: user.role, amount }),
        user.id
      );

      const upd = await tx.execute(
        `UPDATE cash_advances
         SET hotel_id = ?, advance_type = ?, amount = ?, purpose = ?, expected_settle_date = ?,
             payee_name = ?, payee_bank = ?, payee_account = ?, urgency = ?,
             status = 'PENDING_APPROVAL', current_step = 1, updated_at = ?
         WHERE id = ? AND status = 'RETURNED'`,
        [
          hotelId,
          body.advance_type,
          amount,
          body.purpose,
          body.expected_settle_date,
          payeeName,
          body.payee_bank || null,
          body.payee_account || null,
          body.urgency,
          ts,
          id,
        ]
      );
      if (upd.affectedRows !== 1) throw new AppError(409, '借款单状态已变更，请刷新后重试');

      await replaceApprovalSteps(tx, 'CASH_ADVANCE', id, resolved.steps);
      await logApprovalAction(tx, {
        bizType: 'CASH_ADVANCE',
        bizId: id,
        action: 'RESUBMIT',
        actor: user,
        comment: body.purpose,
      });
    });

    const advance = await db.queryOne('SELECT * FROM cash_advances WHERE id = ?', [id]);
    res.json({ advance });
  })
);

router.post(
  '/:id/withdraw',
  asyncHandler(async (req, res) => {
    const id = Number(req.params.id);
    const user = req.user!;
    const db = getDb();
    const ts = nowIso();

    await db.transaction(async (tx) => {
      const adv = await tx.queryOne<{ id: number; applicant_id: number; status: string }>(
        `SELECT id, applicant_id, status FROM cash_advances WHERE id = ?${tx.forUpdateSuffix()}`,
        [id]
      );
      if (!adv) throw new AppError(404, '借款/备用金单不存在');
      if (Number(adv.applicant_id) !== Number(user.id)) {
        throw new AppError(403, '仅申请人本人可撤回借款单');
      }
      if (adv.status !== 'PENDING_APPROVAL' && adv.status !== 'RETURNED') {
        throw new AppError(400, '仅审批中或已退回的借款单可撤回');
      }

      const upd = await tx.execute(
        `UPDATE cash_advances SET status = 'WITHDRAWN', updated_at = ? WHERE id = ? AND status IN ('PENDING_APPROVAL', 'RETURNED')`,
        [ts, id]
      );
      if (upd.affectedRows !== 1) throw new AppError(409, '借款单状态已变更，请刷新后重试');

      await tx.execute(
        `UPDATE approval_steps SET status = 'SKIPPED', skip_reason = '申请人主动撤回'
         WHERE biz_type = 'CASH_ADVANCE' AND biz_id = ? AND status IN ('PENDING', 'WAITING')`,
        [id]
      );
      await logApprovalAction(tx, {
        bizType: 'CASH_ADVANCE',
        bizId: id,
        action: 'WITHDRAW',
        actor: user,
        comment: '申请人主动撤回',
      });
    });

    res.json({ ok: true });
  })
);

router.post(
  '/:id/action',
  asyncHandler(async (req, res) => {
    const id = Number(req.params.id);
    const { action, comment } = z
      .object({
        action: z.enum(['APPROVE', 'REJECT', 'RETURN']),
        comment: z.string().optional().default(''),
      })
      .parse(req.body);

    const db = getDb();
    const ts = nowIso();
    await db.transaction(async (tx) => {
      const adv = await tx.queryOne<{
        id: number;
        hotel_id: number;
        applicant_id: number;
        status: string;
      }>(`SELECT id, hotel_id, applicant_id, status FROM cash_advances WHERE id = ?${tx.forUpdateSuffix()}`, [id]);
      if (!adv) throw new AppError(404, '借款/备用金单不存在');
      if (adv.status !== 'PENDING_APPROVAL') throw new AppError(400, '当前状态不可审批');

      const step = await tx.queryOne<{ id: number; step_order: number; approver_role: UserRole; approver_user_id: number | null }>(
        `SELECT id, step_order, approver_role, approver_user_id FROM approval_steps
         WHERE biz_type = 'CASH_ADVANCE' AND biz_id = ? AND status = 'PENDING'
         ORDER BY step_order ASC LIMIT 1`,
        [id]
      );
      if (!step) throw new AppError(400, '未找到待审批节点');
      if (
        !(await canUserActOnStep(tx, req.user!, step.approver_role, adv.hotel_id, adv.applicant_id, {
          approverUserId: step.approver_user_id,
          bizType: 'CASH_ADVANCE',
        }))
      ) {
        throw new AppError(403, '您无权审批当前借款节点');
      }

      if (action === 'RETURN') {
        const stepUpd = await tx.execute(
          `UPDATE approval_steps SET status = 'RETURNED', acted_by = ?, acted_at = ?, comment = ? WHERE id = ? AND status = 'PENDING'`,
          [req.user!.id, ts, comment || '退回修改', step.id]
        );
        if (stepUpd.affectedRows !== 1) throw new AppError(409, '审批节点状态已变更，请刷新后重试');
        const advUpd = await tx.execute(
          `UPDATE cash_advances SET status = 'RETURNED', updated_at = ? WHERE id = ? AND status = 'PENDING_APPROVAL'`,
          [ts, id]
        );
        if (advUpd.affectedRows !== 1) throw new AppError(409, '借款单状态已变更，请刷新后重试');
      } else if (action === 'REJECT') {
        const stepUpd = await tx.execute(
          `UPDATE approval_steps SET status = 'REJECTED', acted_by = ?, acted_at = ?, comment = ? WHERE id = ? AND status = 'PENDING'`,
          [req.user!.id, ts, comment || '驳回', step.id]
        );
        if (stepUpd.affectedRows !== 1) throw new AppError(409, '审批节点状态已变更，请刷新后重试');
        const advUpd = await tx.execute(
          `UPDATE cash_advances SET status = 'REJECTED', updated_at = ? WHERE id = ? AND status = 'PENDING_APPROVAL'`,
          [ts, id]
        );
        if (advUpd.affectedRows !== 1) throw new AppError(409, '借款单状态已变更，请刷新后重试');
      } else {
        const stepUpd = await tx.execute(
          `UPDATE approval_steps SET status = 'APPROVED', acted_by = ?, acted_at = ?, comment = ? WHERE id = ? AND status = 'PENDING'`,
          [req.user!.id, ts, comment || '同意', step.id]
        );
        if (stepUpd.affectedRows !== 1) throw new AppError(409, '审批节点状态已变更，请刷新后重试');
        const nextStep = await tx.queryOne<{ id: number; step_order: number }>(
          `SELECT id, step_order FROM approval_steps
           WHERE biz_type = 'CASH_ADVANCE' AND biz_id = ? AND step_order > ?
           ORDER BY step_order ASC LIMIT 1`,
          [id, step.step_order]
        );
        if (nextStep) {
          await tx.execute(`UPDATE approval_steps SET status = 'PENDING' WHERE id = ?`, [nextStep.id]);
          await tx.execute(
            `UPDATE cash_advances SET current_step = ?, updated_at = ? WHERE id = ? AND status = 'PENDING_APPROVAL'`,
            [nextStep.step_order, ts, id]
          );
        } else {
          const advUpd = await tx.execute(
            `UPDATE cash_advances SET status = 'APPROVED', updated_at = ? WHERE id = ? AND status = 'PENDING_APPROVAL'`,
            [ts, id]
          );
          if (advUpd.affectedRows !== 1) throw new AppError(409, '借款单状态已变更，请刷新后重试');
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
    const ts = nowIso();
    await db.transaction(async (tx) => {
      const adv = await tx.queryOne<{ id: number; applicant_id: number; status: string }>(
        `SELECT id, applicant_id, status FROM cash_advances WHERE id = ?${tx.forUpdateSuffix()}`,
        [id]
      );
      if (!adv) throw new AppError(404, '借款单不存在');
      assertSegregation(req.user!.id, adv.applicant_id, '禁止为本人的借款单执行放款');
      if (adv.status !== 'APPROVED') throw new AppError(400, '仅已审批通过的借款单可放款');

      const upd = await tx.execute(
        `UPDATE cash_advances SET status = 'DISBURSED', payment_ref = ?, disbursed_at = ?, updated_at = ? WHERE id = ? AND status = 'APPROVED'`,
        [payment_ref, ts, ts, id]
      );
      if (upd.affectedRows !== 1) throw new AppError(409, '借款单状态已变更，请刷新后重试');
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

router.post(
  '/:id/repay',
  requireRoles('HQ_ADMIN', 'FINANCE'),
  asyncHandler(async (req, res) => {
    const id = Number(req.params.id);
    const body = z
      .object({
        amount: z.number().positive('还款金额必须大于0'),
        repayment_method: z.enum(['BANK_TRANSFER', 'CASH', 'SALARY_DEDUCTION']).default('BANK_TRANSFER'),
        payment_ref: z.string().trim().optional().default(''),
        remark: z.string().trim().optional().default(''),
      })
      .parse(req.body);

    const db = getDb();
    const ts = nowIso();
    const repayAmt = roundMoney(body.amount);

    const result = await db.transaction(async (tx) => {
      const adv = await tx.queryOne<{
        id: number;
        applicant_id: number;
        amount: number;
        offset_amount: number;
        repaid_amount: number;
        status: string;
      }>(
        `SELECT id, applicant_id, amount, offset_amount, repaid_amount, status
         FROM cash_advances WHERE id = ?${tx.forUpdateSuffix()}`,
        [id]
      );
      if (!adv) throw new AppError(404, '借款单不存在');
      if (adv.status !== 'DISBURSED') {
        throw new AppError(400, '仅已放款(DISBURSED)的借款单可登记还款');
      }
      const remaining = roundMoney(Number(adv.amount) - Number(adv.offset_amount || 0) - Number(adv.repaid_amount || 0));
      if (repayAmt > remaining) {
        throw new AppError(400, `还款金额不能超过剩余未还金额 ¥${remaining.toFixed(2)}`);
      }

      const newRepaid = roundMoney(Number(adv.repaid_amount || 0) + repayAmt);
      const settled = roundMoney(Number(adv.offset_amount || 0) + newRepaid) >= roundMoney(Number(adv.amount));
      const nextStatus = settled ? 'SETTLED' : 'DISBURSED';

      const upd = await tx.execute(
        `UPDATE cash_advances SET repaid_amount = ?, status = ?, updated_at = ? WHERE id = ? AND status = 'DISBURSED'`,
        [newRepaid, nextStatus, ts, id]
      );
      if (upd.affectedRows !== 1) throw new AppError(409, '借款单状态已变更，请刷新后重试');

      const repaymentNo = generateCode('REP');
      await tx.execute(
        `INSERT INTO cash_advance_repayments (
          advance_id, repayment_no, amount, repayment_method, payment_ref, remark,
          recorded_by, recorded_by_name, repaid_at, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          id,
          repaymentNo,
          repayAmt,
          body.repayment_method,
          body.payment_ref || null,
          body.remark || null,
          req.user!.id,
          req.user!.display_name,
          ts,
          ts,
        ]
      );

      await logApprovalAction(tx, {
        bizType: 'CASH_ADVANCE',
        bizId: id,
        action: 'REPAY',
        actor: req.user!,
        comment: `登记现金/转账还款 ¥${repayAmt.toFixed(2)}（${body.repayment_method}）`,
      });

      return { repaymentNo, status: nextStatus, repaid_amount: newRepaid };
    });

    res.json(result);
  })
);

router.get(
  '/:id/repayments',
  asyncHandler(async (req, res) => {
    const id = Number(req.params.id);
    const db = getDb();
    const adv = await db.queryOne<{ id: number; applicant_id: number; hotel_id: number }>(
      'SELECT id, applicant_id, hotel_id FROM cash_advances WHERE id = ?',
      [id]
    );
    if (!adv) throw new AppError(404, '借款单不存在');
    if (
      Number(adv.applicant_id) !== Number(req.user!.id) &&
      !(await canAccessHotel(req.user!, adv.hotel_id))
    ) {
      throw new AppError(403, '无权查看该借款单还款记录');
    }
    const repayments = await db.query(
      'SELECT * FROM cash_advance_repayments WHERE advance_id = ? ORDER BY id DESC',
      [id]
    );
    res.json({ repayments });
  })
);

export default router;
