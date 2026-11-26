import { Router } from 'express';
import { z } from 'zod';
import { getDb } from '../../db';
import { AppError, asyncHandler, authenticate, getScopeFilter, requireRoles } from '../middleware/auth';
import { logApprovalAction } from '../services/auditService';
import { nowIso, todayStr } from '../utils/numbers';

const router = Router();
router.use(authenticate);

router.get(
  '/tree',
  asyncHandler(async (req, res) => {
    const db = getDb();
    const scope = await getScopeFilter(req.user!);

    const regions = await db.query<{
      id: number;
      code: string;
      name: string;
      manager_user_id: number | null;
      manager_name: string | null;
      manager_role: string | null;
      manager_employee_id: number | null;
    }>(
      `SELECT r.id, r.code, r.name, r.manager_user_id,
              u.display_name AS manager_name, u.role AS manager_role, u.employee_id AS manager_employee_id
       FROM regions r
       LEFT JOIN users u ON u.id = r.manager_user_id
       ORDER BY r.id ASC`
    );

    const gmUsers = await db.query<{ id: number; employee_id: number | null }>(
      `SELECT id, employee_id FROM users WHERE role = 'GENERAL_MANAGER' AND is_active = 1`
    );
    const gmIds = new Set(gmUsers.map((g) => Number(g.id)));
    const gmEmpIds = new Set(gmUsers.filter((g) => g.employee_id !== null).map((g) => Number(g.employee_id)));

    const managerCandidates = await db.query<{
      id: number;
      username: string;
      display_name: string;
      role: string;
      region_id: number | null;
    }>(
      `SELECT id, username, display_name, role, region_id
       FROM users
       WHERE is_active = 1 AND role IN ('REGIONAL_MANAGER', 'GENERAL_MANAGER')
       ORDER BY role ASC, id ASC`
    );
    const hotels = await db.query<{
      id: number;
      code: string;
      name: string;
      region_id: number;
      city: string;
      address: string;
      phone: string;
      room_count: number;
      is_hq: number;
      status: string;
      opened_at: string;
    }>('SELECT * FROM hotels ORDER BY is_hq DESC, id ASC');

    const depts = await db.query<{
      id: number;
      hotel_id: number;
      code: string;
      name: string;
      category: string;
    }>('SELECT id, hotel_id, code, name, category FROM departments ORDER BY id ASC');

    const empCounts = await db.query<{ hotel_id: number; department_id: number; cnt: number }>(
      `SELECT hotel_id, department_id, COUNT(*) AS cnt
       FROM employees
       WHERE status IN ('ACTIVE', 'PROBATION')
       GROUP BY hotel_id, department_id`
    );

    const managers = await db.query<{ hotel_id: number; display_name: string }>(
      `SELECT hotel_id, display_name FROM users WHERE role = 'STORE_MANAGER' AND is_active = 1`
    );

    const visibleHotelIds =
      scope.type === 'ALL'
        ? null
        : scope.type === 'REGION'
          ? new Set(scope.hotelIds)
          : new Set([scope.hotelId]);

    const tree = regions
      .map((reg) => {
        const regHotels = hotels
          .filter((h) => Number(h.region_id) === Number(reg.id))
          .filter((h) => !visibleHotelIds || visibleHotelIds.has(Number(h.id)))
          .map((h) => {
            const hDepts = depts
              .filter((d) => Number(d.hotel_id) === Number(h.id))
              .map((d) => {
                const c = empCounts.find(
                  (x) => Number(x.hotel_id) === Number(h.id) && Number(x.department_id) === Number(d.id)
                );
                return { ...d, employee_count: Number(c?.cnt || 0) };
              });
            const totalEmp = hDepts.reduce((s, d) => s + d.employee_count, 0);
            const mgr = managers.find((m) => Number(m.hotel_id) === Number(h.id));
            return {
              ...h,
              manager_name: mgr?.display_name ?? null,
              employee_count: totalEmp,
              departments: hDepts,
            };
          });
        const isSameAsGm = Boolean(
          (reg.manager_user_id && gmIds.has(Number(reg.manager_user_id))) ||
            (reg.manager_employee_id && gmEmpIds.has(Number(reg.manager_employee_id)))
        );
        return {
          ...reg,
          is_manager_same_as_gm: isSameAsGm,
          hotels: regHotels,
        };
      })
      .filter((r) => r.hotels.length > 0);

    res.json({ regions: tree, managerCandidates });
  })
);

router.put(
  '/regions/:id/manager',
  requireRoles('HQ_ADMIN', 'GENERAL_MANAGER'),
  asyncHandler(async (req, res) => {
    const id = Number(req.params.id);
    const body = z.object({ manager_user_id: z.number().int().positive().nullable() }).parse(req.body);
    const db = getDb();

    const reg = await db.queryOne<{ id: number; name: string; manager_user_id: number | null }>(
      'SELECT id, name, manager_user_id FROM regions WHERE id = ?',
      [id]
    );
    if (!reg) throw new AppError(404, '大区不存在');

    let nextManagerLabel = '未指定';
    if (body.manager_user_id !== null) {
      const u = await db.queryOne<{ id: number; display_name: string; role: string; is_active: number }>(
        'SELECT id, display_name, role, is_active FROM users WHERE id = ?',
        [body.manager_user_id]
      );
      if (!u || !u.is_active) throw new AppError(404, '指定的负责人账号不存在或已禁用');
      if (!['REGIONAL_MANAGER', 'GENERAL_MANAGER'].includes(u.role)) {
        throw new AppError(400, '大区负责人仅允许指定区域经理或集团总经理账号');
      }
      nextManagerLabel = `${u.display_name}(${u.role})`;
    }

    await db.transaction(async (tx) => {
      await tx.execute('UPDATE regions SET manager_user_id = ? WHERE id = ?', [
        body.manager_user_id,
        id,
      ]);
      await logApprovalAction(tx, {
        bizType: 'REGION',
        bizId: id,
        action: 'UPDATE_MANAGER',
        actor: req.user!,
        comment: `变更大区「${reg.name}」负责人：${reg.manager_user_id ?? '无'} -> ${body.manager_user_id ?? '无'}（${nextManagerLabel}）`,
      });
    });
    res.json({ ok: true, region_id: id, manager_user_id: body.manager_user_id });
  })
);

router.get(
  '/hotels',
  asyncHandler(async (req, res) => {
    const db = getDb();
    const scope = await getScopeFilter(req.user!);
    let sql = `SELECT h.*, r.name AS region_name
               FROM hotels h
               JOIN regions r ON r.id = h.region_id`;
    const params: unknown[] = [];

    if (req.query.all !== 'true') {
      if (scope.type === 'REGION') {
        if (scope.hotelIds.length === 0) {
          res.json({ hotels: [] });
          return;
        }
        sql += ` WHERE h.id IN (${scope.hotelIds.map(() => '?').join(',')})`;
        params.push(...scope.hotelIds);
      } else if (scope.type === 'HOTEL' || scope.type === 'SELF') {
        sql += ' WHERE h.id = ?';
        params.push(scope.hotelId);
      }
    }

    sql += ' ORDER BY h.is_hq DESC, h.id ASC';
    const hotels = await db.query(sql, params);
    const departments = await db.query('SELECT * FROM departments ORDER BY id ASC');
    res.json({ hotels, departments });
  })
);

const createHotelSchema = z.object({
  code: z.string().min(2).max(20),
  name: z.string().min(2).max(100),
  region_id: z.number().int().positive(),
  city: z.string().min(1),
  address: z.string().min(2),
  phone: z.string().min(5),
  room_count: z.number().int().min(0).default(100),
});

router.post(
  '/hotels',
  requireRoles('HQ_ADMIN', 'HR_MANAGER'),
  asyncHandler(async (req, res) => {
    const body = createHotelSchema.parse(req.body);
    const db = getDb();
    const ts = nowIso();
    const today = todayStr();

    const hotelId = await db.transaction(async (tx) => {
      const resInsert = await tx.execute(
        `INSERT INTO hotels (code, name, region_id, city, address, phone, room_count, is_hq, status, opened_at, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, 0, 'ACTIVE', ?, ?)`,
        [body.code.toUpperCase(), body.name, body.region_id, body.city, body.address, body.phone, body.room_count, today, ts]
      );
      const hid = resInsert.insertId;
      for (const d of [
        { code: 'FO', name: '前厅部', category: 'FRONT_OFFICE' },
        { code: 'HK', name: '客房部', category: 'HOUSEKEEPING' },
        { code: 'ENG', name: '工程维保部', category: 'ENGINEERING' },
        { code: 'FB', name: '餐饮部', category: 'FB' },
        { code: 'ADM', name: '门店综合管理部', category: 'ADMIN' },
      ]) {
        await tx.execute(
          'INSERT INTO departments (hotel_id, code, name, category, created_at) VALUES (?, ?, ?, ?, ?)',
          [hid, d.code, d.name, d.category, ts]
        );
      }
      return hid;
    });

    const hotel = await db.queryOne('SELECT * FROM hotels WHERE id = ?', [hotelId]);
    res.status(201).json({ hotel });
  })
);

export default router;
