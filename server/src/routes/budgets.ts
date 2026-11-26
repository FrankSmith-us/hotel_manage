import { Router } from 'express';
import { z } from 'zod';
import { getDb } from '../../db';
import { asyncHandler, authenticate, getScopeFilter, requireRoles } from '../middleware/auth';
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

export default router;
