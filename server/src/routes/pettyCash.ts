import { Router } from 'express';
import { getDb } from '../../db';
import { AppError, asyncHandler, authenticate, canAccessHotel, requireRoles } from '../middleware/auth';
import { BUSINESS_RULES } from '../config/businessRules';
import { nowIso, roundMoney } from '../utils/numbers';

const router = Router();
router.use(authenticate);

router.get(
  '/funds',
  asyncHandler(async (req, res) => {
    const db = getDb();
    const { hotel_id } = req.query;
    const params: any[] = [];
    let where = 'WHERE 1=1';

    if (hotel_id) {
      const hid = Number(hotel_id);
      if (!(await canAccessHotel(req.user!, hid))) {
        throw new AppError(403, '无权查看该门店备用金');
      }
      where += ' AND f.hotel_id = ?';
      params.push(hid);
    }

    const rows = await db.query<any>(
      `SELECT f.*, h.name AS hotel_name, h.code AS hotel_code, u.display_name AS custodian_name
       FROM petty_cash_funds f
       JOIN hotels h ON h.id = f.hotel_id
       LEFT JOIN users u ON u.id = f.custodian_user_id
       ${where}
       ORDER BY f.hotel_id ASC`,
      params,
    );

    const visible = [];
    for (const r of rows) {
      if (await canAccessHotel(req.user!, Number(r.hotel_id))) {
        visible.push(r);
      }
    }
    res.json({ funds: visible });
  }),
);

router.post(
  '/funds',
  requireRoles('HQ_ADMIN', 'FINANCE'),
  asyncHandler(async (req, res) => {
    const db = getDb();
    const hotelId = Number(req.body?.hotel_id);
    if (!hotelId) throw new AppError(400, '缺少 hotel_id');

    const quotaAmount =
      req.body?.quota_amount !== undefined && req.body?.quota_amount !== null
        ? roundMoney(Number(req.body.quota_amount))
        : BUSINESS_RULES.pettyCash.defaultQuota;
    if (!Number.isFinite(quotaAmount) || quotaAmount <= 0) {
      throw new AppError(400, '定额备用金额度必须大于 0');
    }

    const custodianUserId = req.body?.custodian_user_id ? Number(req.body.custodian_user_id) : null;
    const now = nowIso();

    const result = await db.transaction(async (tx) => {
      const hotel = await tx.queryOne<{ id: number }>(`SELECT id FROM hotels WHERE id = ?`, [hotelId]);
      if (!hotel) throw new AppError(404, '门店不存在');

      const existing = await tx.queryOne<any>(
        `SELECT * FROM petty_cash_funds WHERE hotel_id = ?${tx.forUpdateSuffix()}`,
        [hotelId],
      );

      if (!existing) {
        const ins = await tx.execute(
          `INSERT INTO petty_cash_funds (hotel_id, quota_amount, current_balance, custodian_user_id, status, updated_at, created_at)
           VALUES (?, ?, ?, ?, 'ACTIVE', ?, ?)`,
          [hotelId, quotaAmount, quotaAmount, custodianUserId, now, now],
        );
        const fundId = ins.insertId;
        await tx.execute(
          `INSERT INTO petty_cash_ledger (fund_id, tx_type, amount, balance_after, description, operator_id, created_at)
           VALUES (?, 'INIT', ?, ?, '初始化定额备用金', ?, ?)`,
          [fundId, quotaAmount, quotaAmount, req.user!.id, now],
        );
        const created = await tx.queryOne<any>(`SELECT * FROM petty_cash_funds WHERE id = ?`, [fundId]);
        return { created: true, fund: created };
      }

      const nextCustodian = custodianUserId ?? existing.custodian_user_id ?? null;
      await tx.execute(
        `UPDATE petty_cash_funds SET quota_amount = ?, custodian_user_id = ?, updated_at = ? WHERE id = ?`,
        [quotaAmount, nextCustodian, now, existing.id],
      );
      await tx.execute(
        `INSERT INTO petty_cash_ledger (fund_id, tx_type, amount, balance_after, description, operator_id, created_at)
         VALUES (?, 'QUOTA_ADJUST', ?, ?, ?, ?, ?)`,
        [
          existing.id,
          quotaAmount,
          roundMoney(Number(existing.current_balance)),
          `调整定额为 ${quotaAmount}`,
          req.user!.id,
          now,
        ],
      );
      const updated = await tx.queryOne<any>(`SELECT * FROM petty_cash_funds WHERE id = ?`, [existing.id]);
      return { created: false, fund: updated };
    });

    res.status(result.created ? 201 : 200).json({ fund: result.fund });
  }),
);

router.post(
  '/funds/:id/tx',
  requireRoles('HQ_ADMIN', 'FINANCE', 'STORE_MANAGER', 'REGIONAL_MANAGER'),
  asyncHandler(async (req, res) => {
    const db = getDb();
    const fundId = Number(req.params.id);
    const txType = String(req.body?.tx_type || '').toUpperCase();
    const amount = roundMoney(Number(req.body?.amount));
    const description = String(req.body?.description || '').trim();

    if (!['EXPENSE', 'REPLENISH'].includes(txType)) {
      throw new AppError(400, 'tx_type 必须为 EXPENSE 或 REPLENISH');
    }
    if (!Number.isFinite(amount) || amount <= 0) {
      throw new AppError(400, '金额必须大于 0');
    }
    if (!description) {
      throw new AppError(400, '请填写摘要说明');
    }

    const result = await db.transaction(async (tx) => {
      const fund = await tx.queryOne<any>(
        `SELECT * FROM petty_cash_funds WHERE id = ?${tx.forUpdateSuffix()}`,
        [fundId],
      );
      if (!fund) throw new AppError(404, '备用金账户不存在');
      if (fund.status !== 'ACTIVE') throw new AppError(400, '备用金账户已停用');
      if (!(await canAccessHotel(req.user!, Number(fund.hotel_id)))) {
        throw new AppError(403, '无权操作该门店备用金');
      }

      const cur = roundMoney(Number(fund.current_balance));
      const quota = roundMoney(Number(fund.quota_amount));
      const nextBalance = txType === 'EXPENSE' ? roundMoney(cur - amount) : roundMoney(cur + amount);

      if (nextBalance < 0) {
        throw new AppError(400, '备用金余额不足，无法支取');
      }
      if (nextBalance > quota) {
        throw new AppError(400, '补足后余额不能超过定额上限');
      }

      const now = nowIso();
      await tx.execute(
        `UPDATE petty_cash_funds SET current_balance = ?, updated_at = ? WHERE id = ?`,
        [nextBalance, now, fundId],
      );
      const ins = await tx.execute(
        `INSERT INTO petty_cash_ledger (fund_id, tx_type, amount, balance_after, description, operator_id, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
        [fundId, txType, amount, nextBalance, description, req.user!.id, now],
      );

      const updatedFund = await tx.queryOne<any>(`SELECT * FROM petty_cash_funds WHERE id = ?`, [fundId]);
      const entry = await tx.queryOne<any>(`SELECT * FROM petty_cash_ledger WHERE id = ?`, [ins.insertId]);
      return { fund: updatedFund, entry };
    });

    res.status(201).json(result);
  }),
);

router.get(
  '/funds/:id/ledger',
  asyncHandler(async (req, res) => {
    const db = getDb();
    const fundId = Number(req.params.id);
    const fund = await db.queryOne<any>(`SELECT * FROM petty_cash_funds WHERE id = ?`, [fundId]);
    if (!fund) throw new AppError(404, '备用金账户不存在');
    if (!(await canAccessHotel(req.user!, Number(fund.hotel_id)))) {
      throw new AppError(403, '无权查看该门店备用金流水');
    }

    const entries = await db.query<any>(
      `SELECT l.*, u.display_name AS operator_name
       FROM petty_cash_ledger l
       JOIN users u ON u.id = l.operator_id
       WHERE l.fund_id = ?
       ORDER BY l.id DESC`,
      [fundId],
    );
    res.json({ fund, entries });
  }),
);

export default router;
