import { Router } from 'express';
import { z } from 'zod';
import { getDb } from '../../db';
import { asyncHandler, authenticate, getScopeFilter, requireRoles } from '../middleware/auth';
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
  budget_amount: z.number().min(0),
});

router.put(
  '/',
  requireRoles('HQ_ADMIN', 'FINANCE', 'GENERAL_MANAGER'),
  asyncHandler(async (req, res) => {
    const body = upsertBudgetSchema.parse(req.body);
    const db = getDb();
    const ts = nowIso();
    const amount = roundMoney(body.budget_amount);

    const existing = await db.queryOne<{ id: number }>(
      'SELECT id FROM store_budgets WHERE hotel_id = ? AND `year_month` = ? AND category = ?',
      [body.hotel_id, body.year_month, body.category]
    );

    if (existing) {
      await db.execute(
        'UPDATE store_budgets SET budget_amount = ?, updated_by = ?, updated_at = ? WHERE id = ?',
        [amount, req.user!.id, ts, existing.id]
      );
    } else {
      await db.execute(
        `INSERT INTO store_budgets (hotel_id, \`year_month\`, category, budget_amount, updated_by, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
        [body.hotel_id, body.year_month, body.category, amount, req.user!.id, ts, ts]
      );
    }

    const summary = await getStoreBudgetSummary(db, {
      hotelId: body.hotel_id,
      yearMonth: body.year_month,
      category: body.category,
    });
    res.json({ budget: summary[0] });
  })
);

export default router;
