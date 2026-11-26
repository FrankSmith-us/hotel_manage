import { Router } from 'express';
import { z } from 'zod';
import { getDb } from '../../db';
import {
  AppError,
  asyncHandler,
  authenticate,
  canAccessHotel,
  isOwnHotel,
  requireRoles,
} from '../middleware/auth';
import { addDays, getMondayOfCurrentWeek, isoDateSchema, nowIso } from '../utils/numbers';

const router = Router();
router.use(authenticate);

router.get(
  '/',
  asyncHandler(async (req, res) => {
    const db = getDb();
    let hotelId = req.query.hotelId ? Number(req.query.hotelId) : req.user!.hotel_id;
    if (!hotelId) {
      const firstHotel = await db.queryOne<{ id: number }>(
        'SELECT id FROM hotels ORDER BY is_hq ASC, id ASC LIMIT 1'
      );
      hotelId = firstHotel?.id ?? 0;
    }
    if (!hotelId || (!(await canAccessHotel(req.user!, hotelId)) && !isOwnHotel(req.user!, hotelId))) {
      throw new AppError(403, '无权限查看其他门店排班表');
    }

    const weekStart = String(req.query.weekStart || getMondayOfCurrentWeek());
    const dates = Array.from({ length: 7 }, (_, i) => addDays(weekStart, i));
    const weekEnd = dates[6];

    const employees = await db.query<{
      id: number;
      emp_no: string;
      name: string;
      position: string;
      department_name: string;
      hotel_id: number;
    }>(
      `SELECT e.id, e.emp_no, e.name, e.position, d.name AS department_name, e.hotel_id
       FROM employees e
       JOIN departments d ON d.id = e.department_id
       WHERE e.hotel_id = ? AND e.status IN ('ACTIVE', 'PROBATION')
       ORDER BY e.id ASC`,
      [hotelId]
    );

    const shifts = await db.query<{
      id: number;
      employee_id: number;
      home_hotel_id: number;
      assigned_hotel_id: number;
      assigned_hotel_name: string;
      home_hotel_name: string;
      emp_name: string;
      emp_no: string;
      position: string;
      shift_date: string;
      shift_type: string;
      is_cross_store: number;
      notes: string | null;
    }>(
      `SELECT s.*, ah.name AS assigned_hotel_name, hh.name AS home_hotel_name,
              e.name AS emp_name, e.emp_no, e.position
       FROM shift_schedules s
       JOIN hotels ah ON ah.id = s.assigned_hotel_id
       JOIN hotels hh ON hh.id = s.home_hotel_id
       JOIN employees e ON e.id = s.employee_id
       WHERE s.shift_date >= ? AND s.shift_date <= ?
         AND (s.home_hotel_id = ? OR s.assigned_hotel_id = ?)`,
      [weekStart, weekEnd, hotelId, hotelId]
    );

    res.json({ hotelId, weekStart, dates, employees, shifts });
  })
);

const assignSchema = z.object({
  assignments: z
    .array(
      z.object({
        employee_id: z.number().int().positive(),
        shift_date: isoDateSchema,
        shift_type: z.enum(['MORNING', 'AFTERNOON', 'EVENING', 'NIGHT', 'OFF']),
        assigned_hotel_id: z.number().int().positive().optional(),
        notes: z.string().optional().nullable(),
      })
    )
    .min(1),
});

router.put(
  '/assign',
  requireRoles('HQ_ADMIN', 'HR_MANAGER', 'REGIONAL_MANAGER', 'STORE_MANAGER'),
  asyncHandler(async (req, res) => {
    const body = assignSchema.parse(req.body);
    const db = getDb();
    const user = req.user!;
    const ts = nowIso();

    await db.transaction(async (tx) => {
      for (const item of body.assignments) {
        const emp = await tx.queryOne<{ id: number; hotel_id: number }>(
          'SELECT id, hotel_id FROM employees WHERE id = ?',
          [item.employee_id]
        );
        if (!emp) throw new AppError(404, `员工 ${item.employee_id} 不存在`);
        if (user.role === 'STORE_MANAGER' && user.employee_id && Number(emp.id) === Number(user.employee_id)) {
          throw new AppError(403, '门店店长禁止为本人排班或加夜班');
        }
        if (!(await canAccessHotel(user, emp.hotel_id))) {
          throw new AppError(403, '无权限调整其他门店员工排班');
        }

        const assignedHotelId = item.assigned_hotel_id ?? emp.hotel_id;
        const isCrossStore = assignedHotelId !== emp.hotel_id ? 1 : 0;
        if (isCrossStore) {
          const targetHotel = await tx.queryOne<{ id: number; region_id: number; status: string }>(
            'SELECT id, region_id, status FROM hotels WHERE id = ?',
            [assignedHotelId]
          );
          if (!targetHotel || !['OPEN', 'SOFT_OPENING', 'ACTIVE'].includes(targetHotel.status)) {
            throw new AppError(400, '跨店支援的目标门店不存在或未处于营业/试营业状态');
          }
          if (user.role === 'REGIONAL_MANAGER' && !(await canAccessHotel(user, assignedHotelId))) {
            throw new AppError(403, '区域经理仅可调派至本大区内的门店');
          }
          if (user.role === 'STORE_MANAGER' && user.region_id && Number(targetHotel.region_id) !== Number(user.region_id)) {
            throw new AppError(403, '门店店长仅可向同大区门店发起跨店支援排班');
          }
        }

        const existing = await tx.queryOne<{ id: number }>(
          'SELECT id FROM shift_schedules WHERE employee_id = ? AND shift_date = ?',
          [item.employee_id, item.shift_date]
        );

        if (existing) {
          await tx.execute(
            `UPDATE shift_schedules
             SET assigned_hotel_id = ?, shift_type = ?, is_cross_store = ?, notes = ?, updated_at = ?
             WHERE id = ?`,
            [assignedHotelId, item.shift_type, isCrossStore, item.notes ?? null, ts, existing.id]
          );
        } else {
          await tx.execute(
            `INSERT INTO shift_schedules (
              employee_id, home_hotel_id, assigned_hotel_id, shift_date, shift_type,
              is_cross_store, notes, created_by, created_at, updated_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
            [
              item.employee_id,
              emp.hotel_id,
              assignedHotelId,
              item.shift_date,
              item.shift_type,
              isCrossStore,
              item.notes ?? null,
              req.user!.id,
              ts,
              ts,
            ]
          );
        }
      }
    });

    res.json({ ok: true, count: body.assignments.length });
  })
);

export default router;
