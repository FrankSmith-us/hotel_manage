import { Router } from 'express';
import { z } from 'zod';
import { getDb } from '../../db';
import {
  AppError,
  asyncHandler,
  authenticate,
  canAccessHotel,
  getScopeFilter,
  isOwnHotel,
  requireRoles,
} from '../middleware/auth';
import { BUSINESS_RULES } from '../config/businessRules';
import { logApprovalAction } from '../services/auditService';
import { replaceApprovalSteps, resolveApprovalRoute } from '../services/workflowEngine';
import { UserRole } from '../types';
import { addDays, generateCode, getMondayOfCurrentWeek, isoDateSchema, nowIso } from '../utils/numbers';

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

    const publication = await db.queryOne(
      'SELECT * FROM schedule_publications WHERE hotel_id = ? AND week_start = ?',
      [hotelId, weekStart]
    );
    const definitions = await db.query(
      'SELECT * FROM shift_definitions WHERE hotel_id IN (0, ?) AND is_active = 1 ORDER BY hotel_id DESC, id ASC',
      [hotelId]
    );

    res.json({
      hotelId,
      weekStart,
      dates,
      employees,
      shifts,
      publication: publication || { hotel_id: hotelId, week_start: weekStart, status: 'DRAFT' },
      definitions,
    });
  })
);

const assignSchema = z.object({
  override_lock: z.boolean().optional().default(false),
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
        const emp = await tx.queryOne<{
          id: number;
          name: string;
          hotel_id: number;
          health_cert_expiry: string | null;
          dept_category: string | null;
        }>(
          `SELECT e.id, e.name, e.hotel_id, e.health_cert_expiry, d.category AS dept_category
           FROM employees e
           JOIN departments d ON d.id = e.department_id
           WHERE e.id = ?`,
          [item.employee_id]
        );
        if (!emp) throw new AppError(404, `员工 ${item.employee_id} 不存在`);
        if (user.role === 'STORE_MANAGER' && user.employee_id && Number(emp.id) === Number(user.employee_id)) {
          throw new AppError(403, '门店店长禁止为本人排班或加夜班');
        }
        if (!(await canAccessHotel(user, emp.hotel_id))) {
          throw new AppError(403, '无权限调整其他门店员工排班');
        }

        // Check week lock
        const dObj = new Date(`${item.shift_date}T00:00:00Z`);
        const dayIdx = dObj.getUTCDay();
        const mondayDiff = dayIdx === 0 ? -6 : 1 - dayIdx;
        const weekStart = addDays(item.shift_date, mondayDiff);
        const pub = await tx.queryOne<{ status: string }>(
          'SELECT status FROM schedule_publications WHERE hotel_id = ? AND week_start = ?',
          [emp.hotel_id, weekStart]
        );
        if (pub?.status === 'LOCKED' && !(body.override_lock && ['HQ_ADMIN', 'HR_MANAGER'].includes(user.role))) {
          throw new AppError(400, `${weekStart} 所在周排班已锁定，如需修改请联系集团 HR 或管理员解锁`);
        }

        // Check approved leave conflict
        if (item.shift_type !== 'OFF') {
          const leaveConflict = await tx.queryOne<{ id: number; leave_type: string }>(
            `SELECT id, leave_type FROM leave_requests
             WHERE employee_id = ? AND status = 'APPROVED' AND leave_type != 'OVERTIME'
               AND start_date <= ? AND end_date >= ?
             LIMIT 1`,
            [item.employee_id, item.shift_date, item.shift_date]
          );
          if (leaveConflict) {
            throw new AppError(400, `员工 ${emp.name} 在 ${item.shift_date} 已有已审批通过的请假记录，冲突禁止排班`);
          }
        }
        if (
          item.shift_type !== 'OFF' &&
          emp.dept_category &&
          BUSINESS_RULES.healthCert.requiredDeptCategories.includes(emp.dept_category)
        ) {
          if (!emp.health_cert_expiry || emp.health_cert_expiry < item.shift_date) {
            throw new AppError(
              400,
              `员工 ${emp.name} 所属部门(${emp.dept_category})必须持有效健康证方可排班（当前健康证：${emp.health_cert_expiry || '未登记'}）`
            );
          }
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

router.get(
  '/definitions',
  asyncHandler(async (req, res) => {
    const db = getDb();
    const hotelId = req.query.hotelId ? Number(req.query.hotelId) : req.user!.hotel_id || 0;
    const definitions = await db.query(
      'SELECT * FROM shift_definitions WHERE hotel_id IN (0, ?) AND is_active = 1 ORDER BY hotel_id DESC, id ASC',
      [hotelId]
    );
    res.json({ definitions });
  })
);

router.post(
  '/definitions',
  requireRoles('HQ_ADMIN', 'HR_MANAGER', 'REGIONAL_MANAGER', 'STORE_MANAGER'),
  asyncHandler(async (req, res) => {
    const body = z
      .object({
        hotel_id: z.number().int().min(0).default(0),
        code: z.string().trim().min(2).max(32),
        name: z.string().trim().min(1).max(64),
        start_time: z.string().regex(/^\d{2}:\d{2}$/),
        end_time: z.string().regex(/^\d{2}:\d{2}$/),
        work_hours: z.number().min(0).max(24).default(8),
        is_night: z.boolean().default(false),
        allowance_amount: z.number().min(0).max(1000).default(0),
      })
      .parse(req.body);

    if (body.hotel_id > 0 && !(await canAccessHotel(req.user!, body.hotel_id))) {
      throw new AppError(403, '无权为其他门店配置班次');
    }
    const db = getDb();
    const ts = nowIso();
    const existing = await db.queryOne<{ id: number }>(
      'SELECT id FROM shift_definitions WHERE hotel_id = ? AND code = ?',
      [body.hotel_id, body.code]
    );
    if (existing) {
      await db.execute(
        `UPDATE shift_definitions
         SET name = ?, start_time = ?, end_time = ?, work_hours = ?, is_night = ?, allowance_amount = ?, is_active = 1
         WHERE id = ?`,
        [body.name, body.start_time, body.end_time, body.work_hours, body.is_night ? 1 : 0, body.allowance_amount, existing.id]
      );
    } else {
      await db.execute(
        `INSERT INTO shift_definitions (
          hotel_id, code, name, start_time, end_time, work_hours, is_night, allowance_amount, is_active, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1, ?)`,
        [body.hotel_id, body.code, body.name, body.start_time, body.end_time, body.work_hours, body.is_night ? 1 : 0, body.allowance_amount, ts]
      );
    }
    const def = await db.queryOne('SELECT * FROM shift_definitions WHERE hotel_id = ? AND code = ?', [
      body.hotel_id,
      body.code,
    ]);
    res.status(201).json({ definition: def });
  })
);

router.post(
  '/publish',
  requireRoles('HQ_ADMIN', 'HR_MANAGER', 'REGIONAL_MANAGER', 'STORE_MANAGER'),
  asyncHandler(async (req, res) => {
    const body = z
      .object({
        hotel_id: z.number().int().positive(),
        week_start: isoDateSchema,
        action: z.enum(['PUBLISH', 'LOCK', 'UNLOCK']),
      })
      .parse(req.body);

    const user = req.user!;
    if (!(await canAccessHotel(user, body.hotel_id))) {
      throw new AppError(403, '无权操作其他门店排班发布状态');
    }
    if (body.action === 'UNLOCK' && !['HQ_ADMIN', 'HR_MANAGER'].includes(user.role)) {
      throw new AppError(403, '仅集团管理员或 HR 总监可解锁已锁定排班');
    }

    const db = getDb();
    const ts = nowIso();
    const nextStatus = body.action === 'LOCK' ? 'LOCKED' : 'PUBLISHED';
    const existing = await db.queryOne<{ id: number }>(
      'SELECT id FROM schedule_publications WHERE hotel_id = ? AND week_start = ?',
      [body.hotel_id, body.week_start]
    );
    if (existing) {
      await db.execute(
        `UPDATE schedule_publications
         SET status = ?,
             published_by = COALESCE(published_by, ?),
             published_at = COALESCE(published_at, ?),
             locked_by = CASE WHEN ? = 'LOCKED' THEN ? ELSE NULL END,
             locked_at = CASE WHEN ? = 'LOCKED' THEN ? ELSE NULL END
         WHERE id = ?`,
        [nextStatus, user.id, ts, nextStatus, user.id, nextStatus, ts, existing.id]
      );
    } else {
      await db.execute(
        `INSERT INTO schedule_publications (
          hotel_id, week_start, status, published_by, published_at, locked_by, locked_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?)`,
        [
          body.hotel_id,
          body.week_start,
          nextStatus,
          user.id,
          ts,
          nextStatus === 'LOCKED' ? user.id : null,
          nextStatus === 'LOCKED' ? ts : null,
        ]
      );
    }

    const publication = await db.queryOne(
      'SELECT * FROM schedule_publications WHERE hotel_id = ? AND week_start = ?',
      [body.hotel_id, body.week_start]
    );
    res.json({ publication });
  })
);

router.get(
  '/swaps',
  asyncHandler(async (req, res) => {
    const db = getDb();
    const user = req.user!;
    const scope = await getScopeFilter(user);
    const cond = ['1=1'];
    const params: unknown[] = [];

    if (scope.type === 'SELF') {
      cond.push('(s.requester_emp_id = ? OR s.target_emp_id = ?)');
      params.push(scope.employeeId ?? -1, scope.employeeId ?? -1);
    } else if (scope.type === 'HOTEL') {
      cond.push('s.hotel_id = ?');
      params.push(scope.hotelId);
    } else if (scope.type === 'REGION') {
      if (scope.hotelIds.length === 0) {
        res.json({ swaps: [] });
        return;
      }
      cond.push(`s.hotel_id IN (${scope.hotelIds.map(() => '?').join(',')})`);
      params.push(...scope.hotelIds);
    }

    const swaps = await db.query(
      `SELECT s.*, re.name AS requester_name, te.name AS target_name, h.name AS hotel_name
       FROM shift_swap_requests s
       JOIN employees re ON re.id = s.requester_emp_id
       JOIN employees te ON te.id = s.target_emp_id
       JOIN hotels h ON h.id = s.hotel_id
       WHERE ${cond.join(' AND ')}
       ORDER BY s.id DESC`,
      params
    );
    res.json({ swaps });
  })
);

router.post(
  '/swaps',
  asyncHandler(async (req, res) => {
    const body = z
      .object({
        requester_shift_date: isoDateSchema,
        target_emp_id: z.number().int().positive(),
        target_shift_date: isoDateSchema,
        reason: z.string().trim().min(2, '请填写换班原因'),
      })
      .parse(req.body);

    const user = req.user!;
    if (!user.employee_id) throw new AppError(400, '当前账号未关联员工档案');
    if (Number(user.employee_id) === Number(body.target_emp_id)) {
      throw new AppError(400, '不能与本人发起换班');
    }

    const db = getDb();
    const reqEmp = await db.queryOne<{ id: number; hotel_id: number; name: string }>(
      'SELECT id, hotel_id, name FROM employees WHERE id = ?',
      [user.employee_id]
    );
    const tgtEmp = await db.queryOne<{ id: number; hotel_id: number; name: string }>(
      'SELECT id, hotel_id, name FROM employees WHERE id = ?',
      [body.target_emp_id]
    );
    if (!reqEmp || !tgtEmp) throw new AppError(404, '员工不存在');
    if (Number(reqEmp.hotel_id) !== Number(tgtEmp.hotel_id)) {
      throw new AppError(400, '仅支持同门店员工之间申请换班');
    }

    const ts = nowIso();
    const requestNo = generateCode('SWP');
    const ins = await db.execute(
      `INSERT INTO shift_swap_requests (
        request_no, hotel_id, requester_emp_id, target_emp_id, requester_shift_date,
        target_shift_date, reason, status, current_step, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, 'PENDING_TARGET', 1, ?, ?)`,
      [
        requestNo,
        reqEmp.hotel_id,
        reqEmp.id,
        tgtEmp.id,
        body.requester_shift_date,
        body.target_shift_date,
        body.reason,
        ts,
        ts,
      ]
    );
    const swap = await db.queryOne('SELECT * FROM shift_swap_requests WHERE id = ?', [ins.insertId]);
    res.status(201).json({ swap });
  })
);

router.post(
  '/swaps/:id/respond',
  asyncHandler(async (req, res) => {
    const id = Number(req.params.id);
    const { accept } = z.object({ accept: z.boolean() }).parse(req.body);
    const user = req.user!;
    const db = getDb();
    const ts = nowIso();

    await db.transaction(async (tx) => {
      const swap = await tx.queryOne<{
        id: number;
        hotel_id: number;
        target_emp_id: number;
        status: string;
      }>(`SELECT id, hotel_id, target_emp_id, status FROM shift_swap_requests WHERE id = ?${tx.forUpdateSuffix()}`, [id]);
      if (!swap) throw new AppError(404, '换班申请不存在');
      if (Number(user.employee_id) !== Number(swap.target_emp_id)) {
        throw new AppError(403, '仅被换班同事本人可确认换班请求');
      }
      if (swap.status !== 'PENDING_TARGET') {
        throw new AppError(400, '当前换班单状态不可操作');
      }

      if (!accept) {
        await tx.execute(`UPDATE shift_swap_requests SET status = 'REJECTED', updated_at = ? WHERE id = ?`, [ts, id]);
      } else {
        await tx.execute(`UPDATE shift_swap_requests SET status = 'PENDING_APPROVAL', updated_at = ? WHERE id = ?`, [
          ts,
          id,
        ]);
        const resolved = await resolveApprovalRoute(tx, swap.hotel_id, [
          { stepOrder: 1, stepName: '门店店长审批', approverRole: 'STORE_MANAGER' as UserRole },
        ]);
        await replaceApprovalSteps(tx, 'SHIFT_SWAP', id, resolved.steps);
      }
    });

    res.json({ ok: true });
  })
);

router.post(
  '/swaps/:id/approve',
  requireRoles('HQ_ADMIN', 'HR_MANAGER', 'REGIONAL_MANAGER', 'STORE_MANAGER'),
  asyncHandler(async (req, res) => {
    const id = Number(req.params.id);
    const { action, comment } = z
      .object({
        action: z.enum(['APPROVE', 'REJECT']),
        comment: z.string().optional().default(''),
      })
      .parse(req.body);

    const db = getDb();
    const user = req.user!;
    const ts = nowIso();

    await db.transaction(async (tx) => {
      const swap = await tx.queryOne<{
        id: number;
        hotel_id: number;
        requester_emp_id: number;
        target_emp_id: number;
        requester_shift_date: string;
        target_shift_date: string;
        status: string;
      }>(`SELECT * FROM shift_swap_requests WHERE id = ?${tx.forUpdateSuffix()}`, [id]);
      if (!swap) throw new AppError(404, '换班申请不存在');
      if (!(await canAccessHotel(user, swap.hotel_id))) {
        throw new AppError(403, '无权审批其他门店换班申请');
      }
      if (swap.status !== 'PENDING_APPROVAL') {
        throw new AppError(400, '当前换班单状态不可审批');
      }

      if (action === 'REJECT') {
        await tx.execute(`UPDATE shift_swap_requests SET status = 'REJECTED', updated_at = ? WHERE id = ?`, [ts, id]);
      } else {
        const s1 = await tx.queryOne<{ id: number; shift_type: string }>(
          'SELECT id, shift_type FROM shift_schedules WHERE employee_id = ? AND shift_date = ?',
          [swap.requester_emp_id, swap.requester_shift_date]
        );
        const s2 = await tx.queryOne<{ id: number; shift_type: string }>(
          'SELECT id, shift_type FROM shift_schedules WHERE employee_id = ? AND shift_date = ?',
          [swap.target_emp_id, swap.target_shift_date]
        );
        if (!s1 || !s2) {
          throw new AppError(400, '双方对应日期必须均已排班才可互换');
        }
        await tx.execute('UPDATE shift_schedules SET shift_type = ?, updated_at = ? WHERE id = ?', [
          s2.shift_type,
          ts,
          s1.id,
        ]);
        await tx.execute('UPDATE shift_schedules SET shift_type = ?, updated_at = ? WHERE id = ?', [
          s1.shift_type,
          ts,
          s2.id,
        ]);
        await tx.execute(`UPDATE shift_swap_requests SET status = 'APPROVED', updated_at = ? WHERE id = ?`, [ts, id]);
      }

      await logApprovalAction(tx, {
        bizType: 'SHIFT_SWAP',
        bizId: id,
        action,
        actor: user,
        comment: comment || (action === 'APPROVE' ? '同意换班并互换班次' : '驳回换班'),
      });
    });

    res.json({ ok: true });
  })
);

export default router;
