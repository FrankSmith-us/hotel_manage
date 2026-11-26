import { Router } from 'express';
import { z } from 'zod';
import { getDb } from '../../db';
import {
  AppError,
  asyncHandler,
  authenticate,
  canAccessHotel,
  requireRoles,
} from '../middleware/auth';
import { addDays, getMondayOfCurrentWeek, nowIso } from '../utils/numbers';

const router = Router();
router.use(authenticate);

router.get(
  '/',
  asyncHandler(async (req, res) => {
    const db = getDb();
    const hotelId = Number(req.query.hotelId || req.user!.hotel_id || 2);
    if (!(await canAccessHotel(req.user!, hotelId))) {
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
        shift_date: z.string().min(8),
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
    const ts = nowIso();

    await db.transaction(async (tx) => {
      for (const item of body.assignments) {
        const emp = await tx.queryOne<{ id: number; hotel_id: number }>(
          'SELECT id, hotel_id FROM employees WHERE id = ?',
          [item.employee_id]
        );
        if (!emp) throw new AppError(404, `员工 ${item.employee_id} 不存在`);
        if (!(await canAccessHotel(req.user!, emp.hotel_id))) {
          throw new AppError(403, '无权限调整其他门店员工排班');
        }

        const assignedHotelId = item.assigned_hotel_id ?? emp.hotel_id;
        const isCrossStore = assignedHotelId !== emp.hotel_id ? 1 : 0;

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
