import { Router } from 'express';
import { z } from 'zod';
import { getDb } from '../../db';
import {
  AppError,
  asyncHandler,
  authenticate,
  canAccessHotel,
  getScopeFilter,
  requireRoles,
} from '../middleware/auth';
import { addDays, nowIso, todayStr } from '../utils/numbers';

const router = Router();
router.use(authenticate);

router.get(
  '/',
  asyncHandler(async (req, res) => {
    const db = getDb();
    const scope = await getScopeFilter(req.user!);
    const conditions: string[] = ['1=1'];
    const params: unknown[] = [];

    if (scope.type === 'REGION') {
      if (scope.hotelIds.length === 0) {
        res.json({ employees: [] });
        return;
      }
      conditions.push(`e.hotel_id IN (${scope.hotelIds.map(() => '?').join(',')})`);
      params.push(...scope.hotelIds);
    } else if (scope.type === 'HOTEL') {
      conditions.push('e.hotel_id = ?');
      params.push(scope.hotelId);
    } else if (scope.type === 'SELF') {
      conditions.push('e.hotel_id = ?');
      params.push(scope.hotelId);
    }

    if (req.query.hotelId) {
      conditions.push('e.hotel_id = ?');
      params.push(Number(req.query.hotelId));
    }
    if (req.query.departmentId) {
      conditions.push('e.department_id = ?');
      params.push(Number(req.query.departmentId));
    }
    if (req.query.status) {
      conditions.push('e.status = ?');
      params.push(String(req.query.status));
    }
    if (req.query.keyword) {
      const kw = `%${String(req.query.keyword).trim()}%`;
      conditions.push('(e.name LIKE ? OR e.emp_no LIKE ? OR e.position LIKE ? OR e.phone LIKE ?)');
      params.push(kw, kw, kw, kw);
    }

    const alertEnd = addDays(todayStr(), 30);
    if (req.query.alertType === 'health_cert') {
      conditions.push(`e.status IN ('ACTIVE', 'PROBATION') AND e.health_cert_expiry IS NOT NULL AND e.health_cert_expiry <= ?`);
      params.push(alertEnd);
    } else if (req.query.alertType === 'contract') {
      conditions.push(`e.status IN ('ACTIVE', 'PROBATION') AND e.contract_end_date IS NOT NULL AND e.contract_end_date <= ?`);
      params.push(alertEnd);
    }

    const employees = await db.query(
      `SELECT e.*, h.name AS hotel_name, h.code AS hotel_code, d.name AS department_name
       FROM employees e
       JOIN hotels h ON h.id = e.hotel_id
       JOIN departments d ON d.id = e.department_id
       WHERE ${conditions.join(' AND ')}
       ORDER BY e.hotel_id ASC, e.id ASC`,
      params
    );

    res.json({ employees });
  })
);

router.get(
  '/alerts',
  asyncHandler(async (req, res) => {
    const db = getDb();
    const scope = await getScopeFilter(req.user!);
    const today = todayStr();
    const alertEnd = addDays(today, 30);

    const conditions = [`e.status IN ('ACTIVE', 'PROBATION')`];
    const params: unknown[] = [];
    if (scope.type === 'REGION') {
      if (scope.hotelIds.length === 0) {
        res.json({ alerts: [] });
        return;
      }
      conditions.push(`e.hotel_id IN (${scope.hotelIds.map(() => '?').join(',')})`);
      params.push(...scope.hotelIds);
    } else if (scope.type === 'HOTEL' || scope.type === 'SELF') {
      conditions.push('e.hotel_id = ?');
      params.push(scope.hotelId);
    }

    const rows = await db.query<{
      id: number;
      emp_no: string;
      name: string;
      position: string;
      hotel_name: string;
      health_cert_expiry: string | null;
      contract_end_date: string | null;
    }>(
      `SELECT e.id, e.emp_no, e.name, e.position, h.name AS hotel_name, e.health_cert_expiry, e.contract_end_date
       FROM employees e
       JOIN hotels h ON h.id = e.hotel_id
       WHERE ${conditions.join(' AND ')}
         AND (
           (e.health_cert_expiry IS NOT NULL AND e.health_cert_expiry <= ?)
           OR (e.contract_end_date IS NOT NULL AND e.contract_end_date <= ?)
         )
       ORDER BY COALESCE(e.health_cert_expiry, e.contract_end_date) ASC`,
      [...params, alertEnd, alertEnd]
    );

    res.json({ alerts: rows, today, alertEnd });
  })
);

router.get(
  '/:id',
  asyncHandler(async (req, res) => {
    const db = getDb();
    const id = Number(req.params.id);
    const employee = await db.queryOne<{ id: number; hotel_id: number }>(
      `SELECT e.*, h.name AS hotel_name, d.name AS department_name
       FROM employees e
       JOIN hotels h ON h.id = e.hotel_id
       JOIN departments d ON d.id = e.department_id
       WHERE e.id = ?`,
      [id]
    );
    if (!employee) throw new AppError(404, '员工档案不存在');
    if (!(await canAccessHotel(req.user!, employee.hotel_id))) {
      throw new AppError(403, '无权限查看其他门店员工档案');
    }

    const events = await db.query(
      `SELECT ev.*, fh.name AS from_hotel_name, th.name AS to_hotel_name, u.display_name AS operator_name
       FROM employee_lifecycle_events ev
       LEFT JOIN hotels fh ON fh.id = ev.from_hotel_id
       LEFT JOIN hotels th ON th.id = ev.to_hotel_id
       LEFT JOIN users u ON u.id = ev.operator_id
       WHERE ev.employee_id = ?
       ORDER BY ev.effective_date DESC, ev.id DESC`,
      [id]
    );

    res.json({ employee, events });
  })
);

const createEmpSchema = z.object({
  emp_no: z.string().min(2).optional(),
  name: z.string().min(1, '请输入员工姓名'),
  gender: z.enum(['M', 'F']).default('M'),
  phone: z.string().min(6, '请输入有效手机号'),
  email: z.string().optional().nullable(),
  hotel_id: z.number().int().positive(),
  department_id: z.number().int().positive(),
  position: z.string().min(1, '请输入岗位名称'),
  employment_type: z.enum(['FULL_TIME', 'PART_TIME', 'INTERN']).default('FULL_TIME'),
  status: z.enum(['ACTIVE', 'PROBATION']).default('PROBATION'),
  hire_date: z.string().min(8).default(todayStr),
  contract_end_date: z.string().optional().nullable(),
  health_cert_no: z.string().optional().nullable(),
  health_cert_expiry: z.string().optional().nullable(),
  base_salary: z.number().min(0),
  night_allowance_rate: z.number().min(0).default(80),
  bank_name: z.string().optional().nullable(),
  bank_account: z.string().optional().nullable(),
});

router.post(
  '/',
  requireRoles('HQ_ADMIN', 'HR_MANAGER', 'STORE_MANAGER'),
  asyncHandler(async (req, res) => {
    const body = createEmpSchema.parse(req.body);
    if (!(await canAccessHotel(req.user!, body.hotel_id))) {
      throw new AppError(403, '无权为其他门店办理入职');
    }
    const db = getDb();
    const ts = nowIso();
    const empNo = body.emp_no || `YQ-${Date.now().toString().slice(-5)}`;
    const probationEnd = body.status === 'PROBATION' ? addDays(body.hire_date, 90) : null;
    const contractEnd = body.contract_end_date || addDays(body.hire_date, 730);

    const empId = await db.transaction(async (tx) => {
      const insertRes = await tx.execute(
        `INSERT INTO employees (
          emp_no, name, gender, phone, email, id_card_last4, hotel_id, department_id,
          position, employment_type, status, hire_date, probation_end_date, contract_end_date,
          health_cert_no, health_cert_expiry, base_salary, night_allowance_rate,
          bank_name, bank_account, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, '8888', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          empNo,
          body.name,
          body.gender,
          body.phone,
          body.email ?? null,
          body.hotel_id,
          body.department_id,
          body.position,
          body.employment_type,
          body.status,
          body.hire_date,
          probationEnd,
          contractEnd,
          body.health_cert_no ?? null,
          body.health_cert_expiry ?? null,
          body.base_salary,
          body.night_allowance_rate,
          body.bank_name ?? null,
          body.bank_account ?? null,
          ts,
          ts,
        ]
      );

      await tx.execute(
        `INSERT INTO employee_lifecycle_events (
          employee_id, event_type, from_hotel_id, to_hotel_id, from_position, to_position,
          effective_date, reason, operator_id, created_at
        ) VALUES (?, 'ONBOARD', NULL, ?, NULL, ?, ?, '新员工入职建档', ?, ?)`,
        [insertRes.insertId, body.hotel_id, body.position, body.hire_date, req.user!.id, ts]
      );

      return insertRes.insertId;
    });

    const employee = await db.queryOne('SELECT * FROM employees WHERE id = ?', [empId]);
    res.status(201).json({ employee });
  })
);

const updateEmpSchema = z.object({
  phone: z.string().min(6).optional(),
  email: z.string().nullable().optional(),
  health_cert_no: z.string().nullable().optional(),
  health_cert_expiry: z.string().nullable().optional(),
  contract_end_date: z.string().nullable().optional(),
  base_salary: z.number().min(0).optional(),
  night_allowance_rate: z.number().min(0).optional(),
  bank_name: z.string().nullable().optional(),
  bank_account: z.string().nullable().optional(),
});

router.put(
  '/:id',
  requireRoles('HQ_ADMIN', 'HR_MANAGER', 'STORE_MANAGER'),
  asyncHandler(async (req, res) => {
    const id = Number(req.params.id);
    const body = updateEmpSchema.parse(req.body);
    const db = getDb();
    const emp = await db.queryOne<{ id: number; hotel_id: number }>('SELECT id, hotel_id FROM employees WHERE id = ?', [id]);
    if (!emp) throw new AppError(404, '员工不存在');
    if (!(await canAccessHotel(req.user!, emp.hotel_id))) {
      throw new AppError(403, '无权限编辑其他门店员工');
    }

    const fields: string[] = [];
    const vals: unknown[] = [];
    for (const [k, v] of Object.entries(body)) {
      if (v !== undefined) {
        fields.push(`${k} = ?`);
        vals.push(v);
      }
    }
    if (fields.length > 0) {
      fields.push('updated_at = ?');
      vals.push(nowIso(), id);
      await db.execute(`UPDATE employees SET ${fields.join(', ')} WHERE id = ?`, vals);
    }

    const updated = await db.queryOne('SELECT * FROM employees WHERE id = ?', [id]);
    res.json({ employee: updated });
  })
);

const lifecycleSchema = z.object({
  event_type: z.enum(['CONFIRM', 'TRANSFER', 'PROMOTE', 'RESIGN']),
  to_hotel_id: z.number().int().positive().optional(),
  to_department_id: z.number().int().positive().optional(),
  to_position: z.string().min(1).optional(),
  base_salary: z.number().min(0).optional(),
  effective_date: z.string().min(8).default(todayStr),
  reason: z.string().min(2, '请填写变动原因'),
});

router.post(
  '/:id/lifecycle',
  requireRoles('HQ_ADMIN', 'HR_MANAGER', 'REGIONAL_MANAGER', 'STORE_MANAGER'),
  asyncHandler(async (req, res) => {
    const id = Number(req.params.id);
    const body = lifecycleSchema.parse(req.body);
    const db = getDb();

    const emp = await db.queryOne<{
      id: number;
      hotel_id: number;
      department_id: number;
      position: string;
      status: string;
      base_salary: number;
    }>('SELECT id, hotel_id, department_id, position, status, base_salary FROM employees WHERE id = ?', [id]);

    if (!emp) throw new AppError(404, '员工不存在');
    if (!(await canAccessHotel(req.user!, emp.hotel_id))) {
      throw new AppError(403, '无权限操作其他门店员工人事变动');
    }

    const ts = nowIso();
    let newHotelId = emp.hotel_id;
    let newDeptId = emp.department_id;
    let newPos = emp.position;
    let newStatus = emp.status;
    const newSalary = body.base_salary !== undefined ? body.base_salary : emp.base_salary;

    if (body.event_type === 'CONFIRM') {
      newStatus = 'ACTIVE';
    } else if (body.event_type === 'TRANSFER') {
      newHotelId = body.to_hotel_id ?? emp.hotel_id;
      newDeptId = body.to_department_id ?? emp.department_id;
      newPos = body.to_position ?? emp.position;
    } else if (body.event_type === 'PROMOTE') {
      newPos = body.to_position ?? emp.position;
    } else if (body.event_type === 'RESIGN') {
      newStatus = 'RESIGNED';
    }

    await db.transaction(async (tx) => {
      await tx.execute(
        `UPDATE employees
         SET hotel_id = ?, department_id = ?, position = ?, status = ?, base_salary = ?, updated_at = ?
         WHERE id = ?`,
        [newHotelId, newDeptId, newPos, newStatus, newSalary, ts, id]
      );

      await tx.execute(
        `INSERT INTO employee_lifecycle_events (
          employee_id, event_type, from_hotel_id, to_hotel_id, from_position, to_position,
          effective_date, reason, operator_id, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [id, body.event_type, emp.hotel_id, newHotelId, emp.position, newPos, body.effective_date, body.reason, req.user!.id, ts]
      );
    });

    const updated = await db.queryOne('SELECT * FROM employees WHERE id = ?', [id]);
    res.json({ employee: updated });
  })
);

export default router;
