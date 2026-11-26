import { Router } from 'express';
import bcrypt from 'bcryptjs';
import { z } from 'zod';
import { getDb } from '../../db';
import { isDemoSwitchEnabled } from '../config/env';
import { AppError, asyncHandler, authenticate, signToken } from '../middleware/auth';
import { ROLE_LABELS, UserRole } from '../types';

const router = Router();

const LOGIN_WINDOW_MS = 15 * 60 * 1000;
const MAX_LOGIN_FAILURES = 10;
const loginFailures = new Map<string, { count: number; resetAt: number }>();

function getLoginAttemptKey(req: { ip?: string; headers: Record<string, unknown> }, username: string): string {
  const ip = req.ip || String(req.headers['x-forwarded-for'] || 'unknown');
  return `${ip}:${username.trim().toLowerCase()}`;
}

const loginSchema = z.object({
  username: z.string().min(1, '请输入用户名'),
  password: z.string().min(1, '请输入密码'),
});

router.post(
  '/login',
  asyncHandler(async (req, res) => {
    const { username, password } = loginSchema.parse(req.body);
    const attemptKey = getLoginAttemptKey(req, username);
    const now = Date.now();
    const record = loginFailures.get(attemptKey);
    if (record && record.resetAt > now && record.count >= MAX_LOGIN_FAILURES) {
      throw new AppError(429, '登录失败次数过多，请 15 分钟后再试');
    }
    if (record && record.resetAt <= now) {
      loginFailures.delete(attemptKey);
    }

    const db = getDb();
    const user = await db.queryOne<{
      id: number;
      username: string;
      password_hash: string;
      display_name: string;
      role: UserRole;
      employee_id: number | null;
      hotel_id: number | null;
      region_id: number | null;
      is_active: number;
      hotel_name: string | null;
      hotel_code: string | null;
      region_name: string | null;
    }>(
      `SELECT u.*, h.name AS hotel_name, h.code AS hotel_code, r.name AS region_name
       FROM users u
       LEFT JOIN hotels h ON h.id = u.hotel_id
       LEFT JOIN regions r ON r.id = u.region_id
       WHERE u.username = ?`,
      [username.trim()]
    );

    if (!user || !user.is_active || !bcrypt.compareSync(password, user.password_hash)) {
      const cur = loginFailures.get(attemptKey);
      if (!cur || cur.resetAt <= now) {
        loginFailures.set(attemptKey, { count: 1, resetAt: now + LOGIN_WINDOW_MS });
      } else {
        cur.count += 1;
      }
      throw new AppError(401, '账号或密码错误');
    }
    loginFailures.delete(attemptKey);

    const token = signToken(Number(user.id));
    res.json({
      token,
      user: {
        id: Number(user.id),
        username: user.username,
        display_name: user.display_name,
        role: user.role,
        role_label: ROLE_LABELS[user.role],
        employee_id: user.employee_id ? Number(user.employee_id) : null,
        hotel_id: user.hotel_id ? Number(user.hotel_id) : null,
        region_id: user.region_id ? Number(user.region_id) : null,
        hotel_name: user.hotel_name,
        hotel_code: user.hotel_code,
        region_name: user.region_name,
      },
    });
  })
);

router.get(
  '/me',
  authenticate,
  asyncHandler(async (req, res) => {
    res.json({
      user: {
        ...req.user,
        role_label: ROLE_LABELS[req.user!.role],
      },
    });
  })
);

router.get(
  '/demo-accounts',
  asyncHandler(async (_req, res) => {
    if (!isDemoSwitchEnabled()) {
      res.json({ enabled: false, accounts: [] });
      return;
    }
    const db = getDb();
    const accounts = await db.query<{
      id: number;
      username: string;
      display_name: string;
      role: UserRole;
      position: string | null;
      hotel_name: string | null;
      region_name: string | null;
    }>(
      `SELECT u.id, u.username, u.display_name, u.role, e.position AS position,
              h.name AS hotel_name, r.name AS region_name
       FROM users u
       LEFT JOIN employees e ON e.id = u.employee_id
       LEFT JOIN hotels h ON h.id = u.hotel_id
       LEFT JOIN regions r ON r.id = u.region_id
       WHERE u.is_active = 1
       ORDER BY u.id ASC`
    );
    res.json({
      enabled: true,
      accounts: accounts.map((a) => ({
        ...a,
        role_label: ROLE_LABELS[a.role],
      })),
    });
  })
);

router.post(
  '/demo-switch',
  asyncHandler(async (req, res) => {
    if (!isDemoSwitchEnabled()) {
      throw new AppError(403, '演示角色快捷切换已关闭');
    }
    const { username } = z.object({ username: z.string().min(1) }).parse(req.body);
    const db = getDb();
    const user = await db.queryOne<{
      id: number;
      username: string;
      display_name: string;
      role: UserRole;
      employee_id: number | null;
      hotel_id: number | null;
      region_id: number | null;
      is_active: number;
      hotel_name: string | null;
      hotel_code: string | null;
      region_name: string | null;
    }>(
      `SELECT u.id, u.username, u.display_name, u.role, u.employee_id, u.hotel_id, u.region_id, u.is_active,
              h.name AS hotel_name, h.code AS hotel_code, r.name AS region_name
       FROM users u
       LEFT JOIN hotels h ON h.id = u.hotel_id
       LEFT JOIN regions r ON r.id = u.region_id
       WHERE u.username = ?`,
      [username.trim()]
    );
    if (!user || !user.is_active) {
      throw new AppError(404, '演示账号不存在');
    }
    const token = signToken(Number(user.id));
    res.json({
      token,
      user: {
        id: Number(user.id),
        username: user.username,
        display_name: user.display_name,
        role: user.role,
        role_label: ROLE_LABELS[user.role],
        employee_id: user.employee_id ? Number(user.employee_id) : null,
        hotel_id: user.hotel_id ? Number(user.hotel_id) : null,
        region_id: user.region_id ? Number(user.region_id) : null,
        hotel_name: user.hotel_name,
        hotel_code: user.hotel_code,
        region_name: user.region_name,
      },
    });
  })
);

export default router;
