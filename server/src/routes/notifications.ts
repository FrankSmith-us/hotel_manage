import { Router } from 'express';
import { z } from 'zod';
import { getDb } from '../../db';
import { AppError, asyncHandler, authenticate } from '../middleware/auth';
import { nowIso } from '../utils/numbers';

const router = Router();
router.use(authenticate);

router.get(
  '/',
  asyncHandler(async (req, res) => {
    const db = getDb();
    const user = req.user!;
    const notifications = await db.query(
      `SELECT * FROM notifications WHERE user_id = ? ORDER BY id DESC LIMIT 50`,
      [user.id]
    );
    const unreadRow = await db.queryOne<{ cnt: number }>(
      `SELECT COUNT(*) AS cnt FROM notifications WHERE user_id = ? AND is_read = 0`,
      [user.id]
    );
    res.json({
      notifications,
      unreadCount: Number(unreadRow?.cnt || 0),
    });
  })
);

router.post(
  '/:id/read',
  asyncHandler(async (req, res) => {
    const id = Number(req.params.id);
    const db = getDb();
    const ts = nowIso();
    const upd = await db.execute(
      `UPDATE notifications SET is_read = 1, read_at = ? WHERE id = ? AND user_id = ?`,
      [ts, id, req.user!.id]
    );
    if (upd.affectedRows !== 1) throw new AppError(404, '通知不存在');
    res.json({ ok: true });
  })
);

router.post(
  '/read-all',
  asyncHandler(async (req, res) => {
    const db = getDb();
    const ts = nowIso();
    const upd = await db.execute(
      `UPDATE notifications SET is_read = 1, read_at = ? WHERE user_id = ? AND is_read = 0`,
      [ts, req.user!.id]
    );
    res.json({ ok: true, readCount: upd.affectedRows });
  })
);

router.post(
  '/remind',
  asyncHandler(async (req, res) => {
    const body = z
      .object({
        biz_type: z.string().min(2),
        biz_id: z.number().int().positive(),
        message: z.string().max(200).optional(),
      })
      .parse(req.body);

    const db = getDb();
    const user = req.user!;
    const pendingStep = await db.queryOne<{
      step_name: string;
      approver_role: string;
      approver_user_id: number | null;
    }>(
      `SELECT step_name, approver_role, approver_user_id FROM approval_steps
       WHERE biz_type = ? AND biz_id = ? AND status = 'PENDING'
       ORDER BY step_order ASC LIMIT 1`,
      [body.biz_type, body.biz_id]
    );
    if (!pendingStep) {
      throw new AppError(400, '该单据当前没有待审批节点，无需催办');
    }

    let targetUserIds: number[] = [];
    if (pendingStep.approver_user_id) {
      targetUserIds = [pendingStep.approver_user_id];
    } else {
      const roleUsers = await db.query<{ id: number }>(
        `SELECT id FROM users WHERE role = ? AND is_active = 1`,
        [pendingStep.approver_role]
      );
      targetUserIds = roleUsers.map((u) => u.id);
    }
    if (targetUserIds.length === 0) {
      throw new AppError(400, '未找到当前待审批节点的处理人');
    }

    const ts = nowIso();
    let sent = 0;
    for (const uid of targetUserIds) {
      const recent = await db.queryOne<{ id: number }>(
        `SELECT id FROM notifications
         WHERE user_id = ? AND biz_type = ? AND biz_id = ? AND level = 'URGENT' AND created_at >= ?
         LIMIT 1`,
        [uid, body.biz_type, body.biz_id, ts.slice(0, 13)]
      );
      if (recent) continue;
      await db.execute(
        `INSERT INTO notifications (user_id, biz_type, biz_id, title, content, level, is_read, created_at)
         VALUES (?, ?, ?, ?, ?, 'URGENT', 0, ?)`,
        [
          uid,
          body.biz_type,
          body.biz_id,
          `待办催办：${body.biz_type} #${body.biz_id}`,
          body.message || `${user.display_name} 催办了「${pendingStep.step_name}」审批，请尽快处理。`,
          ts,
        ]
      );
      sent++;
    }

    res.json({ ok: true, sentCount: sent });
  })
);

export default router;
