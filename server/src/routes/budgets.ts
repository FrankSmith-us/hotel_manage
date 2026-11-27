import { Router } from 'express';
import { z } from 'zod';
import { getDb } from '../../db';
import { AppError, asyncHandler, authenticate, canAccessHotel, getScopeFilter, requireRoles } from '../middleware/auth';
import { logApprovalAction } from '../services/auditService';
import { getStoreBudgetSummary } from '../services/budgetService';
import { currentYearMonth, nowIso, roundMoney } from '../utils/numbers';

const router = Router();
router.use(authenticate);

router.get(
  '/',
  asyncHandler(async (req, res) => {
    const db = getDb();
    const yearMonth = String(req.query.yearMonth || currentYearMonth());
    const scope = await getScopeFilter(req.user!);

    let hotelId = req.query.hotelId ? Number(req.query.hotelId) : undefined;
    let hotelIds: number[] | undefined;

    if (scope.type === 'REGION') {
      hotelIds = scope.hotelIds;
      if (hotelId && !hotelIds.includes(hotelId)) {
        res.json({ yearMonth, budgets: [] });
        return;
      }
    } else if (scope.type === 'HOTEL' || scope.type === 'SELF') {
      hotelId = scope.hotelId;
    }

    const budgets = await getStoreBudgetSummary(db, {
      hotelId,
      hotelIds,
      yearMonth,
      category: req.query.category ? String(req.query.category) : undefined,
    });

    res.json({ yearMonth, budgets });
  })
);

const upsertBudgetSchema = z.object({
  hotel_id: z.number().int().positive(),
  year_month: z.string().regex(/^\d{4}-\d{2}$/),
  category: z.enum([
    'LINEN_SUPPLIES',
    'MAINTENANCE',
    'FB_PROCUREMENT',
    'UTILITIES',
    'MARKETING',
    'TRAVEL_TRAINING',
    'OTHER',
  ]),
  budget_amount: z.number().min(0).max(100_000_000, '预算金额超出合理范围'),
  reason: z.string().trim().min(2, '请填写预算调整原因'),
});

router.put(
  '/',
  requireRoles('HQ_ADMIN', 'FINANCE', 'GENERAL_MANAGER'),
  asyncHandler(async (req, res) => {
    const body = upsertBudgetSchema.parse(req.body);
    const db = getDb();
    const ts = nowIso();
    const amount = roundMoney(body.budget_amount);

    await db.transaction(async (tx) => {
      const existing = await tx.queryOne<{ id: number; budget_amount: number }>(
        'SELECT id, budget_amount FROM store_budgets WHERE hotel_id = ? AND `year_month` = ? AND category = ?',
        [body.hotel_id, body.year_month, body.category]
      );
      const oldAmount = existing ? roundMoney(Number(existing.budget_amount)) : 0;

      let budgetId: number;
      if (existing) {
        await tx.execute(
          'UPDATE store_budgets SET budget_amount = ?, updated_by = ?, updated_at = ? WHERE id = ?',
          [amount, req.user!.id, ts, existing.id]
        );
        budgetId = existing.id;
      } else {
        const ins = await tx.execute(
          `INSERT INTO store_budgets (hotel_id, \`year_month\`, category, budget_amount, updated_by, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?)`,
          [body.hotel_id, body.year_month, body.category, amount, req.user!.id, ts, ts]
        );
        budgetId = ins.insertId;
      }

      await tx.execute(
        `INSERT INTO budget_change_logs (hotel_id, \`year_month\`, category, old_amount, new_amount, reason, changed_by, changed_by_name, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [body.hotel_id, body.year_month, body.category, oldAmount, amount, body.reason, req.user!.id, req.user!.display_name, ts]
      );

      await logApprovalAction(tx, {
        bizType: 'BUDGET',
        bizId: budgetId,
        action: 'UPSERT_BUDGET',
        actor: req.user!,
        comment: `门店 ${body.hotel_id} ${body.year_month} ${body.category} 预算：${oldAmount} -> ${amount}（${body.reason}）`,
      });
    });

    const summary = await getStoreBudgetSummary(db, {
      hotelId: body.hotel_id,
      yearMonth: body.year_month,
      category: body.category,
    });
    res.json({ budget: summary[0] });
  })
);

router.get(
  '/logs',
  asyncHandler(async (req, res) => {
    const db = getDb();
    const scope = await getScopeFilter(req.user!);
    const conditions = ['1=1'];
    const params: unknown[] = [];

    if (scope.type === 'REGION') {
      if (scope.hotelIds.length === 0) {
        res.json({ logs: [] });
        return;
      }
      conditions.push(`l.hotel_id IN (${scope.hotelIds.map(() => '?').join(',')})`);
      params.push(...scope.hotelIds);
    } else if (scope.type === 'HOTEL' || scope.type === 'SELF') {
      conditions.push('l.hotel_id = ?');
      params.push(scope.hotelId);
    }

    if (req.query.yearMonth) {
      conditions.push('l.`year_month` = ?');
      params.push(String(req.query.yearMonth));
    }
    if (req.query.hotelId) {
      conditions.push('l.hotel_id = ?');
      params.push(Number(req.query.hotelId));
    }

    const logs = await db.query(
      `SELECT l.*, h.name AS hotel_name
       FROM budget_change_logs l
       JOIN hotels h ON h.id = l.hotel_id
       WHERE ${conditions.join(' AND ')}
       ORDER BY l.id DESC
       LIMIT 100`,
      params
    );
    res.json({ logs });
  })
);

router.get(
  '/annual',
  asyncHandler(async (req, res) => {
    const db = getDb();
    const scope = await getScopeFilter(req.user!);
    const conditions = ['1=1'];
    const params: unknown[] = [];

    if (scope.type === 'REGION') {
      if (scope.hotelIds.length === 0) {
        res.json({ annual_budgets: [] });
        return;
      }
      conditions.push(`a.hotel_id IN (${scope.hotelIds.map(() => '?').join(',')})`);
      params.push(...scope.hotelIds);
    } else if (scope.type === 'HOTEL' || scope.type === 'SELF') {
      conditions.push('a.hotel_id = ?');
      params.push(scope.hotelId);
    }

    if (req.query.hotelId) {
      conditions.push('a.hotel_id = ?');
      params.push(Number(req.query.hotelId));
    }
    if (req.query.year) {
      conditions.push('a.fiscal_year = ?');
      params.push(Number(req.query.year));
    }

    const annualBudgets = await db.query(
      `SELECT a.*, h.name AS hotel_name
       FROM annual_budgets a
       JOIN hotels h ON h.id = a.hotel_id
       WHERE ${conditions.join(' AND ')}
       ORDER BY a.fiscal_year DESC, a.hotel_id ASC, a.category ASC`,
      params
    );
    res.json({ annual_budgets: annualBudgets });
  })
);

router.put(
  '/annual',
  requireRoles('HQ_ADMIN', 'FINANCE', 'GENERAL_MANAGER'),
  asyncHandler(async (req, res) => {
    const body = z
      .object({
        hotel_id: z.number().int().positive(),
        fiscal_year: z.number().int().min(2020).max(2099),
        category: z.string().trim().min(1).max(64),
        annual_amount: z.number().nonnegative(),
      })
      .parse(req.body);

    const db = getDb();
    const hotel = await db.queryOne('SELECT id FROM hotels WHERE id = ?', [body.hotel_id]);
    if (!hotel) throw new AppError(404, '门店不存在');

    const amount = roundMoney(body.annual_amount);
    const ts = nowIso();
    const existing = await db.queryOne<{ id: number }>(
      'SELECT id FROM annual_budgets WHERE hotel_id = ? AND fiscal_year = ? AND category = ?',
      [body.hotel_id, body.fiscal_year, body.category]
    );

    let id: number;
    if (existing) {
      await db.execute(
        'UPDATE annual_budgets SET annual_amount = ?, updated_by = ?, updated_at = ? WHERE id = ?',
        [amount, req.user!.id, ts, existing.id]
      );
      id = existing.id;
    } else {
      const ins = await db.execute(
        `INSERT INTO annual_budgets (hotel_id, fiscal_year, category, annual_amount, updated_by, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
        [body.hotel_id, body.fiscal_year, body.category, amount, req.user!.id, ts, ts]
      );
      id = ins.insertId;
    }

    const row = await db.queryOne('SELECT * FROM annual_budgets WHERE id = ?', [id]);
    res.json({ annual_budget: row });
  })
);

router.post(
  '/annual/distribute',
  requireRoles('HQ_ADMIN', 'FINANCE', 'GENERAL_MANAGER'),
  asyncHandler(async (req, res) => {
    const body = z
      .object({
        hotel_id: z.number().int().positive(),
        fiscal_year: z.number().int().min(2020).max(2099),
        category: z.string().trim().min(1).max(64),
        reason: z.string().trim().optional().default('年度预算按月拆分下发'),
      })
      .parse(req.body);

    const db = getDb();
    const annual = await db.queryOne<{ id: number; annual_amount: number }>(
      'SELECT id, annual_amount FROM annual_budgets WHERE hotel_id = ? AND fiscal_year = ? AND category = ?',
      [body.hotel_id, body.fiscal_year, body.category]
    );
    if (!annual) throw new AppError(404, '未找到对应的年度预算配置');

    const total = roundMoney(Number(annual.annual_amount));
    const baseMonthly = roundMoney(total / 12);
    const lastMonth = roundMoney(total - baseMonthly * 11);
    const ts = nowIso();

    await db.transaction(async (tx) => {
      for (let m = 1; m <= 12; m += 1) {
        const ym = `${body.fiscal_year}-${String(m).padStart(2, '0')}`;
        const monthAmount = m === 12 ? lastMonth : baseMonthly;
        const existing = await tx.queryOne<{ id: number; budget_amount: number }>(
          'SELECT id, budget_amount FROM store_budgets WHERE hotel_id = ? AND `year_month` = ? AND category = ?',
          [body.hotel_id, ym, body.category]
        );
        const oldAmount = existing ? roundMoney(Number(existing.budget_amount)) : 0;
        if (existing) {
          await tx.execute(
            'UPDATE store_budgets SET budget_amount = ?, updated_by = ?, updated_at = ? WHERE id = ?',
            [monthAmount, req.user!.id, ts, existing.id]
          );
        } else {
          await tx.execute(
            `INSERT INTO store_budgets (hotel_id, \`year_month\`, category, budget_amount, updated_by, created_at, updated_at)
             VALUES (?, ?, ?, ?, ?, ?, ?)`,
            [body.hotel_id, ym, body.category, monthAmount, req.user!.id, ts, ts]
          );
        }
        await tx.execute(
          `INSERT INTO budget_change_logs (hotel_id, \`year_month\`, category, old_amount, new_amount, reason, changed_by, changed_by_name, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          [body.hotel_id, ym, body.category, oldAmount, monthAmount, body.reason, req.user!.id, req.user!.display_name, ts]
        );
      }
      await logApprovalAction(tx, {
        bizType: 'BUDGET',
        bizId: annual.id,
        action: 'DISTRIBUTE_ANNUAL_BUDGET',
        actor: req.user!,
        comment: `门店 ${body.hotel_id} ${body.fiscal_year} ${body.category} 年度预算 ${total} 按 12 个月下发`,
      });
    });

    res.json({ distributed_months: 12, annual_amount: total });
  })
);

router.post(
  '/transfer',
  requireRoles('HQ_ADMIN', 'FINANCE', 'GENERAL_MANAGER', 'REGIONAL_MANAGER'),
  asyncHandler(async (req, res) => {
    const body = z
      .object({
        hotel_id: z.number().int().positive(),
        category: z.string().trim().min(1).max(64),
        from_month: z.string().regex(/^\d{4}-\d{2}$/),
        to_month: z.string().regex(/^\d{4}-\d{2}$/),
        amount: z.number().positive(),
        reason: z.string().trim().min(2),
      })
      .parse(req.body);

    if (body.from_month === body.to_month) {
      throw new AppError(400, '转出月份与转入月份不能相同');
    }
    if (!(await canAccessHotel(req.user!, body.hotel_id))) {
      throw new AppError(403, '无权调剂该门店预算');
    }

    const db = getDb();
    const transferAmt = roundMoney(body.amount);
    const ts = nowIso();

    const result = await db.transaction(async (tx) => {
      const fromRow = await tx.queryOne<{ id: number; budget_amount: number }>(
        `SELECT id, budget_amount FROM store_budgets
         WHERE hotel_id = ? AND \`year_month\` = ? AND category = ?${tx.forUpdateSuffix()}`,
        [body.hotel_id, body.from_month, body.category]
      );
      const fromOld = fromRow ? roundMoney(Number(fromRow.budget_amount)) : 0;
      const fromNew = roundMoney(fromOld - transferAmt);
      if (!fromRow || fromNew < 0) {
        throw new AppError(400, '转出月份预算余额不足');
      }

      const toRow = await tx.queryOne<{ id: number; budget_amount: number }>(
        `SELECT id, budget_amount FROM store_budgets
         WHERE hotel_id = ? AND \`year_month\` = ? AND category = ?${tx.forUpdateSuffix()}`,
        [body.hotel_id, body.to_month, body.category]
      );
      const toOld = toRow ? roundMoney(Number(toRow.budget_amount)) : 0;
      const toNew = roundMoney(toOld + transferAmt);

      await tx.execute(
        'UPDATE store_budgets SET budget_amount = ?, updated_by = ?, updated_at = ? WHERE id = ?',
        [fromNew, req.user!.id, ts, fromRow.id]
      );
      if (toRow) {
        await tx.execute(
          'UPDATE store_budgets SET budget_amount = ?, updated_by = ?, updated_at = ? WHERE id = ?',
          [toNew, req.user!.id, ts, toRow.id]
        );
      } else {
        await tx.execute(
          `INSERT INTO store_budgets (hotel_id, \`year_month\`, category, budget_amount, updated_by, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?)`,
          [body.hotel_id, body.to_month, body.category, toNew, req.user!.id, ts, ts]
        );
      }

      await tx.execute(
        `INSERT INTO budget_change_logs (hotel_id, \`year_month\`, category, old_amount, new_amount, reason, changed_by, changed_by_name, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [body.hotel_id, body.from_month, body.category, fromOld, fromNew, `滚动调出至 ${body.to_month}：${body.reason}`, req.user!.id, req.user!.display_name, ts]
      );
      await tx.execute(
        `INSERT INTO budget_change_logs (hotel_id, \`year_month\`, category, old_amount, new_amount, reason, changed_by, changed_by_name, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [body.hotel_id, body.to_month, body.category, toOld, toNew, `自 ${body.from_month} 滚动调入：${body.reason}`, req.user!.id, req.user!.display_name, ts]
      );

      await logApprovalAction(tx, {
        bizType: 'BUDGET',
        bizId: fromRow.id,
        action: 'TRANSFER_BUDGET',
        actor: req.user!,
        comment: `门店 ${body.hotel_id} ${body.category} 预算从 ${body.from_month} 结转 ${transferAmt} 至 ${body.to_month}（${body.reason}）`,
      });

      return { from_month: body.from_month, from_amount: fromNew, to_month: body.to_month, to_amount: toNew };
    });

    res.json(result);
  })
);

export default router;
