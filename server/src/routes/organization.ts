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
      city_id: number | null;
      district_id: number | null;
      city: string;
      district: string | null;
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

    res.json({
      regions: tree,
      regionOptions: regions
        .filter((r) => r.code !== 'HQ')
        .map((r) => ({ id: r.id, code: r.code, name: r.name })),
      managerCandidates,
    });
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
  city_id: z.number().int().positive().optional().nullable(),
  district_id: z.number().int().positive().optional().nullable(),
  city: z.string().min(1).optional(),
  district: z.string().optional().nullable(),
  status: z.string().trim().min(2).max(24).default('OPEN'),
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
    const region = await db.queryOne<{ id: number }>('SELECT id FROM regions WHERE id = ?', [body.region_id]);
    if (!region) {
      throw new AppError(400, '所选大区不存在，请刷新页面后重试');
    }

    let cityName = (body.city || '').trim();
    let cityId: number | null = body.city_id ?? null;
    if (cityId) {
      const cityRow = await db.queryOne<{ id: number; region_id: number; name: string }>(
        'SELECT id, region_id, name FROM cities WHERE id = ?',
        [cityId]
      );
      if (!cityRow) throw new AppError(400, '所选城市不存在');
      if (Number(cityRow.region_id) !== Number(body.region_id)) {
        throw new AppError(400, '所选城市不属于当前大区');
      }
      cityName = cityRow.name;
    }
    if (!cityName) {
      throw new AppError(400, '请选择或填写所在城市');
    }

    let districtName = (body.district || '').trim() || null;
    let districtId: number | null = body.district_id ?? null;
    if (districtId) {
      const distRow = await db.queryOne<{ id: number; city_id: number; name: string }>(
        'SELECT id, city_id, name FROM districts WHERE id = ?',
        [districtId]
      );
      if (!distRow) throw new AppError(400, '所选城区不存在');
      if (cityId && Number(distRow.city_id) !== Number(cityId)) {
        throw new AppError(400, '所选城区不属于当前城市');
      }
      districtName = distRow.name;
    }

    const hotelStatus = body.status.toUpperCase();
    const validStatusRow = await db.queryOne<{ code: string }>(
      `SELECT code FROM master_dict_items WHERE dict_type = 'HOTEL_STATUS' AND code = ? AND is_active = 1`,
      [hotelStatus]
    );
    const fallbackStatuses = new Set(['CONTRACTED', 'RENOVATING', 'SOFT_OPENING', 'OPEN', 'SUSPENDED', 'CLOSED', 'ACTIVE']);
    if (!validStatusRow && !fallbackStatuses.has(hotelStatus)) {
      throw new AppError(400, '无效的门店状态');
    }

    const normalizedCode = body.code.trim().toUpperCase();
    const existingCode = await db.queryOne<{ id: number }>('SELECT id FROM hotels WHERE code = ?', [normalizedCode]);
    if (existingCode) {
      throw new AppError(409, '门店编码已存在，请更换其他编码');
    }
    const ts = nowIso();
    const today = todayStr();

    const storeTemplates = await db.query<{ code: string; name: string; category: string }>(
      `SELECT code, name, category FROM dept_templates WHERE org_level = 'STORE' AND is_active = 1 ORDER BY sort_order ASC, id ASC`
    );
    const deptList =
      storeTemplates.length > 0
        ? storeTemplates
        : [
            { code: 'FO', name: '前厅部', category: 'FRONT_OFFICE' },
            { code: 'HK', name: '客房部', category: 'HOUSEKEEPING' },
            { code: 'ENG', name: '工程维保部', category: 'ENGINEERING' },
            { code: 'FB', name: '餐饮部', category: 'FB' },
            { code: 'ADM', name: '门店综合管理部', category: 'ADMIN' },
          ];

    const hotelId = await db.transaction(async (tx) => {
      const resInsert = await tx.execute(
        `INSERT INTO hotels (code, name, region_id, city_id, district_id, city, district, address, phone, room_count, is_hq, status, opened_at, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?, ?)`,
        [
          normalizedCode,
          body.name.trim(),
          body.region_id,
          cityId,
          districtId,
          cityName,
          districtName,
          body.address.trim(),
          body.phone.trim(),
          body.room_count,
          hotelStatus,
          today,
          ts,
        ]
      );
      const hid = resInsert.insertId;
      for (const d of deptList) {
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

router.patch(
  '/hotels/:id/status',
  requireRoles('HQ_ADMIN', 'GENERAL_MANAGER', 'HR_MANAGER'),
  asyncHandler(async (req, res) => {
    const id = Number(req.params.id);
    const { status } = z.object({ status: z.string().trim().min(2).max(24) }).parse(req.body);
    const nextStatus = status.toUpperCase();
    const db = getDb();
    const hotel = await db.queryOne<{ id: number; is_hq: number }>('SELECT id, is_hq FROM hotels WHERE id = ?', [id]);
    if (!hotel) throw new AppError(404, '门店不存在');
    if (hotel.is_hq) throw new AppError(400, '集团总部状态不可变更');

    const validStatusRow = await db.queryOne<{ code: string }>(
      `SELECT code FROM master_dict_items WHERE dict_type = 'HOTEL_STATUS' AND code = ? AND is_active = 1`,
      [nextStatus]
    );
    if (!validStatusRow) throw new AppError(400, '无效的门店状态');

    await db.execute('UPDATE hotels SET status = ? WHERE id = ?', [nextStatus, id]);
    const updated = await db.queryOne('SELECT * FROM hotels WHERE id = ?', [id]);
    res.json({ hotel: updated });
  })
);

export default router;
