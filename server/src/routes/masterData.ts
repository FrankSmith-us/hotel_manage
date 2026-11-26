import { Router } from 'express';
import { z } from 'zod';
import { getDb } from '../../db';
import { DbQueryRunner } from '../../db/adapter';
import { AppError, asyncHandler, authenticate, requireRoles } from '../middleware/auth';
import { AuthUser } from '../types';
import { nowIso } from '../utils/numbers';

const router = Router();
router.use(authenticate);

export const DICT_CATEGORIES: Array<{ type: string; label: string; description: string }> = [
  { type: 'HOTEL_STATUS', label: '门店状态', description: '新建及运营中门店的生命周期状态（签约/装修/试营业/开业/停业整顿/关闭）' },
  { type: 'GENDER', label: '员工性别', description: '员工档案性别选项' },
  { type: 'EDUCATION', label: '学历类别', description: '员工学历层次分类' },
  { type: 'EMPLOYMENT_TYPE', label: '用工性质', description: '全职、兼职、实习生、劳务派遣等用工类型' },
  { type: 'MARITAL_STATUS', label: '婚姻状况', description: '员工婚姻状况档案信息' },
  { type: 'POLITICAL_STATUS', label: '政治面貌', description: '员工政治面貌档案信息' },
  { type: 'EXPENSE_CATEGORY', label: '费用报销科目', description: '门店及总部日常报销与预算科目' },
  { type: 'PAYMENT_CHANNEL', label: '财务付款渠道', description: '财务付款核销渠道选项' },
  { type: 'LEAVE_TYPE', label: '请假与加班类型', description: '员工休假、调休与加班申请类型' },
  { type: 'SHIFT_TYPE', label: '酒店排班班次', description: '门店早/中/晚/夜班及休息班次' },
  { type: 'CERT_TYPE', label: '证照资质类型', description: '酒店行业合规持证与到期预警类型' },
  { type: 'CONTRACT_TYPE', label: '劳动合同类型', description: '员工聘用合同/协议分类' },
  { type: 'RESIGN_REASON', label: '离职原因', description: '员工离职面谈与档案归档原因分类' },
];

const DICT_TYPE_SET = new Set(DICT_CATEGORIES.map((c) => c.type));

async function recordMasterAudit(
  db: DbQueryRunner,
  user: AuthUser,
  params: {
    entityType: string;
    entityId: number;
    entityLabel: string;
    action: 'CREATE' | 'UPDATE' | 'DELETE';
    beforeData: unknown;
    afterData: unknown;
  }
): Promise<void> {
  await db.execute(
    `INSERT INTO master_data_audit_logs (
      entity_type, entity_id, entity_label, action, before_data, after_data,
      operator_id, operator_name, operator_role, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      params.entityType,
      params.entityId,
      params.entityLabel,
      params.action,
      params.beforeData !== null && params.beforeData !== undefined ? JSON.stringify(params.beforeData) : null,
      params.afterData !== null && params.afterData !== undefined ? JSON.stringify(params.afterData) : null,
      user.id,
      user.display_name,
      user.role,
      nowIso(),
    ]
  );
}

// Public-to-authenticated options endpoint for dropdowns across the app
router.get(
  '/options',
  asyncHandler(async (_req, res) => {
    const db = getDb();
    const regions = await db.query<{ id: number; code: string; name: string; manager_user_id: number | null }>(
      `SELECT id, code, name, manager_user_id FROM regions ORDER BY id ASC`
    );
    const cities = await db.query<{ id: number; region_id: number; code: string; name: string; sort_order: number }>(
      `SELECT id, region_id, code, name, sort_order FROM cities WHERE is_active = 1 ORDER BY sort_order ASC, id ASC`
    );
    const districts = await db.query<{ id: number; city_id: number; code: string; name: string; sort_order: number }>(
      `SELECT id, city_id, code, name, sort_order FROM districts WHERE is_active = 1 ORDER BY sort_order ASC, id ASC`
    );
    const deptTemplates = await db.query<{
      id: number;
      org_level: string;
      code: string;
      name: string;
      category: string;
      sort_order: number;
    }>(
      `SELECT id, org_level, code, name, category, sort_order
       FROM dept_templates WHERE is_active = 1 ORDER BY org_level ASC, sort_order ASC, id ASC`
    );
    const jobPositions = await db.query<{
      id: number;
      org_level: string;
      dept_template_id: number;
      code: string;
      name: string;
      sort_order: number;
    }>(
      `SELECT id, org_level, dept_template_id, code, name, sort_order
       FROM job_positions WHERE is_active = 1 ORDER BY org_level ASC, dept_template_id ASC, sort_order ASC, id ASC`
    );
    const dictRows = await db.query<{
      id: number;
      dict_type: string;
      code: string;
      label: string;
      sort_order: number;
      is_system: number;
    }>(
      `SELECT id, dict_type, code, label, sort_order, is_system
       FROM master_dict_items WHERE is_active = 1 ORDER BY dict_type ASC, sort_order ASC, id ASC`
    );

    const dicts: Record<string, Array<{ id: number; code: string; label: string; sort_order: number; is_system: number }>> = {};
    for (const c of DICT_CATEGORIES) {
      dicts[c.type] = [];
    }
    for (const row of dictRows) {
      if (!dicts[row.dict_type]) dicts[row.dict_type] = [];
      dicts[row.dict_type].push({
        id: row.id,
        code: row.code,
        label: row.label,
        sort_order: row.sort_order,
        is_system: row.is_system,
      });
    }

    res.json({
      regions: regions.filter((r) => r.code !== 'HQ'),
      allRegions: regions,
      cities,
      districts,
      deptTemplates,
      jobPositions,
      dicts,
      dictCategories: DICT_CATEGORIES,
    });
  })
);

async function getDictRefCount(db: DbQueryRunner, dictType: string, code: string): Promise<{ count: number; detail: string }> {
  if (dictType === 'HOTEL_STATUS') {
    const r = await db.queryOne<{ cnt: number }>('SELECT COUNT(*) AS cnt FROM hotels WHERE status = ?', [code]);
    const cnt = Number(r?.cnt || 0);
    return { count: cnt, detail: cnt > 0 ? `${cnt} 家门店正在使用该状态` : '' };
  }
  if (dictType === 'GENDER') {
    const r = await db.queryOne<{ cnt: number }>('SELECT COUNT(*) AS cnt FROM employees WHERE gender = ?', [code]);
    const cnt = Number(r?.cnt || 0);
    return { count: cnt, detail: cnt > 0 ? `${cnt} 名员工档案使用该性别` : '' };
  }
  if (dictType === 'EDUCATION') {
    const r = await db.queryOne<{ cnt: number }>('SELECT COUNT(*) AS cnt FROM employees WHERE education = ?', [code]);
    const cnt = Number(r?.cnt || 0);
    return { count: cnt, detail: cnt > 0 ? `${cnt} 名员工档案使用该学历` : '' };
  }
  if (dictType === 'EMPLOYMENT_TYPE') {
    const r = await db.queryOne<{ cnt: number }>('SELECT COUNT(*) AS cnt FROM employees WHERE employment_type = ?', [code]);
    const cnt = Number(r?.cnt || 0);
    return { count: cnt, detail: cnt > 0 ? `${cnt} 名员工档案使用该用工性质` : '' };
  }
  if (dictType === 'MARITAL_STATUS') {
    const r = await db.queryOne<{ cnt: number }>('SELECT COUNT(*) AS cnt FROM employees WHERE marital_status = ?', [code]);
    const cnt = Number(r?.cnt || 0);
    return { count: cnt, detail: cnt > 0 ? `${cnt} 名员工档案使用该婚姻状况` : '' };
  }
  if (dictType === 'POLITICAL_STATUS') {
    const r = await db.queryOne<{ cnt: number }>('SELECT COUNT(*) AS cnt FROM employees WHERE political_status = ?', [code]);
    const cnt = Number(r?.cnt || 0);
    return { count: cnt, detail: cnt > 0 ? `${cnt} 名员工档案使用该政治面貌` : '' };
  }
  if (dictType === 'EXPENSE_CATEGORY') {
    const r1 = await db.queryOne<{ cnt: number }>('SELECT COUNT(*) AS cnt FROM reimbursement_items WHERE category = ?', [code]);
    const r2 = await db.queryOne<{ cnt: number }>('SELECT COUNT(*) AS cnt FROM store_budgets WHERE category = ?', [code]);
    const cnt = Number(r1?.cnt || 0) + Number(r2?.cnt || 0);
    return { count: cnt, detail: cnt > 0 ? `报销明细/预算中共有 ${cnt} 条关联记录` : '' };
  }
  if (dictType === 'PAYMENT_CHANNEL') {
    const r = await db.queryOne<{ cnt: number }>('SELECT COUNT(*) AS cnt FROM reimbursements WHERE payment_channel = ?', [code]);
    const cnt = Number(r?.cnt || 0);
    return { count: cnt, detail: cnt > 0 ? `${cnt} 笔已付款报销单使用该渠道` : '' };
  }
  if (dictType === 'LEAVE_TYPE') {
    const r = await db.queryOne<{ cnt: number }>('SELECT COUNT(*) AS cnt FROM leave_requests WHERE leave_type = ?', [code]);
    const cnt = Number(r?.cnt || 0);
    return { count: cnt, detail: cnt > 0 ? `${cnt} 条请假/加班单使用该类型` : '' };
  }
  if (dictType === 'SHIFT_TYPE') {
    const r = await db.queryOne<{ cnt: number }>('SELECT COUNT(*) AS cnt FROM shift_schedules WHERE shift_type = ?', [code]);
    const cnt = Number(r?.cnt || 0);
    return { count: cnt, detail: cnt > 0 ? `${cnt} 条排班记录使用该班次` : '' };
  }
  return { count: 0, detail: '' };
}

// Full master data listing with reference counts (for SystemConfigPage)
router.get(
  '/all',
  requireRoles('HQ_ADMIN', 'GENERAL_MANAGER', 'HR_MANAGER'),
  asyncHandler(async (_req, res) => {
    const db = getDb();

    const regionsRaw = await db.query<{ id: number; code: string; name: string; manager_user_id: number | null; created_at: string }>(
      'SELECT * FROM regions ORDER BY id ASC'
    );
    const regions = [];
    for (const r of regionsRaw) {
      const cCnt = Number((await db.queryOne<{ cnt: number }>('SELECT COUNT(*) AS cnt FROM cities WHERE region_id = ?', [r.id]))?.cnt || 0);
      const hCnt = Number((await db.queryOne<{ cnt: number }>('SELECT COUNT(*) AS cnt FROM hotels WHERE region_id = ?', [r.id]))?.cnt || 0);
      const uCnt = Number((await db.queryOne<{ cnt: number }>('SELECT COUNT(*) AS cnt FROM users WHERE region_id = ?', [r.id]))?.cnt || 0);
      const refCount = cCnt + hCnt + uCnt + (r.code === 'HQ' ? 1 : 0);
      regions.push({
        ...r,
        ref_count: refCount,
        ref_detail: r.code === 'HQ' ? '系统内置总部大区' : refCount > 0 ? `关联 ${cCnt} 城市 / ${hCnt} 门店 / ${uCnt} 账号` : '',
      });
    }

    const citiesRaw = await db.query<{
      id: number;
      region_id: number;
      code: string;
      name: string;
      sort_order: number;
      is_active: number;
      region_name: string;
    }>(
      `SELECT c.*, r.name AS region_name
       FROM cities c
       JOIN regions r ON r.id = c.region_id
       ORDER BY c.sort_order ASC, c.id ASC`
    );
    const cities = [];
    for (const c of citiesRaw) {
      const dCnt = Number((await db.queryOne<{ cnt: number }>('SELECT COUNT(*) AS cnt FROM districts WHERE city_id = ?', [c.id]))?.cnt || 0);
      const hCnt = Number((await db.queryOne<{ cnt: number }>('SELECT COUNT(*) AS cnt FROM hotels WHERE city_id = ?', [c.id]))?.cnt || 0);
      const refCount = dCnt + hCnt;
      cities.push({
        ...c,
        ref_count: refCount,
        ref_detail: refCount > 0 ? `关联 ${dCnt} 城区 / ${hCnt} 门店` : '',
      });
    }

    const districtsRaw = await db.query<{
      id: number;
      city_id: number;
      code: string;
      name: string;
      sort_order: number;
      is_active: number;
      city_name: string;
      region_id: number;
      region_name: string;
    }>(
      `SELECT d.*, c.name AS city_name, c.region_id, r.name AS region_name
       FROM districts d
       JOIN cities c ON c.id = d.city_id
       JOIN regions r ON r.id = c.region_id
       ORDER BY c.sort_order ASC, d.sort_order ASC, d.id ASC`
    );
    const districts = [];
    for (const d of districtsRaw) {
      const hCnt = Number((await db.queryOne<{ cnt: number }>('SELECT COUNT(*) AS cnt FROM hotels WHERE district_id = ?', [d.id]))?.cnt || 0);
      districts.push({
        ...d,
        ref_count: hCnt,
        ref_detail: hCnt > 0 ? `关联 ${hCnt} 家门店` : '',
      });
    }

    const deptTemplatesRaw = await db.query<{
      id: number;
      org_level: 'HQ' | 'REGION' | 'STORE';
      code: string;
      name: string;
      category: string;
      sort_order: number;
      is_active: number;
    }>('SELECT * FROM dept_templates ORDER BY org_level ASC, sort_order ASC, id ASC');
    const deptTemplates = [];
    for (const dt of deptTemplatesRaw) {
      const pCnt = Number(
        (await db.queryOne<{ cnt: number }>('SELECT COUNT(*) AS cnt FROM job_positions WHERE dept_template_id = ?', [dt.id]))?.cnt || 0
      );
      let dCnt = 0;
      if (dt.org_level === 'HQ') {
        dCnt = Number(
          (
            await db.queryOne<{ cnt: number }>(
              'SELECT COUNT(*) AS cnt FROM departments d JOIN hotels h ON h.id = d.hotel_id WHERE h.is_hq = 1 AND d.code = ?',
              [dt.code]
            )
          )?.cnt || 0
        );
      } else if (dt.org_level === 'STORE') {
        dCnt = Number(
          (
            await db.queryOne<{ cnt: number }>(
              'SELECT COUNT(*) AS cnt FROM departments d JOIN hotels h ON h.id = d.hotel_id WHERE h.is_hq = 0 AND d.code = ?',
              [dt.code]
            )
          )?.cnt || 0
        );
      }
      const refCount = pCnt + dCnt;
      deptTemplates.push({
        ...dt,
        ref_count: refCount,
        ref_detail: refCount > 0 ? `关联 ${pCnt} 职位 / ${dCnt} 机构部门` : '',
      });
    }

    const positionsRaw = await db.query<{
      id: number;
      org_level: 'HQ' | 'REGION' | 'STORE';
      dept_template_id: number;
      code: string;
      name: string;
      sort_order: number;
      is_active: number;
      dept_name: string;
      dept_code: string;
    }>(
      `SELECT p.*, dt.name AS dept_name, dt.code AS dept_code
       FROM job_positions p
       JOIN dept_templates dt ON dt.id = p.dept_template_id
       ORDER BY p.org_level ASC, dt.sort_order ASC, p.sort_order ASC, p.id ASC`
    );
    const jobPositions = [];
    for (const p of positionsRaw) {
      const eCnt = Number(
        (await db.queryOne<{ cnt: number }>('SELECT COUNT(*) AS cnt FROM employees WHERE position_id = ?', [p.id]))?.cnt || 0
      );
      const hcCnt =
        p.org_level === 'STORE'
          ? Number(
              (await db.queryOne<{ cnt: number }>('SELECT COUNT(*) AS cnt FROM headcount_requests WHERE position = ?', [p.name]))?.cnt || 0
            )
          : 0;
      const candCnt =
        p.org_level === 'STORE'
          ? Number(
              (await db.queryOne<{ cnt: number }>('SELECT COUNT(*) AS cnt FROM candidates WHERE position = ?', [p.name]))?.cnt || 0
            )
          : 0;
      const refCount = eCnt + hcCnt + candCnt;
      jobPositions.push({
        ...p,
        ref_count: refCount,
        ref_detail: refCount > 0 ? `关联 ${eCnt} 员工 / ${hcCnt} 补编 / ${candCnt} 候选人` : '',
      });
    }

    const dictsRaw = await db.query<{
      id: number;
      dict_type: string;
      code: string;
      label: string;
      sort_order: number;
      is_active: number;
      is_system: number;
    }>('SELECT * FROM master_dict_items ORDER BY dict_type ASC, sort_order ASC, id ASC');
    const dictItems = [];
    for (const d of dictsRaw) {
      const ref = await getDictRefCount(db, d.dict_type, d.code);
      dictItems.push({
        ...d,
        ref_count: ref.count,
        ref_detail: ref.detail,
      });
    }

    res.json({
      regions,
      cities,
      districts,
      deptTemplates,
      jobPositions,
      dictItems,
      dictCategories: DICT_CATEGORIES,
    });
  })
);

router.get(
  '/audit-logs',
  requireRoles('HQ_ADMIN', 'GENERAL_MANAGER'),
  asyncHandler(async (req, res) => {
    const db = getDb();
    const conditions = ['1=1'];
    const params: unknown[] = [];

    if (req.query.entityType) {
      conditions.push('entity_type = ?');
      params.push(String(req.query.entityType));
    }
    if (req.query.action) {
      conditions.push('action = ?');
      params.push(String(req.query.action));
    }
    if (req.query.keyword) {
      const kw = `%${String(req.query.keyword).trim()}%`;
      conditions.push('(entity_label LIKE ? OR operator_name LIKE ? OR before_data LIKE ? OR after_data LIKE ?)');
      params.push(kw, kw, kw, kw);
    }

    const logs = await db.query<{
      id: number;
      entity_type: string;
      entity_id: number;
      entity_label: string;
      action: string;
      before_data: string | null;
      after_data: string | null;
      operator_id: number;
      operator_name: string;
      operator_role: string;
      created_at: string;
    }>(
      `SELECT * FROM master_data_audit_logs
       WHERE ${conditions.join(' AND ')}
       ORDER BY id DESC
       LIMIT 150`,
      params
    );

    res.json({ logs });
  })
);

// === Regions CRUD (HQ_ADMIN only) ===
const regionSchema = z.object({
  code: z.string().trim().min(2).max(32),
  name: z.string().trim().min(2).max(100),
});

router.post(
  '/regions',
  requireRoles('HQ_ADMIN'),
  asyncHandler(async (req, res) => {
    const body = regionSchema.parse(req.body);
    const code = body.code.toUpperCase();
    const db = getDb();
    const ts = nowIso();
    const region = await db.transaction(async (tx) => {
      const dup = await tx.queryOne<{ id: number }>('SELECT id FROM regions WHERE code = ?', [code]);
      if (dup) throw new AppError(409, '大区编码已存在');
      const ins = await tx.execute('INSERT INTO regions (code, name, created_at) VALUES (?, ?, ?)', [code, body.name, ts]);
      const created = await tx.queryOne('SELECT * FROM regions WHERE id = ?', [ins.insertId]);
      await recordMasterAudit(tx, req.user!, {
        entityType: 'REGION',
        entityId: ins.insertId,
        entityLabel: `${body.name} (${code})`,
        action: 'CREATE',
        beforeData: null,
        afterData: created,
      });
      return created;
    });
    res.status(201).json({ region });
  })
);

router.put(
  '/regions/:id',
  requireRoles('HQ_ADMIN'),
  asyncHandler(async (req, res) => {
    const id = Number(req.params.id);
    const body = regionSchema.parse(req.body);
    const code = body.code.toUpperCase();
    const db = getDb();
    const region = await db.transaction(async (tx) => {
      const existing = await tx.queryOne<{ id: number; code: string; name: string }>('SELECT * FROM regions WHERE id = ?', [id]);
      if (!existing) throw new AppError(404, '大区不存在');
      if (existing.code === 'HQ' && code !== 'HQ') {
        throw new AppError(400, '系统内置集团总部大区编码不可修改');
      }
      const dup = await tx.queryOne<{ id: number }>('SELECT id FROM regions WHERE code = ? AND id != ?', [code, id]);
      if (dup) throw new AppError(409, '大区编码已存在');
      await tx.execute('UPDATE regions SET code = ?, name = ? WHERE id = ?', [code, body.name, id]);
      const updated = await tx.queryOne('SELECT * FROM regions WHERE id = ?', [id]);
      await recordMasterAudit(tx, req.user!, {
        entityType: 'REGION',
        entityId: id,
        entityLabel: `${body.name} (${code})`,
        action: 'UPDATE',
        beforeData: existing,
        afterData: updated,
      });
      return updated;
    });
    res.json({ region });
  })
);

router.delete(
  '/regions/:id',
  requireRoles('HQ_ADMIN'),
  asyncHandler(async (req, res) => {
    const id = Number(req.params.id);
    const db = getDb();
    await db.transaction(async (tx) => {
      const existing = await tx.queryOne<{ id: number; code: string; name: string }>('SELECT * FROM regions WHERE id = ?', [id]);
      if (!existing) throw new AppError(404, '大区不存在');
      if (existing.code === 'HQ') throw new AppError(400, '系统内置集团总部大区禁止删除');

      const cCnt = Number((await tx.queryOne<{ cnt: number }>('SELECT COUNT(*) AS cnt FROM cities WHERE region_id = ?', [id]))?.cnt || 0);
      const hCnt = Number((await tx.queryOne<{ cnt: number }>('SELECT COUNT(*) AS cnt FROM hotels WHERE region_id = ?', [id]))?.cnt || 0);
      const uCnt = Number((await tx.queryOne<{ cnt: number }>('SELECT COUNT(*) AS cnt FROM users WHERE region_id = ?', [id]))?.cnt || 0);
      if (cCnt + hCnt + uCnt > 0) {
        throw new AppError(409, `该大区存在关联数据（${cCnt} 个城市、${hCnt} 家门店、${uCnt} 个账号），禁止直接删除`);
      }

      await tx.execute('DELETE FROM regions WHERE id = ?', [id]);
      await recordMasterAudit(tx, req.user!, {
        entityType: 'REGION',
        entityId: id,
        entityLabel: `${existing.name} (${existing.code})`,
        action: 'DELETE',
        beforeData: existing,
        afterData: null,
      });
    });
    res.json({ ok: true });
  })
);

// === Cities CRUD ===
const citySchema = z.object({
  region_id: z.number().int().positive(),
  code: z.string().trim().min(2).max(32),
  name: z.string().trim().min(1).max(64),
  sort_order: z.number().int().min(0).default(0),
  is_active: z.boolean().default(true),
});

router.post(
  '/cities',
  requireRoles('HQ_ADMIN'),
  asyncHandler(async (req, res) => {
    const body = citySchema.parse(req.body);
    const code = body.code.toUpperCase();
    const db = getDb();
    const ts = nowIso();
    const city = await db.transaction(async (tx) => {
      const reg = await tx.queryOne<{ id: number }>('SELECT id FROM regions WHERE id = ?', [body.region_id]);
      if (!reg) throw new AppError(400, '所属大区不存在');
      const dup = await tx.queryOne<{ id: number }>('SELECT id FROM cities WHERE code = ?', [code]);
      if (dup) throw new AppError(409, '城市编码已存在');
      const ins = await tx.execute(
        `INSERT INTO cities (region_id, code, name, sort_order, is_active, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
        [body.region_id, code, body.name, body.sort_order, body.is_active ? 1 : 0, ts, ts]
      );
      const created = await tx.queryOne('SELECT * FROM cities WHERE id = ?', [ins.insertId]);
      await recordMasterAudit(tx, req.user!, {
        entityType: 'CITY',
        entityId: ins.insertId,
        entityLabel: `${body.name} (${code})`,
        action: 'CREATE',
        beforeData: null,
        afterData: created,
      });
      return created;
    });
    res.status(201).json({ city });
  })
);

router.put(
  '/cities/:id',
  requireRoles('HQ_ADMIN'),
  asyncHandler(async (req, res) => {
    const id = Number(req.params.id);
    const body = citySchema.parse(req.body);
    const code = body.code.toUpperCase();
    const db = getDb();
    const ts = nowIso();
    const city = await db.transaction(async (tx) => {
      const existing = await tx.queryOne<{ id: number }>('SELECT * FROM cities WHERE id = ?', [id]);
      if (!existing) throw new AppError(404, '城市不存在');
      const reg = await tx.queryOne<{ id: number }>('SELECT id FROM regions WHERE id = ?', [body.region_id]);
      if (!reg) throw new AppError(400, '所属大区不存在');
      const dup = await tx.queryOne<{ id: number }>('SELECT id FROM cities WHERE code = ? AND id != ?', [code, id]);
      if (dup) throw new AppError(409, '城市编码已存在');
      await tx.execute(
        `UPDATE cities SET region_id = ?, code = ?, name = ?, sort_order = ?, is_active = ?, updated_at = ? WHERE id = ?`,
        [body.region_id, code, body.name, body.sort_order, body.is_active ? 1 : 0, ts, id]
      );
      const updated = await tx.queryOne('SELECT * FROM cities WHERE id = ?', [id]);
      await recordMasterAudit(tx, req.user!, {
        entityType: 'CITY',
        entityId: id,
        entityLabel: `${body.name} (${code})`,
        action: 'UPDATE',
        beforeData: existing,
        afterData: updated,
      });
      return updated;
    });
    res.json({ city });
  })
);

router.delete(
  '/cities/:id',
  requireRoles('HQ_ADMIN'),
  asyncHandler(async (req, res) => {
    const id = Number(req.params.id);
    const db = getDb();
    await db.transaction(async (tx) => {
      const existing = await tx.queryOne<{ id: number; code: string; name: string }>('SELECT * FROM cities WHERE id = ?', [id]);
      if (!existing) throw new AppError(404, '城市不存在');
      const dCnt = Number((await tx.queryOne<{ cnt: number }>('SELECT COUNT(*) AS cnt FROM districts WHERE city_id = ?', [id]))?.cnt || 0);
      const hCnt = Number((await tx.queryOne<{ cnt: number }>('SELECT COUNT(*) AS cnt FROM hotels WHERE city_id = ?', [id]))?.cnt || 0);
      if (dCnt + hCnt > 0) {
        throw new AppError(409, `该城市存在关联数据（${dCnt} 个城区、${hCnt} 家门店），禁止直接删除`);
      }
      await tx.execute('DELETE FROM cities WHERE id = ?', [id]);
      await recordMasterAudit(tx, req.user!, {
        entityType: 'CITY',
        entityId: id,
        entityLabel: `${existing.name} (${existing.code})`,
        action: 'DELETE',
        beforeData: existing,
        afterData: null,
      });
    });
    res.json({ ok: true });
  })
);

// === Districts CRUD ===
const districtSchema = z.object({
  city_id: z.number().int().positive(),
  code: z.string().trim().min(2).max(32),
  name: z.string().trim().min(1).max(64),
  sort_order: z.number().int().min(0).default(0),
  is_active: z.boolean().default(true),
});

router.post(
  '/districts',
  requireRoles('HQ_ADMIN'),
  asyncHandler(async (req, res) => {
    const body = districtSchema.parse(req.body);
    const code = body.code.toUpperCase();
    const db = getDb();
    const ts = nowIso();
    const district = await db.transaction(async (tx) => {
      const city = await tx.queryOne<{ id: number }>('SELECT id FROM cities WHERE id = ?', [body.city_id]);
      if (!city) throw new AppError(400, '所属城市不存在');
      const dup = await tx.queryOne<{ id: number }>('SELECT id FROM districts WHERE code = ?', [code]);
      if (dup) throw new AppError(409, '城区编码已存在');
      const ins = await tx.execute(
        `INSERT INTO districts (city_id, code, name, sort_order, is_active, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
        [body.city_id, code, body.name, body.sort_order, body.is_active ? 1 : 0, ts, ts]
      );
      const created = await tx.queryOne('SELECT * FROM districts WHERE id = ?', [ins.insertId]);
      await recordMasterAudit(tx, req.user!, {
        entityType: 'DISTRICT',
        entityId: ins.insertId,
        entityLabel: `${body.name} (${code})`,
        action: 'CREATE',
        beforeData: null,
        afterData: created,
      });
      return created;
    });
    res.status(201).json({ district });
  })
);

router.put(
  '/districts/:id',
  requireRoles('HQ_ADMIN'),
  asyncHandler(async (req, res) => {
    const id = Number(req.params.id);
    const body = districtSchema.parse(req.body);
    const code = body.code.toUpperCase();
    const db = getDb();
    const ts = nowIso();
    const district = await db.transaction(async (tx) => {
      const existing = await tx.queryOne<{ id: number }>('SELECT * FROM districts WHERE id = ?', [id]);
      if (!existing) throw new AppError(404, '城区不存在');
      const city = await tx.queryOne<{ id: number }>('SELECT id FROM cities WHERE id = ?', [body.city_id]);
      if (!city) throw new AppError(400, '所属城市不存在');
      const dup = await tx.queryOne<{ id: number }>('SELECT id FROM districts WHERE code = ? AND id != ?', [code, id]);
      if (dup) throw new AppError(409, '城区编码已存在');
      await tx.execute(
        `UPDATE districts SET city_id = ?, code = ?, name = ?, sort_order = ?, is_active = ?, updated_at = ? WHERE id = ?`,
        [body.city_id, code, body.name, body.sort_order, body.is_active ? 1 : 0, ts, id]
      );
      const updated = await tx.queryOne('SELECT * FROM districts WHERE id = ?', [id]);
      await recordMasterAudit(tx, req.user!, {
        entityType: 'DISTRICT',
        entityId: id,
        entityLabel: `${body.name} (${code})`,
        action: 'UPDATE',
        beforeData: existing,
        afterData: updated,
      });
      return updated;
    });
    res.json({ district });
  })
);

router.delete(
  '/districts/:id',
  requireRoles('HQ_ADMIN'),
  asyncHandler(async (req, res) => {
    const id = Number(req.params.id);
    const db = getDb();
    await db.transaction(async (tx) => {
      const existing = await tx.queryOne<{ id: number; code: string; name: string }>('SELECT * FROM districts WHERE id = ?', [id]);
      if (!existing) throw new AppError(404, '城区不存在');
      const hCnt = Number((await tx.queryOne<{ cnt: number }>('SELECT COUNT(*) AS cnt FROM hotels WHERE district_id = ?', [id]))?.cnt || 0);
      if (hCnt > 0) {
        throw new AppError(409, `该城区已关联 ${hCnt} 家门店，禁止直接删除`);
      }
      await tx.execute('DELETE FROM districts WHERE id = ?', [id]);
      await recordMasterAudit(tx, req.user!, {
        entityType: 'DISTRICT',
        entityId: id,
        entityLabel: `${existing.name} (${existing.code})`,
        action: 'DELETE',
        beforeData: existing,
        afterData: null,
      });
    });
    res.json({ ok: true });
  })
);

// === Department Templates CRUD (HQ / REGION / STORE) ===
const deptTplSchema = z.object({
  org_level: z.enum(['HQ', 'REGION', 'STORE']),
  code: z.string().trim().min(2).max(32),
  name: z.string().trim().min(2).max(80),
  category: z.enum(['FRONT_OFFICE', 'HOUSEKEEPING', 'ENGINEERING', 'FB', 'ADMIN']).default('ADMIN'),
  sort_order: z.number().int().min(0).default(0),
  is_active: z.boolean().default(true),
});

router.post(
  '/dept-templates',
  requireRoles('HQ_ADMIN'),
  asyncHandler(async (req, res) => {
    const body = deptTplSchema.parse(req.body);
    const code = body.code.toUpperCase();
    const db = getDb();
    const ts = nowIso();
    const deptTemplate = await db.transaction(async (tx) => {
      const dup = await tx.queryOne<{ id: number }>(
        'SELECT id FROM dept_templates WHERE org_level = ? AND code = ?',
        [body.org_level, code]
      );
      if (dup) throw new AppError(409, `该层级下部门编码 ${code} 已存在`);
      const ins = await tx.execute(
        `INSERT INTO dept_templates (org_level, code, name, category, sort_order, is_active, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        [body.org_level, code, body.name, body.category, body.sort_order, body.is_active ? 1 : 0, ts, ts]
      );
      const created = await tx.queryOne('SELECT * FROM dept_templates WHERE id = ?', [ins.insertId]);
      await recordMasterAudit(tx, req.user!, {
        entityType: 'DEPT_TEMPLATE',
        entityId: ins.insertId,
        entityLabel: `[${body.org_level}] ${body.name} (${code})`,
        action: 'CREATE',
        beforeData: null,
        afterData: created,
      });
      return created;
    });
    res.status(201).json({ deptTemplate });
  })
);

router.put(
  '/dept-templates/:id',
  requireRoles('HQ_ADMIN'),
  asyncHandler(async (req, res) => {
    const id = Number(req.params.id);
    const body = deptTplSchema.parse(req.body);
    const code = body.code.toUpperCase();
    const db = getDb();
    const ts = nowIso();
    const deptTemplate = await db.transaction(async (tx) => {
      const existing = await tx.queryOne<{ id: number; org_level: string }>('SELECT * FROM dept_templates WHERE id = ?', [id]);
      if (!existing) throw new AppError(404, '部门模板不存在');
      const dup = await tx.queryOne<{ id: number }>(
        'SELECT id FROM dept_templates WHERE org_level = ? AND code = ? AND id != ?',
        [body.org_level, code, id]
      );
      if (dup) throw new AppError(409, `该层级下部门编码 ${code} 已存在`);
      await tx.execute(
        `UPDATE dept_templates SET org_level = ?, code = ?, name = ?, category = ?, sort_order = ?, is_active = ?, updated_at = ?
         WHERE id = ?`,
        [body.org_level, code, body.name, body.category, body.sort_order, body.is_active ? 1 : 0, ts, id]
      );
      const updated = await tx.queryOne('SELECT * FROM dept_templates WHERE id = ?', [id]);
      await recordMasterAudit(tx, req.user!, {
        entityType: 'DEPT_TEMPLATE',
        entityId: id,
        entityLabel: `[${body.org_level}] ${body.name} (${code})`,
        action: 'UPDATE',
        beforeData: existing,
        afterData: updated,
      });
      return updated;
    });
    res.json({ deptTemplate });
  })
);

router.delete(
  '/dept-templates/:id',
  requireRoles('HQ_ADMIN'),
  asyncHandler(async (req, res) => {
    const id = Number(req.params.id);
    const db = getDb();
    await db.transaction(async (tx) => {
      const existing = await tx.queryOne<{ id: number; org_level: string; code: string; name: string }>(
        'SELECT * FROM dept_templates WHERE id = ?',
        [id]
      );
      if (!existing) throw new AppError(404, '部门模板不存在');
      const pCnt = Number((await tx.queryOne<{ cnt: number }>('SELECT COUNT(*) AS cnt FROM job_positions WHERE dept_template_id = ?', [id]))?.cnt || 0);
      let dCnt = 0;
      if (existing.org_level === 'HQ') {
        dCnt = Number(
          (
            await tx.queryOne<{ cnt: number }>(
              'SELECT COUNT(*) AS cnt FROM departments d JOIN hotels h ON h.id = d.hotel_id WHERE h.is_hq = 1 AND d.code = ?',
              [existing.code]
            )
          )?.cnt || 0
        );
      } else if (existing.org_level === 'STORE') {
        dCnt = Number(
          (
            await tx.queryOne<{ cnt: number }>(
              'SELECT COUNT(*) AS cnt FROM departments d JOIN hotels h ON h.id = d.hotel_id WHERE h.is_hq = 0 AND d.code = ?',
              [existing.code]
            )
          )?.cnt || 0
        );
      }
      if (pCnt + dCnt > 0) {
        throw new AppError(409, `该部门已关联 ${pCnt} 个职位与 ${dCnt} 个机构部门，禁止直接删除`);
      }
      await tx.execute('DELETE FROM dept_templates WHERE id = ?', [id]);
      await recordMasterAudit(tx, req.user!, {
        entityType: 'DEPT_TEMPLATE',
        entityId: id,
        entityLabel: `[${existing.org_level}] ${existing.name} (${existing.code})`,
        action: 'DELETE',
        beforeData: existing,
        afterData: null,
      });
    });
    res.json({ ok: true });
  })
);

// === Job Positions CRUD (Strictly separated by org_level + dept_template_id) ===
const positionSchema = z.object({
  org_level: z.enum(['HQ', 'REGION', 'STORE']),
  dept_template_id: z.number().int().positive(),
  code: z.string().trim().min(2).max(32),
  name: z.string().trim().min(2).max(80),
  sort_order: z.number().int().min(0).default(0),
  is_active: z.boolean().default(true),
});

router.post(
  '/positions',
  requireRoles('HQ_ADMIN'),
  asyncHandler(async (req, res) => {
    const body = positionSchema.parse(req.body);
    const code = body.code.toUpperCase();
    const db = getDb();
    const ts = nowIso();
    const position = await db.transaction(async (tx) => {
      const dt = await tx.queryOne<{ id: number; org_level: string; name: string }>(
        'SELECT id, org_level, name FROM dept_templates WHERE id = ?',
        [body.dept_template_id]
      );
      if (!dt) throw new AppError(400, '所属部门不存在');
      if (dt.org_level !== body.org_level) {
        throw new AppError(400, '所选部门层级与职位层级不一致（总部/大区/门店职位必须分开创建）');
      }
      const dup = await tx.queryOne<{ id: number }>(
        'SELECT id FROM job_positions WHERE org_level = ? AND dept_template_id = ? AND code = ?',
        [body.org_level, body.dept_template_id, code]
      );
      if (dup) throw new AppError(409, `该部门下职位编码 ${code} 已存在`);
      const ins = await tx.execute(
        `INSERT INTO job_positions (org_level, dept_template_id, code, name, sort_order, is_active, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        [body.org_level, body.dept_template_id, code, body.name, body.sort_order, body.is_active ? 1 : 0, ts, ts]
      );
      const created = await tx.queryOne('SELECT * FROM job_positions WHERE id = ?', [ins.insertId]);
      await recordMasterAudit(tx, req.user!, {
        entityType: 'JOB_POSITION',
        entityId: ins.insertId,
        entityLabel: `[${body.org_level}/${dt.name}] ${body.name} (${code})`,
        action: 'CREATE',
        beforeData: null,
        afterData: created,
      });
      return created;
    });
    res.status(201).json({ position });
  })
);

router.put(
  '/positions/:id',
  requireRoles('HQ_ADMIN'),
  asyncHandler(async (req, res) => {
    const id = Number(req.params.id);
    const body = positionSchema.parse(req.body);
    const code = body.code.toUpperCase();
    const db = getDb();
    const ts = nowIso();
    const position = await db.transaction(async (tx) => {
      const existing = await tx.queryOne<{ id: number }>('SELECT * FROM job_positions WHERE id = ?', [id]);
      if (!existing) throw new AppError(404, '职位不存在');
      const dt = await tx.queryOne<{ id: number; org_level: string; name: string }>(
        'SELECT id, org_level, name FROM dept_templates WHERE id = ?',
        [body.dept_template_id]
      );
      if (!dt) throw new AppError(400, '所属部门不存在');
      if (dt.org_level !== body.org_level) {
        throw new AppError(400, '所选部门层级与职位层级不一致（总部/大区/门店职位必须分开维护）');
      }
      const dup = await tx.queryOne<{ id: number }>(
        'SELECT id FROM job_positions WHERE org_level = ? AND dept_template_id = ? AND code = ? AND id != ?',
        [body.org_level, body.dept_template_id, code, id]
      );
      if (dup) throw new AppError(409, `该部门下职位编码 ${code} 已存在`);
      await tx.execute(
        `UPDATE job_positions SET org_level = ?, dept_template_id = ?, code = ?, name = ?, sort_order = ?, is_active = ?, updated_at = ?
         WHERE id = ?`,
        [body.org_level, body.dept_template_id, code, body.name, body.sort_order, body.is_active ? 1 : 0, ts, id]
      );
      const updated = await tx.queryOne('SELECT * FROM job_positions WHERE id = ?', [id]);
      await recordMasterAudit(tx, req.user!, {
        entityType: 'JOB_POSITION',
        entityId: id,
        entityLabel: `[${body.org_level}/${dt.name}] ${body.name} (${code})`,
        action: 'UPDATE',
        beforeData: existing,
        afterData: updated,
      });
      return updated;
    });
    res.json({ position });
  })
);

router.delete(
  '/positions/:id',
  requireRoles('HQ_ADMIN'),
  asyncHandler(async (req, res) => {
    const id = Number(req.params.id);
    const db = getDb();
    await db.transaction(async (tx) => {
      const existing = await tx.queryOne<{ id: number; org_level: string; code: string; name: string }>(
        'SELECT * FROM job_positions WHERE id = ?',
        [id]
      );
      if (!existing) throw new AppError(404, '职位不存在');
      const eCnt = Number((await tx.queryOne<{ cnt: number }>('SELECT COUNT(*) AS cnt FROM employees WHERE position_id = ?', [id]))?.cnt || 0);
      const hcCnt =
        existing.org_level === 'STORE'
          ? Number((await tx.queryOne<{ cnt: number }>('SELECT COUNT(*) AS cnt FROM headcount_requests WHERE position = ?', [existing.name]))?.cnt || 0)
          : 0;
      const candCnt =
        existing.org_level === 'STORE'
          ? Number((await tx.queryOne<{ cnt: number }>('SELECT COUNT(*) AS cnt FROM candidates WHERE position = ?', [existing.name]))?.cnt || 0)
          : 0;
      if (eCnt + hcCnt + candCnt > 0) {
        throw new AppError(409, `该职位已关联 ${eCnt} 名员工、${hcCnt} 条补编、${candCnt} 名候选人，禁止直接删除`);
      }
      await tx.execute('DELETE FROM job_positions WHERE id = ?', [id]);
      await recordMasterAudit(tx, req.user!, {
        entityType: 'JOB_POSITION',
        entityId: id,
        entityLabel: `[${existing.org_level}] ${existing.name} (${existing.code})`,
        action: 'DELETE',
        beforeData: existing,
        afterData: null,
      });
    });
    res.json({ ok: true });
  })
);

// === Master Dictionary Items CRUD ===
const dictSchema = z.object({
  dict_type: z.string().trim().min(2).max(40),
  code: z.string().trim().min(1).max(40),
  label: z.string().trim().min(1).max(80),
  sort_order: z.number().int().min(0).default(0),
  is_active: z.boolean().default(true),
});

router.post(
  '/dicts',
  requireRoles('HQ_ADMIN'),
  asyncHandler(async (req, res) => {
    const body = dictSchema.parse(req.body);
    const dictType = body.dict_type.toUpperCase();
    if (!DICT_TYPE_SET.has(dictType)) {
      throw new AppError(400, '不支持的字典分类');
    }
    const code = body.code.toUpperCase();
    const db = getDb();
    const ts = nowIso();
    const item = await db.transaction(async (tx) => {
      const dup = await tx.queryOne<{ id: number }>(
        'SELECT id FROM master_dict_items WHERE dict_type = ? AND code = ?',
        [dictType, code]
      );
      if (dup) throw new AppError(409, `字典编码 ${code} 已存在`);
      const ins = await tx.execute(
        `INSERT INTO master_dict_items (dict_type, code, label, sort_order, is_active, is_system, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, 0, ?, ?)`,
        [dictType, code, body.label, body.sort_order, body.is_active ? 1 : 0, ts, ts]
      );
      const created = await tx.queryOne('SELECT * FROM master_dict_items WHERE id = ?', [ins.insertId]);
      await recordMasterAudit(tx, req.user!, {
        entityType: `DICT:${dictType}`,
        entityId: ins.insertId,
        entityLabel: `${body.label} (${code})`,
        action: 'CREATE',
        beforeData: null,
        afterData: created,
      });
      return created;
    });
    res.status(201).json({ item });
  })
);

router.put(
  '/dicts/:id',
  requireRoles('HQ_ADMIN'),
  asyncHandler(async (req, res) => {
    const id = Number(req.params.id);
    const body = dictSchema.parse(req.body);
    const code = body.code.toUpperCase();
    const db = getDb();
    const ts = nowIso();
    const item = await db.transaction(async (tx) => {
      const existing = await tx.queryOne<{ id: number; dict_type: string; code: string; is_system: number }>(
        'SELECT * FROM master_dict_items WHERE id = ?',
        [id]
      );
      if (!existing) throw new AppError(404, '字典项不存在');
      if (existing.is_system && code !== existing.code) {
        throw new AppError(400, '系统核心字典编码不可修改，可调整显示名称或排序');
      }
      const dup = await tx.queryOne<{ id: number }>(
        'SELECT id FROM master_dict_items WHERE dict_type = ? AND code = ? AND id != ?',
        [existing.dict_type, code, id]
      );
      if (dup) throw new AppError(409, `字典编码 ${code} 已存在`);
      await tx.execute(
        `UPDATE master_dict_items SET code = ?, label = ?, sort_order = ?, is_active = ?, updated_at = ? WHERE id = ?`,
        [code, body.label, body.sort_order, body.is_active ? 1 : 0, ts, id]
      );
      const updated = await tx.queryOne('SELECT * FROM master_dict_items WHERE id = ?', [id]);
      await recordMasterAudit(tx, req.user!, {
        entityType: `DICT:${existing.dict_type}`,
        entityId: id,
        entityLabel: `${body.label} (${code})`,
        action: 'UPDATE',
        beforeData: existing,
        afterData: updated,
      });
      return updated;
    });
    res.json({ item });
  })
);

router.delete(
  '/dicts/:id',
  requireRoles('HQ_ADMIN'),
  asyncHandler(async (req, res) => {
    const id = Number(req.params.id);
    const db = getDb();
    await db.transaction(async (tx) => {
      const existing = await tx.queryOne<{ id: number; dict_type: string; code: string; label: string; is_system: number }>(
        'SELECT * FROM master_dict_items WHERE id = ?',
        [id]
      );
      if (!existing) throw new AppError(404, '字典项不存在');
      if (existing.is_system) {
        throw new AppError(409, '系统内置核心字典项禁止直接删除（可通过编辑停用）');
      }
      const ref = await getDictRefCount(tx, existing.dict_type, existing.code);
      if (ref.count > 0) {
        throw new AppError(409, `该字典项已被业务数据引用（${ref.detail}），禁止直接删除`);
      }
      await tx.execute('DELETE FROM master_dict_items WHERE id = ?', [id]);
      await recordMasterAudit(tx, req.user!, {
        entityType: `DICT:${existing.dict_type}`,
        entityId: id,
        entityLabel: `${existing.label} (${existing.code})`,
        action: 'DELETE',
        beforeData: existing,
        afterData: null,
      });
    });
    res.json({ ok: true });
  })
);

export default router;
