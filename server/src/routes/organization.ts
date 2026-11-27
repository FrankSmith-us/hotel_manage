import { Router } from 'express';
import { z } from 'zod';
import { getDb } from '../../db';
import { AppError, asyncHandler, authenticate, canAccessHotel, getScopeFilter, requireRoles } from '../middleware/auth';
import { logApprovalAction } from '../services/auditService';
import {
  buildHotelClosureRoute,
  buildStatusDetail,
  canUserActOnStep,
  getWorkflowStepsWithActors,
  replaceApprovalSteps,
  resolveApprovalRoute,
} from '../services/workflowEngine';
import { currentYearMonth, generateCode, nowIso, offsetYearMonth, todayStr } from '../utils/numbers';

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
  budget_template_hotel_id: z.number().int().positive().optional().nullable(),
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
    if (hotelStatus === 'CLOSED') {
      throw new AppError(400, '新建门店状态不可直接设置为关闭');
    }
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

      if (body.budget_template_hotel_id) {
        const curYm = currentYearMonth();
        const nextYm = offsetYearMonth(curYm, 1);
        const tplRows = await tx.query<{ year_month: string; category: string; budget_amount: number }>(
          `SELECT \`year_month\`, category, budget_amount
           FROM store_budgets
           WHERE hotel_id = ? AND \`year_month\` IN (?, ?)`,
          [body.budget_template_hotel_id, curYm, nextYm]
        );
        for (const row of tplRows) {
          await tx.execute(
            `INSERT INTO store_budgets (hotel_id, \`year_month\`, category, budget_amount, updated_by, created_at, updated_at)
             VALUES (?, ?, ?, ?, ?, ?, ?)`,
            [hid, row.year_month, row.category, row.budget_amount, req.user!.id, ts, ts]
          );
          await tx.execute(
            `INSERT INTO budget_change_logs (hotel_id, \`year_month\`, category, old_amount, new_amount, reason, changed_by, changed_by_name, created_at)
             VALUES (?, ?, ?, 0, ?, ?, ?, ?, ?)`,
            [
              hid,
              row.year_month,
              row.category,
              row.budget_amount,
              `新店按模板门店(#${body.budget_template_hotel_id})初始化预算`,
              req.user!.id,
              req.user!.display_name,
              ts,
            ]
          );
        }
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
    if (nextStatus === 'CLOSED') {
      throw new AppError(400, '门店状态不能直接设置为关闭，须全部员工为离职状态并经区域总及集团总经理批准');
    }
    const db = getDb();
    const hotel = await db.queryOne<{ id: number; is_hq: number; status: string }>(
      'SELECT id, is_hq, status FROM hotels WHERE id = ?',
      [id]
    );
    if (!hotel) throw new AppError(404, '门店不存在');
    if (hotel.is_hq) throw new AppError(400, '集团总部状态不可变更');
    if (hotel.status === 'CLOSED') throw new AppError(400, '已关闭门店不可直接变更状态');

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

router.get(
  '/staffing-plans',
  asyncHandler(async (req, res) => {
    const db = getDb();
    const hotelId = req.query.hotelId ? Number(req.query.hotelId) : undefined;
    const params: any[] = [];
    let where = 'WHERE 1=1';

    if (hotelId) {
      if (!(await canAccessHotel(req.user!, hotelId))) {
        throw new AppError(403, '无权查看该门店岗位定编');
      }
      where += ' AND p.hotel_id = ?';
      params.push(hotelId);
    }

    const rows = await db.query<any>(
      `SELECT p.*, h.name AS hotel_name, d.name AS department_name,
        (SELECT COUNT(*) FROM employees e
         WHERE e.hotel_id = p.hotel_id AND e.department_id = p.department_id
           AND e.position = p.position AND e.status IN ('ACTIVE', 'PROBATION')) AS actual_headcount
       FROM hotel_staffing_plans p
       JOIN hotels h ON h.id = p.hotel_id
       JOIN departments d ON d.id = p.department_id
       ${where}
       ORDER BY p.hotel_id ASC, p.department_id ASC, p.position ASC`,
      params,
    );

    const plans = [];
    for (const r of rows) {
      if (!(await canAccessHotel(req.user!, Number(r.hotel_id)))) continue;
      const actual = Number(r.actual_headcount || 0);
      const planned = Number(r.planned_count || 0);
      plans.push({
        ...r,
        actual_headcount: actual,
        vacancy: Math.max(0, planned - actual),
        is_overstaffed: actual > planned,
      });
    }

    res.json({ plans });
  })
);

router.put(
  '/staffing-plans',
  requireRoles('HQ_ADMIN', 'HR_MANAGER'),
  asyncHandler(async (req, res) => {
    const body = z
      .object({
        hotel_id: z.number().int().positive(),
        department_id: z.number().int().positive(),
        position: z.string().trim().min(1).max(64),
        planned_count: z.number().int().min(0).max(9999),
      })
      .parse(req.body);

    const db = getDb();
    const dept = await db.queryOne<{ id: number }>(
      'SELECT id FROM departments WHERE id = ? AND hotel_id = ?',
      [body.department_id, body.hotel_id],
    );
    if (!dept) throw new AppError(400, '所选部门不属于当前门店');

    const ts = nowIso();
    const existing = await db.queryOne<{ id: number }>(
      'SELECT id FROM hotel_staffing_plans WHERE hotel_id = ? AND department_id = ? AND position = ?',
      [body.hotel_id, body.department_id, body.position],
    );

    let planId: number;
    if (existing) {
      await db.execute(
        'UPDATE hotel_staffing_plans SET planned_count = ?, updated_by = ?, updated_at = ? WHERE id = ?',
        [body.planned_count, req.user!.id, ts, existing.id],
      );
      planId = existing.id;
    } else {
      const ins = await db.execute(
        `INSERT INTO hotel_staffing_plans (hotel_id, department_id, position, planned_count, updated_by, updated_at)
         VALUES (?, ?, ?, ?, ?, ?)`,
        [body.hotel_id, body.department_id, body.position, body.planned_count, req.user!.id, ts],
      );
      planId = ins.insertId;
    }

    const plan = await db.queryOne('SELECT * FROM hotel_staffing_plans WHERE id = ?', [planId]);
    res.json({ plan });
  })
);

router.get(
  '/closure-requests',
  asyncHandler(async (req, res) => {
    const db = getDb();
    const scope = await getScopeFilter(req.user!);
    const conditions = ['1=1'];
    const params: unknown[] = [];

    if (scope.type === 'REGION') {
      if (scope.hotelIds.length === 0) {
        res.json({ requests: [] });
        return;
      }
      conditions.push(`c.hotel_id IN (${scope.hotelIds.map(() => '?').join(',')})`);
      params.push(...scope.hotelIds);
    } else if (scope.type === 'HOTEL') {
      conditions.push('c.hotel_id = ?');
      params.push(scope.hotelId);
    } else if (scope.type === 'SELF') {
      conditions.push('c.applicant_id = ?');
      params.push(req.user!.id);
    }

    const rows = await db.query<any>(
      `SELECT c.*, h.name AS hotel_name, h.code AS hotel_code, r.name AS region_name, u.display_name AS applicant_name
       FROM hotel_closure_requests c
       JOIN hotels h ON h.id = c.hotel_id
       JOIN regions r ON r.id = h.region_id
       JOIN users u ON u.id = c.applicant_id
       WHERE ${conditions.join(' AND ')}
       ORDER BY c.id DESC`,
      params
    );

    const requests = [];
    for (const row of rows) {
      const empRow = await db.queryOne<{ cnt: number }>(
        `SELECT COUNT(*) AS cnt FROM employees WHERE hotel_id = ? AND status != 'RESIGNED'`,
        [row.hotel_id]
      );
      const steps = await getWorkflowStepsWithActors(db, 'HOTEL_CLOSURE', row.id);
      const pendingStep = steps.find((s) => s.status === 'PENDING');
      const pendingRaw =
        row.status === 'PENDING_APPROVAL'
          ? await db.queryOne<{ approver_role: any; approver_user_id: number | null }>(
              `SELECT approver_role, approver_user_id FROM approval_steps WHERE biz_type = 'HOTEL_CLOSURE' AND biz_id = ? AND status = 'PENDING' ORDER BY step_order ASC LIMIT 1`,
              [row.id]
            )
          : null;
      const canApprove =
        row.status === 'PENDING_APPROVAL' && pendingRaw
          ? await canUserActOnStep(db, req.user!, pendingRaw.approver_role, row.hotel_id, row.applicant_id, {
              approverUserId: pendingRaw.approver_user_id,
              bizType: 'HOTEL_CLOSURE',
            })
          : false;

      requests.push({
        ...row,
        non_resigned_employee_count: Number(empRow?.cnt || 0),
        steps,
        status_detail: buildStatusDetail({
          bizType: 'HOTEL_CLOSURE',
          status: row.status,
          currentStepName: pendingStep?.step_name ?? null,
          currentStep: row.current_step,
          totalSteps: steps.length,
        }),
        can_approve: canApprove,
      });
    }

    res.json({ requests });
  })
);

router.post(
  '/hotels/:id/closure-requests',
  requireRoles('HQ_ADMIN', 'HR_MANAGER', 'REGIONAL_MANAGER', 'STORE_MANAGER'),
  asyncHandler(async (req, res) => {
    const hotelId = Number(req.params.id);
    const { reason } = z.object({ reason: z.string().trim().min(2).max(500) }).parse(req.body);

    if (!(await canAccessHotel(req.user!, hotelId))) {
      throw new AppError(403, '无权申请关闭该门店');
    }

    const db = getDb();
    const hotel = await db.queryOne<{ id: number; name: string; is_hq: number; status: string }>(
      'SELECT id, name, is_hq, status FROM hotels WHERE id = ?',
      [hotelId]
    );
    if (!hotel) throw new AppError(404, '门店不存在');
    if (hotel.is_hq) throw new AppError(400, '集团总部不可关闭');
    if (hotel.status === 'CLOSED') throw new AppError(400, '该门店已处于关闭状态');

    const nonResigned = await db.queryOne<{ cnt: number }>(
      `SELECT COUNT(*) AS cnt FROM employees WHERE hotel_id = ? AND status != 'RESIGNED'`,
      [hotelId]
    );
    const activeCount = Number(nonResigned?.cnt || 0);
    if (activeCount > 0) {
      throw new AppError(400, `该门店仍有 ${activeCount} 名未离职员工，须所有员工为离职状态后方可申请关闭`);
    }

    const dup = await db.queryOne<{ id: number }>(
      `SELECT id FROM hotel_closure_requests WHERE hotel_id = ? AND status = 'PENDING_APPROVAL'`,
      [hotelId]
    );
    if (dup) {
      throw new AppError(409, '该门店已有审批中的关店申请，请勿重复提交');
    }

    const resolved = await resolveApprovalRoute(db, hotelId, buildHotelClosureRoute(), req.user!.id);
    const ts = nowIso();
    const requestNo = generateCode('CLS');

    const reqId = await db.transaction(async (tx) => {
      const ins = await tx.execute(
        `INSERT INTO hotel_closure_requests (
          request_no, hotel_id, reason, applicant_id, status, current_step, total_steps, created_at, updated_at
        ) VALUES (?, ?, ?, ?, 'PENDING_APPROVAL', 1, ?, ?, ?)`,
        [requestNo, hotelId, reason, req.user!.id, resolved.steps.length, ts, ts]
      );
      await replaceApprovalSteps(tx, 'HOTEL_CLOSURE', ins.insertId, resolved.steps);
      await logApprovalAction(tx, {
        bizType: 'HOTEL_CLOSURE',
        bizId: ins.insertId,
        action: 'SUBMIT',
        actor: req.user!,
        comment: `申请关闭门店 ${hotel.name}：${reason}`,
      });
      if (resolved.skippedRegionalManager && resolved.skipReason) {
        await logApprovalAction(tx, {
          bizType: 'HOTEL_CLOSURE',
          bizId: ins.insertId,
          action: 'AUTO_SKIP',
          actor: req.user!,
          comment: resolved.skipReason,
        });
      }
      return ins.insertId;
    });

    const request = await db.queryOne('SELECT * FROM hotel_closure_requests WHERE id = ?', [reqId]);
    res.status(201).json({ request });
  })
);

router.post(
  '/closure-requests/:id/action',
  asyncHandler(async (req, res) => {
    const id = Number(req.params.id);
    const { action, comment } = z
      .object({
        action: z.enum(['APPROVE', 'REJECT']),
        comment: z.string().optional().default(''),
      })
      .parse(req.body);

    const db = getDb();
    const ts = nowIso();

    const updated = await db.transaction(async (tx) => {
      const row = await tx.queryOne<any>(
        `SELECT * FROM hotel_closure_requests WHERE id = ?${tx.forUpdateSuffix()}`,
        [id]
      );
      if (!row) throw new AppError(404, '关店申请不存在');
      if (row.status !== 'PENDING_APPROVAL') {
        throw new AppError(409, '单据状态已变化，请刷新后重试');
      }

      const step = await tx.queryOne<any>(
        `SELECT * FROM approval_steps
         WHERE biz_type = 'HOTEL_CLOSURE' AND biz_id = ? AND step_order = ? AND status = 'PENDING'`,
        [id, row.current_step]
      );
      if (!step) throw new AppError(409, '未找到当前待审批节点');

      const allowed = await canUserActOnStep(tx, req.user!, step.approver_role, row.hotel_id, row.applicant_id, {
        approverUserId: step.approver_user_id,
        bizType: 'HOTEL_CLOSURE',
      });
      if (!allowed) {
        throw new AppError(403, '当前节点仅限指定区域总或集团总经理审批');
      }

      await tx.execute(
        `UPDATE approval_steps SET status = ?, acted_by = ?, acted_at = ?, comment = ? WHERE id = ?`,
        [action === 'APPROVE' ? 'APPROVED' : 'REJECTED', req.user!.id, ts, comment || null, step.id]
      );

      if (action === 'REJECT') {
        const upd = await tx.execute(
          `UPDATE hotel_closure_requests SET status = 'REJECTED', updated_at = ? WHERE id = ? AND status = 'PENDING_APPROVAL'`,
          [ts, id]
        );
        if (upd.affectedRows !== 1) throw new AppError(409, '单据状态已变化，请刷新后重试');
        await tx.execute(
          `UPDATE approval_steps SET status = 'CANCELLED' WHERE biz_type = 'HOTEL_CLOSURE' AND biz_id = ? AND status = 'WAITING'`,
          [id]
        );
      } else {
        const nextStep = await tx.queryOne<any>(
          `SELECT * FROM approval_steps
           WHERE biz_type = 'HOTEL_CLOSURE' AND biz_id = ? AND step_order = ?`,
          [id, Number(row.current_step) + 1]
        );
        if (nextStep) {
          await tx.execute(`UPDATE approval_steps SET status = 'PENDING' WHERE id = ?`, [nextStep.id]);
          const upd = await tx.execute(
            `UPDATE hotel_closure_requests SET current_step = ?, updated_at = ? WHERE id = ? AND status = 'PENDING_APPROVAL'`,
            [Number(row.current_step) + 1, ts, id]
          );
          if (upd.affectedRows !== 1) throw new AppError(409, '单据状态已变化，请刷新后重试');
        } else {
          const nonResigned = await tx.queryOne<{ cnt: number }>(
            `SELECT COUNT(*) AS cnt FROM employees WHERE hotel_id = ? AND status != 'RESIGNED'`,
            [row.hotel_id]
          );
          const activeCount = Number(nonResigned?.cnt || 0);
          if (activeCount > 0) {
            throw new AppError(409, `该门店仍有 ${activeCount} 名未离职员工，无法完成关店，请先办理全部员工离职`);
          }
          const upd = await tx.execute(
            `UPDATE hotel_closure_requests SET status = 'APPROVED', closed_at = ?, updated_at = ? WHERE id = ? AND status = 'PENDING_APPROVAL'`,
            [ts, ts, id]
          );
          if (upd.affectedRows !== 1) throw new AppError(409, '单据状态已变化，请刷新后重试');
          await tx.execute(`UPDATE hotels SET status = 'CLOSED' WHERE id = ?`, [row.hotel_id]);
        }
      }

      await logApprovalAction(tx, {
        bizType: 'HOTEL_CLOSURE',
        bizId: id,
        action,
        actor: req.user!,
        comment,
      });

      return tx.queryOne('SELECT * FROM hotel_closure_requests WHERE id = ?', [id]);
    });

    res.json({ request: updated });
  })
);

router.post(
  '/closure-requests/:id/cancel',
  asyncHandler(async (req, res) => {
    const id = Number(req.params.id);
    const db = getDb();
    const ts = nowIso();

    const updated = await db.transaction(async (tx) => {
      const row = await tx.queryOne<any>(
        `SELECT * FROM hotel_closure_requests WHERE id = ?${tx.forUpdateSuffix()}`,
        [id]
      );
      if (!row) throw new AppError(404, '关店申请不存在');
      if (row.status !== 'PENDING_APPROVAL') throw new AppError(409, '仅审批中的关店申请可撤销');
      if (Number(row.applicant_id) !== Number(req.user!.id) && req.user!.role !== 'HQ_ADMIN') {
        throw new AppError(403, '仅申请人或集团管理员可撤销关店申请');
      }

      const upd = await tx.execute(
        `UPDATE hotel_closure_requests SET status = 'CANCELLED', updated_at = ? WHERE id = ? AND status = 'PENDING_APPROVAL'`,
        [ts, id]
      );
      if (upd.affectedRows !== 1) throw new AppError(409, '单据状态已变化，请刷新后重试');
      await tx.execute(
        `UPDATE approval_steps SET status = 'CANCELLED' WHERE biz_type = 'HOTEL_CLOSURE' AND biz_id = ? AND status IN ('PENDING', 'WAITING')`,
        [id]
      );
      await logApprovalAction(tx, {
        bizType: 'HOTEL_CLOSURE',
        bizId: id,
        action: 'CANCEL',
        actor: req.user!,
        comment: '申请人撤销关店申请',
      });
      return tx.queryOne('SELECT * FROM hotel_closure_requests WHERE id = ?', [id]);
    });

    res.json({ request: updated });
  })
);

export default router;
