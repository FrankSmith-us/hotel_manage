import { NextFunction, Request, Response } from 'express';
import jwt from 'jsonwebtoken';
import { getDb } from '../../db';
import { env } from '../config/env';
import { AuthUser, UserRole } from '../types';

declare global {
  namespace Express {
    interface Request {
      user?: AuthUser;
    }
  }
}

export class AppError extends Error {
  constructor(
    public readonly statusCode: number,
    message: string,
    public readonly details?: unknown
  ) {
    super(message);
    this.name = 'AppError';
  }
}

export function asyncHandler(
  fn: (req: Request, res: Response, next: NextFunction) => Promise<unknown>
) {
  return (req: Request, res: Response, next: NextFunction) => {
    Promise.resolve(fn(req, res, next)).catch(next);
  };
}

export function signToken(userId: number): string {
  return jwt.sign({ userId }, env.jwtSecret, { expiresIn: '7d' });
}

export const authenticate = asyncHandler(async (req, _res, next) => {
  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    throw new AppError(401, '请先登录后再操作');
  }
  const token = authHeader.slice(7).trim();
  let payload: { userId?: number };
  try {
    payload = jwt.verify(token, env.jwtSecret) as { userId?: number };
  } catch {
    throw new AppError(401, '登录凭证无效或已过期，请重新登录');
  }
  if (!payload.userId) {
    throw new AppError(401, '登录凭证无效');
  }

  const db = getDb();
  const user = await db.queryOne<AuthUser & { is_active: number }>(
    `SELECT u.id, u.username, u.display_name, u.role, u.employee_id, u.hotel_id, u.region_id, u.is_active,
            h.name AS hotel_name, h.code AS hotel_code, r.name AS region_name
     FROM users u
     LEFT JOIN hotels h ON h.id = u.hotel_id
     LEFT JOIN regions r ON r.id = u.region_id
     WHERE u.id = ?`,
    [payload.userId]
  );

  if (!user || !user.is_active) {
    throw new AppError(401, '账号不存在或已被禁用');
  }

  req.user = {
    id: Number(user.id),
    username: user.username,
    display_name: user.display_name,
    role: user.role,
    employee_id: user.employee_id ? Number(user.employee_id) : null,
    hotel_id: user.hotel_id ? Number(user.hotel_id) : null,
    region_id: user.region_id ? Number(user.region_id) : null,
    hotel_name: user.hotel_name ?? null,
    hotel_code: user.hotel_code ?? null,
    region_name: user.region_name ?? null,
  };
  next();
});

export function requireRoles(...roles: UserRole[]) {
  return (req: Request, _res: Response, next: NextFunction) => {
    if (!req.user) {
      return next(new AppError(401, '请先登录'));
    }
    if (!roles.includes(req.user.role)) {
      return next(new AppError(403, '当前角色无权限执行此操作'));
    }
    next();
  };
}

export type ScopeFilter =
  | { type: 'ALL' }
  | { type: 'REGION'; hotelIds: number[] }
  | { type: 'HOTEL'; hotelId: number }
  | { type: 'SELF'; employeeId: number; userId: number; hotelId: number };

export async function getScopeFilter(user: AuthUser): Promise<ScopeFilter> {
  if (
    user.role === 'HQ_ADMIN' ||
    user.role === 'GENERAL_MANAGER' ||
    user.role === 'HR_MANAGER' ||
    user.role === 'FINANCE'
  ) {
    return { type: 'ALL' };
  }
  if (user.role === 'REGIONAL_MANAGER' && user.region_id) {
    const db = getDb();
    const hotels = await db.query<{ id: number }>(
      'SELECT id FROM hotels WHERE region_id = ?',
      [user.region_id]
    );
    return {
      type: 'REGION',
      hotelIds: hotels.map((h) => Number(h.id)),
    };
  }
  if (user.role === 'STORE_MANAGER' && user.hotel_id) {
    return { type: 'HOTEL', hotelId: user.hotel_id };
  }
  return {
    type: 'SELF',
    employeeId: user.employee_id ?? -1,
    userId: user.id,
    hotelId: user.hotel_id ?? -1,
  };
}

export async function canAccessHotel(user: AuthUser, hotelId: number): Promise<boolean> {
  const scope = await getScopeFilter(user);
  if (scope.type === 'ALL') return true;
  if (scope.type === 'REGION') return scope.hotelIds.includes(Number(hotelId));
  if (scope.type === 'HOTEL') return scope.hotelId === Number(hotelId);
  return scope.hotelId === Number(hotelId);
}
