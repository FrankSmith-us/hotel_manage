import { Router } from 'express';
import bcrypt from 'bcryptjs';
import { z } from 'zod';
import { getDb } from '../../db';
import { AppError, asyncHandler, authenticate, requireRoles } from '../middleware/auth';
import { logApprovalAction } from '../services/auditService';
import { reassignPendingSteps } from '../services/workflowEngine';
import { ROLE_LABELS, UserRole } from '../types';
import { generateTempPassword, isoDateSchema, nowIso } from '../utils/numbers';

const router = Router();
router.use(authenticate);

// === Approval Delegations (any authenticated user for self, or HQ_ADMIN/HR_MANAGER) ===
router.get(
  '/delegations',
  asyncHandler(async (req, res) => {
    const db = getDb();
    const user = req.user!;
    const isAdminOrHr = ['HQ_ADMIN', 'HR_MANAGER'].includes(user.role);
    const rows = await db.query(
      `SELECT d.*, du.display_name AS delegator_name, du.username AS delegator_username,
              de.display_name AS delegate_name, de.username AS delegate_username
       FROM approval_delegations d
       JOIN users du ON du.id = d.delegator_user_id
       JOIN users de ON de.id = d.delegate_user_id
       ${isAdminOrHr ? '' : 'WHERE d.delegator_user_id = ? OR d.delegate_user_id = ?'}
       ORDER BY d.id DESC`,
      isAdminOrHr ? [] : [user.id, user.id]
    );
    res.json({ delegations: rows });
  })
);

router.post(
  '/delegations',
  asyncHandler(async (req, res) => {
    const body = z
      .object({
        delegator_user_id: z.number().int().positive().optional(),
        delegate_user_id: z.number().int().positive(),
        start_date: isoDateSchema,
        end_date: isoDateSchema,
        biz_types: z.string().trim().min(2).max(120).default('ALL'),
      })
      .parse(req.body);
    const user = req.user!;
    const delegatorId = body.delegator_user_id ?? user.id;
    if (delegatorId !== user.id && !['HQ_ADMIN', 'HR_MANAGER'].includes(user.role)) {
      throw new AppError(403, '仅管理员或HR可代他人设置审批委托');
    }
    if (delegatorId === body.delegate_user_id) {
      throw new AppError(400, '不能将审批委托给自己');
    }
    if (body.end_date < body.start_date) {
      throw new AppError(400, '委托结束日期不能早于开始日期');
    }
    const db = getDb();
    const delegateUser = await db.queryOne<{ id: number; is_active: number }>(
      'SELECT id, is_active FROM users WHERE id = ?',
      [body.delegate_user_id]
    );
    if (!delegateUser || !delegateUser.is_active) {
      throw new AppError(400, '被委托人账号不存在或已停用');
    }
    const ins = await db.execute(
      `INSERT INTO approval_delegations (delegator_user_id, delegate_user_id, start_date, end_date, biz_types, created_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
      [delegatorId, body.delegate_user_id, body.start_date, body.end_date, body.biz_types.toUpperCase(), nowIso()]
    );
    const created = await db.queryOne('SELECT * FROM approval_delegations WHERE id = ?', [ins.insertId]);
    res.status(201).json({ delegation: created });
  })
);

router.delete(
  '/delegations/:id',
  asyncHandler(async (req, res) => {
    const id = Number(req.params.id);
    const db = getDb();
    const row = await db.queryOne<{ id: number; delegator_user_id: number }>(
      'SELECT id, delegator_user_id FROM approval_delegations WHERE id = ?',
      [id]
    );
    if (!row) throw new AppError(404, '委托记录不存在');
    if (row.delegator_user_id !== req.user!.id && !['HQ_ADMIN', 'HR_MANAGER'].includes(req.user!.role)) {
      throw new AppError(403, '无权删除他人委托记录');
    }
    await db.execute('DELETE FROM approval_delegations WHERE id = ?', [id]);
    res.json({ ok: true });
  })
);

router.get(
  '/',
  requireRoles('HQ_ADMIN', 'HR_MANAGER'),
  asyncHandler(async (_req, res) => {
    const db = getDb();
    const users = await db.query<{
      id: number;
      username: string;
      display_name: string;
      role: UserRole;
      employee_id: number | null;
      hotel_id: number | null;
      region_id: number | null;
      is_active: number;
      must_change_password: number;
      password_changed_at: string | null;
      created_at: string;
      hotel_name: string | null;
      region_name: string | null;
      emp_no: string | null;
      emp_status: string | null;
    }>(
      `SELECT u.id, u.username, u.display_name, u.role, u.employee_id, u.hotel_id, u.region_id,
              u.is_active, u.must_change_password, u.password_changed_at, u.created_at,
              h.name AS hotel_name, r.name AS region_name, e.emp_no, e.status AS emp_status
       FROM users u
       LEFT JOIN hotels h ON h.id = u.hotel_id
       LEFT JOIN regions r ON r.id = u.region_id
       LEFT JOIN employees e ON e.id = u.employee_id
       ORDER BY u.id ASC`
    );
    res.json({
      users: users.map((u) => ({
        ...u,
        role_label: ROLE_LABELS[u.role] || u.role,
      })),
    });
  })
);

router.post(
  '/:id/reset-password',
  requireRoles('HQ_ADMIN', 'HR_MANAGER'),
  asyncHandler(async (req, res) => {
    const id = Number(req.params.id);
    const db = getDb();
    const tempPassword = generateTempPassword();
    const hash = bcrypt.hashSync(tempPassword, 10);

    await db.transaction(async (tx) => {
      const target = await tx.queryOne<{ id: number; username: string; display_name: string }>(
        'SELECT id, username, display_name FROM users WHERE id = ?',
        [id]
      );
      if (!target) throw new AppError(404, '账号不存在');
      await tx.execute(
        `UPDATE users SET password_hash = ?, must_change_password = 1 WHERE id = ?`,
        [hash, id]
      );
      await logApprovalAction(tx, {
        bizType: 'USER',
        bizId: id,
        action: 'RESET_PASSWORD',
        actor: req.user!,
        comment: `重置账号 ${target.username}（${target.display_name}）密码并要求首次登录修改`,
      });
    });

    res.json({ ok: true, temp_password: tempPassword });
  })
);

router.patch(
  '/:id/status',
  requireRoles('HQ_ADMIN', 'HR_MANAGER'),
  asyncHandler(async (req, res) => {
    const id = Number(req.params.id);
    const { is_active } = z.object({ is_active: z.boolean() }).parse(req.body);
    if (Number(req.user!.id) === id && !is_active) {
      throw new AppError(400, '禁止停用当前登录账号本人');
    }
    const db = getDb();
    await db.transaction(async (tx) => {
      const target = await tx.queryOne<{ id: number; username: string }>(
        'SELECT id, username FROM users WHERE id = ?',
        [id]
      );
      if (!target) throw new AppError(404, '账号不存在');
      await tx.execute('UPDATE users SET is_active = ? WHERE id = ?', [is_active ? 1 : 0, id]);
      if (!is_active) {
        await reassignPendingSteps(tx, id);
      }
      await logApprovalAction(tx, {
        bizType: 'USER',
        bizId: id,
        action: is_active ? 'ENABLE_USER' : 'DISABLE_USER',
        actor: req.user!,
        comment: `${is_active ? '启用' : '停用'}账号 ${target.username}`,
      });
    });
    res.json({ ok: true });
  })
);

const updateRoleSchema = z.object({
  role: z.enum([
    'HQ_ADMIN',
    'GENERAL_MANAGER',
    'HR_MANAGER',
    'FINANCE',
    'REGIONAL_MANAGER',
    'STORE_MANAGER',
    'STAFF',
  ]),
  hotel_id: z.number().int().positive().nullable().optional(),
  region_id: z.number().int().positive().nullable().optional(),
});

router.patch(
  '/:id/role',
  requireRoles('HQ_ADMIN', 'HR_MANAGER'),
  asyncHandler(async (req, res) => {
    const id = Number(req.params.id);
    const body = updateRoleSchema.parse(req.body);
    if (body.role === 'STORE_MANAGER' && !body.hotel_id) {
      throw new AppError(400, '门店店长角色必须指定所属门店');
    }
    if (body.role === 'REGIONAL_MANAGER' && !body.region_id) {
      throw new AppError(400, '区域经理角色必须指定所属大区');
    }

    const db = getDb();
    await db.transaction(async (tx) => {
      const target = await tx.queryOne<{ id: number; username: string; role: string }>(
        'SELECT id, username, role FROM users WHERE id = ?',
        [id]
      );
      if (!target) throw new AppError(404, '账号不存在');

      let nextRegionId = body.region_id ?? null;
      if (body.hotel_id && !nextRegionId) {
        const h = await tx.queryOne<{ region_id: number }>('SELECT region_id FROM hotels WHERE id = ?', [body.hotel_id]);
        if (!h) throw new AppError(400, '所属门店不存在');
        nextRegionId = h.region_id;
      }

      await tx.execute(
        'UPDATE users SET role = ?, hotel_id = ?, region_id = ? WHERE id = ?',
        [body.role, body.hotel_id ?? null, nextRegionId, id]
      );
      await reassignPendingSteps(tx, id);
      await logApprovalAction(tx, {
        bizType: 'USER',
        bizId: id,
        action: 'UPDATE_ROLE',
        actor: req.user!,
        comment: `变更账号 ${target.username} 角色：${target.role} -> ${body.role}`,
      });
    });

    res.json({ ok: true });
  })
);

export default router;
