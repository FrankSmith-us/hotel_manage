import path from 'node:path';
import bcrypt from 'bcryptjs';
import dotenv from 'dotenv';
import { DbAdapter } from './adapter';
import { createDbAdapterFromEnv } from './index';
import { initSchema } from './init';
import {
  addDays,
  currentYearMonth,
  getMondayOfCurrentWeek,
  nowIso,
  offsetYearMonth,
  roundMoney,
  todayStr,
} from '../src/utils/numbers';
import { calculateMonthlyPayroll } from '../src/services/payrollService';
import {
  buildCashAdvanceRoute,
  buildHeadcountRoute,
  buildLeaveRoute,
  buildReimbursementRoute,
  replaceApprovalSteps,
  resolveApprovalRoute,
} from '../src/services/workflowEngine';
import { UserRole } from '../src/types';

dotenv.config({ path: path.resolve(__dirname, '../../.env') });

export async function seedDatabase(db: DbAdapter, options: { reset?: boolean } = {}): Promise<void> {
  const existingRegions = await db.queryOne<{ cnt: number }>('SELECT COUNT(*) AS cnt FROM regions');
  if (!options.reset && existingRegions && Number(existingRegions.cnt) > 0) {
    console.log('[db:seed] Database already seeded. Pass --reset to re-seed.');
    return;
  }

  if (options.reset) {
    const tables = [
      'payee_accounts',
      'approval_logs',
      'approval_steps',
      'reimbursement_items',
      'reimbursements',
      'cash_advances',
      'store_budgets',
      'candidates',
      'headcount_requests',
      'payroll_records',
      'leave_requests',
      'shift_schedules',
      'employee_lifecycle_events',
      'users',
      'employees',
      'departments',
      'hotels',
      'regions',
    ];
    for (const t of tables) {
      await db.execute(`DELETE FROM ${t}`);
    }
  }

  const ts = nowIso();
  const today = todayStr();
  const curYm = currentYearMonth();
  const prevYm = offsetYearMonth(curYm, -1);
  const nextYm = offsetYearMonth(curYm, 1);
  const monday = getMondayOfCurrentWeek();
  const passwordHash = bcrypt.hashSync('Hotel@2026', 8);

  await db.transaction(async (tx) => {
    // 1. Regions
    const regionIds: Record<string, number> = {};
    for (const r of [
      { code: 'HQ', name: '集团总部' },
      { code: 'EAST', name: '华东大区' },
      { code: 'NORTH', name: '华北大区' },
      { code: 'SOUTH', name: '华南大区' },
    ]) {
      const res = await tx.execute('INSERT INTO regions (code, name, created_at) VALUES (?, ?, ?)', [
        r.code,
        r.name,
        ts,
      ]);
      regionIds[r.code] = res.insertId;
    }

    // 2. Hotels
    const hotelIds: Record<string, number> = {};
    const hotelDefs = [
      {
        code: 'HQ-001',
        name: '悦栖酒店管理集团总部',
        region: 'HQ',
        city: '上海',
        address: '上海市静安区南京西路1266号恒隆广场2期',
        phone: '021-60008800',
        room_count: 0,
        is_hq: 1,
        opened_at: '2021-01-01',
      },
      {
        code: 'SH-JA',
        name: '上海静安旗舰店',
        region: 'EAST',
        city: '上海',
        address: '上海市静安区愚园路288号',
        phone: '021-62119900',
        room_count: 180,
        is_hq: 0,
        opened_at: '2022-05-18',
      },
      {
        code: 'HZ-XH',
        name: '杭州西湖精品店',
        region: 'EAST',
        city: '杭州',
        address: '杭州市西湖区曙光路120号',
        phone: '0571-87996600',
        room_count: 120,
        is_hq: 0,
        opened_at: '2023-03-10',
      },
      {
        code: 'BJ-GM',
        name: '北京国贸商务店',
        region: 'NORTH',
        city: '北京',
        address: '北京市朝阳区建国门外大街甲6号',
        phone: '010-65667700',
        room_count: 150,
        is_hq: 0,
        opened_at: '2023-08-01',
      },
      {
        code: 'SZ-NS',
        name: '深圳南山智选店',
        region: 'SOUTH',
        city: '深圳',
        address: '深圳市南山区高新南一道18号',
        phone: '0755-26668800',
        room_count: 135,
        is_hq: 0,
        opened_at: '2024-04-12',
      },
    ];
    for (const h of hotelDefs) {
      const res = await tx.execute(
        `INSERT INTO hotels (code, name, region_id, city, address, phone, room_count, is_hq, status, opened_at, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'ACTIVE', ?, ?)`,
        [h.code, h.name, regionIds[h.region], h.city, h.address, h.phone, h.room_count, h.is_hq, h.opened_at, ts]
      );
      hotelIds[h.code] = res.insertId;
    }

    // 3. Departments
    const deptIds: Record<string, number> = {};
    const branchDepts = [
      { code: 'FO', name: '前厅部', category: 'FRONT_OFFICE' },
      { code: 'HK', name: '客房部', category: 'HOUSEKEEPING' },
      { code: 'ENG', name: '工程维保部', category: 'ENGINEERING' },
      { code: 'FB', name: '餐饮部', category: 'FB' },
      { code: 'ADM', name: '门店综合管理部', category: 'ADMIN' },
    ];
    const hqDepts = [
      { code: 'EXEC', name: '总经办', category: 'ADMIN' },
      { code: 'HR', name: '人力资源中心', category: 'ADMIN' },
      { code: 'FIN', name: '财务管理中心', category: 'ADMIN' },
      { code: 'OPS', name: '运营督导中心', category: 'ADMIN' },
    ];

    for (const d of hqDepts) {
      const res = await tx.execute(
        'INSERT INTO departments (hotel_id, code, name, category, created_at) VALUES (?, ?, ?, ?, ?)',
        [hotelIds['HQ-001'], d.code, d.name, d.category, ts]
      );
      deptIds[`HQ-001:${d.code}`] = res.insertId;
    }

    for (const hCode of ['SH-JA', 'HZ-XH', 'BJ-GM', 'SZ-NS']) {
      for (const d of branchDepts) {
        const res = await tx.execute(
          'INSERT INTO departments (hotel_id, code, name, category, created_at) VALUES (?, ?, ?, ?, ?)',
          [hotelIds[hCode], d.code, d.name, d.category, ts]
        );
        deptIds[`${hCode}:${d.code}`] = res.insertId;
      }
    }

    // 4. Employees (16 realistic employees across HQ + 4 branches)
    const empIds: Record<string, number> = {};
    const empDefs = [
      {
        emp_no: 'YQ-0001',
        name: '周志远',
        gender: 'M',
        phone: '13800100001',
        email: 'zhou.zy@yueqi.cn',
        hotel: 'HQ-001',
        dept: 'EXEC',
        position: '集团总经理',
        status: 'ACTIVE',
        hire_date: '2021-01-05',
        contract_end_date: addDays(today, 700),
        health_cert_expiry: null,
        base_salary: 32000,
        bank_name: '招商银行上海分行',
        bank_account: '6225880100001001',
      },
      {
        emp_no: 'YQ-0002',
        name: '林婉清',
        gender: 'F',
        phone: '13800100002',
        email: 'lin.wq@yueqi.cn',
        hotel: 'HQ-001',
        dept: 'HR',
        position: '集团HR总监',
        status: 'ACTIVE',
        hire_date: '2021-03-15',
        contract_end_date: addDays(today, 520),
        health_cert_expiry: null,
        base_salary: 22000,
        bank_name: '招商银行上海分行',
        bank_account: '6225880100001002',
      },
      {
        emp_no: 'YQ-0003',
        name: '陈明哲',
        gender: 'M',
        phone: '13800100003',
        email: 'chen.mz@yueqi.cn',
        hotel: 'HQ-001',
        dept: 'FIN',
        position: '集团财务经理',
        status: 'ACTIVE',
        hire_date: '2021-06-01',
        contract_end_date: addDays(today, 480),
        health_cert_expiry: null,
        base_salary: 21000,
        bank_name: '工商银行上海静安支行',
        bank_account: '6222021000001003',
      },
      {
        emp_no: 'YQ-0004',
        name: '王海峰',
        gender: 'M',
        phone: '13800100004',
        email: 'wang.hf@yueqi.cn',
        hotel: 'HQ-001',
        dept: 'OPS',
        position: '华东区区域经理',
        status: 'ACTIVE',
        hire_date: '2022-02-10',
        contract_end_date: addDays(today, 300),
        health_cert_expiry: addDays(today, 180),
        base_salary: 19500,
        bank_name: '招商银行上海分行',
        bank_account: '6225880100001004',
      },
      {
        emp_no: 'YQ-0005',
        name: '张景行',
        gender: 'M',
        phone: '13800100005',
        email: 'zhang.jx@yueqi.cn',
        hotel: 'HQ-001',
        dept: 'OPS',
        position: '集团系统管理员',
        status: 'ACTIVE',
        hire_date: '2021-01-10',
        contract_end_date: addDays(today, 600),
        health_cert_expiry: null,
        base_salary: 16000,
        bank_name: '招商银行上海分行',
        bank_account: '6225880100001005',
      },
      // 上海静安旗舰店
      {
        emp_no: 'YQ-1001',
        name: '沈佳妮',
        gender: 'F',
        phone: '13916001001',
        email: 'shen.jn@yueqi.cn',
        hotel: 'SH-JA',
        dept: 'ADM',
        position: '门店店长',
        status: 'ACTIVE',
        hire_date: '2022-05-01',
        contract_end_date: addDays(today, 22), // 合同即将到期预警
        health_cert_no: 'SHJK-2026-1001',
        health_cert_expiry: addDays(today, 120),
        base_salary: 15500,
        bank_name: '建设银行静安支行',
        bank_account: '6217001200001001',
      },
      {
        emp_no: 'YQ-1002',
        name: '陆子轩',
        gender: 'M',
        phone: '13916001002',
        email: 'lu.zx@yueqi.cn',
        hotel: 'SH-JA',
        dept: 'FO',
        position: '前厅主管',
        status: 'ACTIVE',
        hire_date: '2023-04-10',
        contract_end_date: addDays(today, 240),
        health_cert_no: 'SHJK-2026-1002',
        health_cert_expiry: addDays(today, 14), // 健康证14天内到期预警
        base_salary: 8800,
        bank_name: '招商银行静安支行',
        bank_account: '6225880100002002',
      },
      {
        emp_no: 'YQ-1003',
        name: '赵小燕',
        gender: 'F',
        phone: '13916001003',
        email: 'zhao.xy@yueqi.cn',
        hotel: 'SH-JA',
        dept: 'HK',
        position: '客房领班',
        status: 'ACTIVE',
        hire_date: '2022-09-18',
        contract_end_date: addDays(today, 380),
        health_cert_no: 'SHJK-2026-1003',
        health_cert_expiry: addDays(today, 95),
        base_salary: 7200,
        bank_name: '工商银行静安支行',
        bank_account: '6222021000002003',
      },
      {
        emp_no: 'YQ-1004',
        name: '孙伟强',
        gender: 'M',
        phone: '13916001004',
        email: 'sun.wq@yueqi.cn',
        hotel: 'SH-JA',
        dept: 'ENG',
        position: '工程维修技师',
        status: 'ACTIVE',
        hire_date: '2023-11-01',
        contract_end_date: addDays(today, 190),
        health_cert_no: 'SHJK-2026-1004',
        health_cert_expiry: addDays(today, 210),
        base_salary: 7800,
        bank_name: '农业银行上海分行',
        bank_account: '6228480000002004',
      },
      {
        emp_no: 'YQ-1005',
        name: '吴婷婷',
        gender: 'F',
        phone: '13916001005',
        email: 'wu.tt@yueqi.cn',
        hotel: 'SH-JA',
        dept: 'FB',
        position: '早餐厅厨师长',
        status: 'PROBATION',
        hire_date: addDays(today, -35),
        probation_end_date: addDays(today, 55),
        contract_end_date: addDays(today, 695),
        health_cert_no: 'SHJK-2025-1005',
        health_cert_expiry: addDays(today, -3), // 已过期3天健康证预警
        base_salary: 9200,
        bank_name: '招商银行上海分行',
        bank_account: '6225880100002005',
      },
      // 杭州西湖精品店
      {
        emp_no: 'YQ-2001',
        name: '顾文博',
        gender: 'M',
        phone: '13757102001',
        email: 'gu.wb@yueqi.cn',
        hotel: 'HZ-XH',
        dept: 'ADM',
        position: '门店店长',
        status: 'ACTIVE',
        hire_date: '2023-02-15',
        contract_end_date: addDays(today, 310),
        health_cert_no: 'HZJK-2026-2001',
        health_cert_expiry: addDays(today, 160),
        base_salary: 14500,
        bank_name: '杭州银行西湖支行',
        bank_account: '6230520000002001',
      },
      {
        emp_no: 'YQ-2002',
        name: '方思琪',
        gender: 'F',
        phone: '13757102002',
        email: 'fang.sq@yueqi.cn',
        hotel: 'HZ-XH',
        dept: 'FO',
        position: '夜审前台专员',
        status: 'ACTIVE',
        hire_date: '2024-01-08',
        contract_end_date: addDays(today, 400),
        health_cert_no: 'HZJK-2026-2002',
        health_cert_expiry: addDays(today, 19), // 健康证预警
        base_salary: 6500,
        bank_name: '工商银行杭州分行',
        bank_account: '6222021200002002',
      },
      // 北京国贸商务店
      {
        emp_no: 'YQ-3001',
        name: '高建国',
        gender: 'M',
        phone: '13601103001',
        email: 'gao.jg@yueqi.cn',
        hotel: 'BJ-GM',
        dept: 'ADM',
        position: '门店店长',
        status: 'ACTIVE',
        hire_date: '2023-07-01',
        contract_end_date: addDays(today, 280),
        health_cert_no: 'BJJK-2026-3001',
        health_cert_expiry: addDays(today, 145),
        base_salary: 16200,
        bank_name: '招商银行北京国贸支行',
        bank_account: '6225880200003001',
      },
      {
        emp_no: 'YQ-3002',
        name: '刘思雨',
        gender: 'F',
        phone: '13601103002',
        email: 'liu.sy@yueqi.cn',
        hotel: 'BJ-GM',
        dept: 'FO',
        position: '前台接待专员',
        status: 'ACTIVE',
        hire_date: '2024-03-20',
        contract_end_date: addDays(today, 18), // 合同即将到期预警
        health_cert_no: 'BJJK-2026-3002',
        health_cert_expiry: addDays(today, 220),
        base_salary: 7000,
        bank_name: '建设银行北京分行',
        bank_account: '6217000100003002',
      },
      {
        emp_no: 'YQ-3003',
        name: '马志鹏',
        gender: 'M',
        phone: '13601103003',
        email: 'ma.zp@yueqi.cn',
        hotel: 'BJ-GM',
        dept: 'ENG',
        position: '暖通维保主管',
        status: 'ACTIVE',
        hire_date: '2023-09-12',
        contract_end_date: addDays(today, 340),
        health_cert_no: 'BJJK-2026-3003',
        health_cert_expiry: addDays(today, 110),
        base_salary: 9500,
        bank_name: '工商银行北京朝阳支行',
        bank_account: '6222020200003003',
      },
      // 深圳南山智选店
      {
        emp_no: 'YQ-4001',
        name: '陈晓东',
        gender: 'M',
        phone: '13510004001',
        email: 'chen.xd@yueqi.cn',
        hotel: 'SZ-NS',
        dept: 'ADM',
        position: '门店店长',
        status: 'ACTIVE',
        hire_date: '2024-04-01',
        contract_end_date: addDays(today, 500),
        health_cert_no: 'SZJK-2026-4001',
        health_cert_expiry: addDays(today, 200),
        base_salary: 15000,
        bank_name: '招商银行深圳南山支行',
        bank_account: '6225880700004001',
      },
    ];

    for (const e of empDefs) {
      const res = await tx.execute(
        `INSERT INTO employees (
          emp_no, name, gender, phone, email, id_card_last4, hotel_id, department_id,
          position, employment_type, status, hire_date, probation_end_date, contract_end_date,
          health_cert_no, health_cert_expiry, base_salary, night_allowance_rate,
          bank_name, bank_account, emergency_contact, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'FULL_TIME', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          e.emp_no,
          e.name,
          e.gender,
          e.phone,
          e.email,
          e.emp_no.slice(-4),
          hotelIds[e.hotel],
          deptIds[`${e.hotel}:${e.dept}`],
          e.position,
          e.status,
          e.hire_date,
          e.probation_end_date ?? null,
          e.contract_end_date,
          e.health_cert_no ?? null,
          e.health_cert_expiry ?? null,
          e.base_salary,
          80,
          e.bank_name,
          e.bank_account,
          `${e.name}家属 13800009999`,
          ts,
          ts,
        ]
      );
      empIds[e.emp_no] = res.insertId;
    }

    // 5. Demo Users
    const userIds: Record<string, number> = {};
    const userDefs: Array<{
      username: string;
      empNo: string;
      display_name: string;
      role: UserRole;
      hotel: string;
      region: string;
    }> = [
      { username: 'admin', empNo: 'YQ-0005', display_name: '张景行', role: 'HQ_ADMIN', hotel: 'HQ-001', region: 'HQ' },
      { username: 'gm', empNo: 'YQ-0001', display_name: '周志远', role: 'GENERAL_MANAGER', hotel: 'HQ-001', region: 'HQ' },
      { username: 'hr', empNo: 'YQ-0002', display_name: '林婉清', role: 'HR_MANAGER', hotel: 'HQ-001', region: 'HQ' },
      { username: 'finance', empNo: 'YQ-0003', display_name: '陈明哲', role: 'FINANCE', hotel: 'HQ-001', region: 'HQ' },
      { username: 'region_east', empNo: 'YQ-0004', display_name: '王海峰', role: 'REGIONAL_MANAGER', hotel: 'HQ-001', region: 'EAST' },
      { username: 'mgr_sh', empNo: 'YQ-1001', display_name: '沈佳妮', role: 'STORE_MANAGER', hotel: 'SH-JA', region: 'EAST' },
      { username: 'mgr_bj', empNo: 'YQ-3001', display_name: '高建国', role: 'STORE_MANAGER', hotel: 'BJ-GM', region: 'NORTH' },
      { username: 'staff_sh', empNo: 'YQ-1002', display_name: '陆子轩', role: 'STAFF', hotel: 'SH-JA', region: 'EAST' },
    ];

    for (const u of userDefs) {
      const res = await tx.execute(
        `INSERT INTO users (username, password_hash, display_name, role, employee_id, hotel_id, region_id, is_active, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, 1, ?)`,
        [u.username, passwordHash, u.display_name, u.role, empIds[u.empNo], hotelIds[u.hotel], regionIds[u.region], ts]
      );
      userIds[u.username] = res.insertId;
    }

    // Assign region managers: EAST has dedicated region_east; NORTH, SOUTH, HQ are concurrently managed by GM
    await tx.execute('UPDATE regions SET manager_user_id = ? WHERE id = ?', [userIds['region_east'], regionIds['EAST']]);
    await tx.execute('UPDATE regions SET manager_user_id = ? WHERE id IN (?, ?, ?)', [
      userIds['gm'],
      regionIds['NORTH'],
      regionIds['SOUTH'],
      regionIds['HQ'],
    ]);

    // 6. Lifecycle events
    await tx.execute(
      `INSERT INTO employee_lifecycle_events (employee_id, event_type, from_hotel_id, to_hotel_id, from_position, to_position, effective_date, reason, operator_id, created_at)
       VALUES (?, 'ONBOARD', NULL, ?, NULL, '前厅主管', '2023-04-10', '社会招聘入职上海静安旗舰店', ?, ?)`,
      [empIds['YQ-1002'], hotelIds['SH-JA'], userIds['hr'], ts]
    );
    await tx.execute(
      `INSERT INTO employee_lifecycle_events (employee_id, event_type, from_hotel_id, to_hotel_id, from_position, to_position, effective_date, reason, operator_id, created_at)
       VALUES (?, 'TRANSFER', ?, ?, '前台领班', '前厅主管', '2024-06-01', '华东区域内部晋升调动至静安旗舰店', ?, ?)`,
      [empIds['YQ-1002'], hotelIds['HZ-XH'], hotelIds['SH-JA'], userIds['hr'], ts]
    );

    // 7. Weekly Shift Schedules (current week Mon-Sun)
    const shShiftEmps = ['YQ-1002', 'YQ-1003', 'YQ-1004', 'YQ-1005'];
    const weekPatterns: Record<string, string[]> = {
      'YQ-1002': ['MORNING', 'MORNING', 'NIGHT', 'NIGHT', 'OFF', 'AFTERNOON', 'MORNING'],
      'YQ-1003': ['MORNING', 'MORNING', 'MORNING', 'OFF', 'MORNING', 'MORNING', 'AFTERNOON'],
      'YQ-1004': ['AFTERNOON', 'AFTERNOON', 'MORNING', 'MORNING', 'OFF', 'MORNING', 'OFF'],
      'YQ-1005': ['MORNING', 'MORNING', 'MORNING', 'MORNING', 'MORNING', 'OFF', 'OFF'],
    };
    for (const empNo of shShiftEmps) {
      const pattern = weekPatterns[empNo];
      for (let i = 0; i < 7; i++) {
        const d = addDays(monday, i);
        // Make YQ-1003 day 6 a cross-store support shift to HZ-XH
        const isCross = empNo === 'YQ-1003' && i === 6 ? 1 : 0;
        const assignedHotel = isCross ? hotelIds['HZ-XH'] : hotelIds['SH-JA'];
        await tx.execute(
          `INSERT INTO shift_schedules (employee_id, home_hotel_id, assigned_hotel_id, shift_date, shift_type, is_cross_store, notes, created_by, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          [
            empIds[empNo],
            hotelIds['SH-JA'],
            assignedHotel,
            d,
            pattern[i],
            isCross,
            isCross ? '支援杭州西湖店周末高峰接待' : null,
            userIds['mgr_sh'],
            ts,
            ts,
          ]
        );
      }
    }
    // Also add prior-month night shifts so current/prior month payroll has realistic night allowances
    for (let day = 5; day <= 12; day += 2) {
      await tx.execute(
        `INSERT INTO shift_schedules (employee_id, home_hotel_id, assigned_hotel_id, shift_date, shift_type, is_cross_store, notes, created_by, created_at, updated_at)
         VALUES (?, ?, ?, ?, 'NIGHT', 0, '夜审值班', ?, ?, ?)`,
        [empIds['YQ-1002'], hotelIds['SH-JA'], hotelIds['SH-JA'], `${prevYm}-${String(day).padStart(2, '0')}`, userIds['mgr_sh'], ts, ts]
      );
      await tx.execute(
        `INSERT INTO shift_schedules (employee_id, home_hotel_id, assigned_hotel_id, shift_date, shift_type, is_cross_store, notes, created_by, created_at, updated_at)
         VALUES (?, ?, ?, ?, 'NIGHT', 0, '夜审值班', ?, ?, ?)`,
        [empIds['YQ-2002'], hotelIds['HZ-XH'], hotelIds['HZ-XH'], `${prevYm}-${String(day).padStart(2, '0')}`, userIds['region_east'], ts, ts]
      );
    }

    // 8. Leave Requests
    const leaveSeeds = [
      {
        request_no: 'LV-202611-001',
        empNo: 'YQ-1002',
        hotel: 'SH-JA',
        type: 'OVERTIME',
        start: `${curYm}-08`,
        end: `${curYm}-08`,
        days: 0,
        hours: 6,
        reason: '进博会团队入住高峰前厅加班接待',
        status: 'APPROVED',
        applicantRole: 'STAFF' as UserRole,
        approver: 'mgr_sh',
      },
      {
        request_no: 'LV-202611-002',
        empNo: 'YQ-1003',
        hotel: 'SH-JA',
        type: 'ANNUAL',
        start: addDays(today, 5),
        end: addDays(today, 6),
        days: 2,
        hours: 16,
        reason: '个人年假安排返乡探亲',
        status: 'PENDING_APPROVAL',
        applicantRole: 'STAFF' as UserRole,
        approver: null,
      },
      {
        request_no: 'LV-202611-003',
        empNo: 'YQ-1004',
        hotel: 'SH-JA',
        type: 'SICK',
        start: `${curYm}-04`,
        end: `${curYm}-04`,
        days: 1,
        hours: 8,
        reason: '急性肠胃炎就医休息',
        status: 'APPROVED',
        applicantRole: 'STAFF' as UserRole,
        approver: 'mgr_sh',
      },
      {
        request_no: 'LV-202611-004',
        empNo: 'YQ-1001',
        hotel: 'SH-JA',
        type: 'COMP_OFF',
        start: addDays(today, 8),
        end: addDays(today, 9),
        days: 2,
        hours: 16,
        reason: '节假日值班调休',
        status: 'PENDING_APPROVAL',
        applicantRole: 'STORE_MANAGER' as UserRole,
        approver: null,
      },
    ];
    for (const l of leaveSeeds) {
      const res = await tx.execute(
        `INSERT INTO leave_requests (request_no, employee_id, hotel_id, leave_type, start_date, end_date, days, hours, reason, status, current_step, approver_id, approved_at, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?, ?, ?)`,
        [
          l.request_no,
          empIds[l.empNo],
          hotelIds[l.hotel],
          l.type,
          l.start,
          l.end,
          l.days,
          l.hours,
          l.reason,
          l.status,
          l.approver ? userIds[l.approver] : null,
          l.status === 'APPROVED' ? ts : null,
          ts,
          ts,
        ]
      );
      const resolvedSteps = await resolveApprovalRoute(
        tx,
        hotelIds[l.hotel],
        buildLeaveRoute({ applicantRole: l.applicantRole, days: l.days })
      );
      await replaceApprovalSteps(tx, 'LEAVE', res.insertId, resolvedSteps.steps);
      if (l.status === 'APPROVED') {
        await tx.execute(
          `UPDATE approval_steps SET status = 'APPROVED', acted_by = ?, acted_at = ?, comment = '同意' WHERE biz_type = 'LEAVE' AND biz_id = ?`,
          [userIds['mgr_sh'], ts, res.insertId]
        );
      }
    }

    // 9. Prior month payroll calculation & confirmation
    await calculateMonthlyPayroll(tx, { yearMonth: prevYm });
    await tx.execute(
      `UPDATE payroll_records SET status = 'CONFIRMED', confirmed_by = ?, confirmed_at = ? WHERE \`year_month\` = ?`,
      [userIds['hr'], ts, prevYm]
    );

    // 10. Headcount Requests & Candidates
    const hc1 = await tx.execute(
      `INSERT INTO headcount_requests (request_no, hotel_id, department_id, position, headcount, urgency, salary_range, reason, applicant_id, status, current_step, created_at, updated_at)
       VALUES ('HC-202611-001', ?, ?, '客房服务员', 2, 'URGENT', '5500-6500元/月', '静安旗舰店入住率达92%，急需增补客房清扫人员', ?, 'PENDING_APPROVAL', 1, ?, ?)`,
      [hotelIds['SH-JA'], deptIds['SH-JA:HK'], userIds['mgr_sh'], ts, ts]
    );
    const hc1Resolved = await resolveApprovalRoute(
      tx,
      hotelIds['SH-JA'],
      buildHeadcountRoute({ headcount: 2, urgency: 'URGENT' })
    );
    await replaceApprovalSteps(tx, 'HEADCOUNT', hc1.insertId, hc1Resolved.steps);

    const hc2 = await tx.execute(
      `INSERT INTO headcount_requests (request_no, hotel_id, department_id, position, headcount, urgency, salary_range, reason, applicant_id, status, current_step, created_at, updated_at)
       VALUES ('HC-202611-002', ?, ?, '礼宾接待员', 1, 'NORMAL', '6500-7500元/月', '国贸商务店VIP商务客人增多，补充礼宾岗位', ?, 'APPROVED', 2, ?, ?)`,
      [hotelIds['BJ-GM'], deptIds['BJ-GM:FO'], userIds['mgr_bj'], ts, ts]
    );
    const hc2Resolved = await resolveApprovalRoute(
      tx,
      hotelIds['BJ-GM'],
      buildHeadcountRoute({ headcount: 1, urgency: 'NORMAL' })
    );
    await replaceApprovalSteps(tx, 'HEADCOUNT', hc2.insertId, hc2Resolved.steps);
    await tx.execute(
      `UPDATE approval_steps SET status = 'APPROVED', acted_by = ?, acted_at = ? WHERE biz_type = 'HEADCOUNT' AND biz_id = ?`,
      [userIds['hr'], ts, hc2.insertId]
    );

    const candDefs = [
      { hcId: hc1.insertId, hotel: 'SH-JA', dept: 'HK', name: '周敏', phone: '13900001122', pos: '客房服务员', sal: 6000, stage: 'INTERVIEW', notes: '曾任四星酒店客房领班，沟通踏实' },
      { hcId: hc1.insertId, hotel: 'SH-JA', dept: 'HK', name: '李建军', phone: '13900001123', pos: '客房服务员', sal: 5800, stage: 'OFFERED', notes: '面试通过，待体检和健康证确认后入职' },
      { hcId: hc2.insertId, hotel: 'BJ-GM', dept: 'FO', name: '宋佳怡', phone: '13600002233', pos: '礼宾接待员', sal: 7200, stage: 'OFFERED', notes: '英语流利，形象气质佳，可一键办理入职' },
      { hcId: null, hotel: 'HZ-XH', dept: 'FB', name: '徐浩然', phone: '13700003344', pos: '西点烘焙师', sal: 8500, stage: 'SCREENING', notes: '初筛简历合格' },
    ];
    for (const c of candDefs) {
      await tx.execute(
        `INSERT INTO candidates (headcount_request_id, hotel_id, department_id, name, phone, position, expected_salary, stage, interview_notes, created_by, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [c.hcId, hotelIds[c.hotel], deptIds[`${c.hotel}:${c.dept}`], c.name, c.phone, c.pos, c.sal, c.stage, c.notes, userIds['hr'], ts, ts]
      );
    }

    // 11. Store Budgets (prevYm, curYm, nextYm across all branches & categories)
    const budgetTemplates: Record<string, number> = {
      LINEN_SUPPLIES: 8000,
      MAINTENANCE: 5000,
      FB_PROCUREMENT: 10000,
      UTILITIES: 15000,
      MARKETING: 6000,
      TRAVEL_TRAINING: 3500,
      OTHER: 2500,
    };
    for (const ym of [prevYm, curYm, nextYm]) {
      for (const hCode of ['HQ-001', 'SH-JA', 'HZ-XH', 'BJ-GM', 'SZ-NS']) {
        const multiplier = hCode === 'SH-JA' ? 1.2 : hCode === 'HQ-001' ? 1.5 : 1;
        for (const [cat, amt] of Object.entries(budgetTemplates)) {
          await tx.execute(
            `INSERT INTO store_budgets (hotel_id, \`year_month\`, category, budget_amount, updated_by, created_at, updated_at)
             VALUES (?, ?, ?, ?, ?, ?, ?)`,
            [hotelIds[hCode], ym, cat, roundMoney(amt * multiplier), userIds['finance'], ts, ts]
          );
        }
      }
    }

    // 12. Cash Advances
    const adv1 = await tx.execute(
      `INSERT INTO cash_advances (advance_no, applicant_id, employee_id, hotel_id, advance_type, amount, offset_amount, purpose, expected_settle_date, status, current_step, payment_ref, disbursed_at, created_at, updated_at)
       VALUES ('ADV-202611-001', ?, ?, ?, 'PETTY_CASH', 3000.00, 1200.00, '上海静安旗舰店11月前台零星采购备用金', ?, 'DISBURSED', 2, 'PAY-ADV-20261101', ?, ?, ?)`,
      [userIds['mgr_sh'], empIds['YQ-1001'], hotelIds['SH-JA'], addDays(today, 20), ts, ts, ts]
    );
    const adv1Resolved = await resolveApprovalRoute(tx, hotelIds['SH-JA'], buildCashAdvanceRoute({ applicantRole: 'STORE_MANAGER', amount: 3000 }));
    await replaceApprovalSteps(tx, 'CASH_ADVANCE', adv1.insertId, adv1Resolved.steps);
    await tx.execute(`UPDATE approval_steps SET status = 'APPROVED', acted_by = ?, acted_at = ? WHERE biz_type = 'CASH_ADVANCE' AND biz_id = ?`, [userIds['finance'], ts, adv1.insertId]);

    const adv2 = await tx.execute(
      `INSERT INTO cash_advances (advance_no, applicant_id, employee_id, hotel_id, advance_type, amount, offset_amount, purpose, expected_settle_date, status, current_step, payment_ref, disbursed_at, created_at, updated_at)
       VALUES ('ADV-202611-002', ?, ?, ?, 'TRAVEL', 2000.00, 0.00, '前厅主管赴杭州西湖店跨店培训差旅预支', ?, 'DISBURSED', 2, 'PAY-ADV-20261108', ?, ?, ?)`,
      [userIds['staff_sh'], empIds['YQ-1002'], hotelIds['SH-JA'], addDays(today, 15), ts, ts, ts]
    );
    const adv2Resolved = await resolveApprovalRoute(tx, hotelIds['SH-JA'], buildCashAdvanceRoute({ applicantRole: 'STAFF', amount: 2000 }));
    await replaceApprovalSteps(tx, 'CASH_ADVANCE', adv2.insertId, adv2Resolved.steps);
    await tx.execute(`UPDATE approval_steps SET status = 'APPROVED', acted_by = ?, acted_at = ? WHERE biz_type = 'CASH_ADVANCE' AND biz_id = ?`, [userIds['finance'], ts, adv2.insertId]);

    const adv3 = await tx.execute(
      `INSERT INTO cash_advances (advance_no, applicant_id, employee_id, hotel_id, advance_type, amount, offset_amount, purpose, expected_settle_date, status, current_step, created_at, updated_at)
       VALUES ('ADV-202611-003', ?, ?, ?, 'PETTY_CASH', 4500.00, 0.00, '北京国贸店冬季供暖设备应急备用金', ?, 'PENDING_APPROVAL', 1, ?, ?)`,
      [userIds['mgr_bj'], empIds['YQ-3001'], hotelIds['BJ-GM'], addDays(today, 25), ts, ts]
    );
    const adv3Resolved = await resolveApprovalRoute(tx, hotelIds['BJ-GM'], buildCashAdvanceRoute({ applicantRole: 'STORE_MANAGER', amount: 4500 }));
    await replaceApprovalSteps(tx, 'CASH_ADVANCE', adv3.insertId, adv3Resolved.steps);

    // 13. Reimbursements (covering all statuses, risk flags, offset, and invoice samples)
    async function insertClaim(cfg: {
      claim_no: string;
      title: string;
      applicant: string;
      empNo: string;
      hotel: string;
      dept: string;
      month: string;
      status: string;
      currentStep: number;
      cashAdvanceId?: number | null;
      offsetAmount?: number;
      riskFlags?: string;
      riskSummary?: string | null;
      paymentChannel?: string | null;
      paymentRef?: string | null;
      paymentType?: 'CORPORATE' | 'PERSONAL';
      payeeName?: string;
      payeeBank?: string;
      payeeAccount?: string;
      items: Array<{
        category: string;
        date: string;
        desc: string;
        amount: number;
        invoiceNo?: string | null;
        attachmentUrl?: string | null;
        attachmentName?: string | null;
      }>;
      logs: Array<{ action: string; actor: string; comment: string }>;
    }) {
      const total = roundMoney(cfg.items.reduce((s, it) => s + it.amount, 0));
      const offset = roundMoney(cfg.offsetAmount || 0);
      const netPay = roundMoney(Math.max(0, total - offset));
      const applicantUser = userDefs.find((u) => u.username === cfg.applicant)!;
      const emp = empDefs.find((e) => e.emp_no === cfg.empNo)!;
      const resolvedRoute = await resolveApprovalRoute(
        tx,
        hotelIds[cfg.hotel],
        buildReimbursementRoute({
          applicantRole: applicantUser.role,
          totalAmount: total,
          hasOverBudget: (cfg.riskFlags || '').includes('OVER_BUDGET'),
        })
      );
      const route = resolvedRoute.steps;

      const payeeType = cfg.paymentType || 'PERSONAL';
      const payeeName = cfg.payeeName || emp.name;
      const payeeBank = cfg.payeeBank || emp.bank_name;
      const payeeAccount = cfg.payeeAccount || emp.bank_account;

      const res = await tx.execute(
        `INSERT INTO reimbursements (
          claim_no, title, applicant_id, employee_id, hotel_id, department_id, expense_month,
          total_amount, cash_advance_id, offset_amount, net_pay_amount, status, current_step, total_steps,
          risk_flags, risk_summary, payment_type, payee_name, payee_bank, payee_account, payment_channel, payment_ref,
          paid_by, paid_at, submitted_at, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          cfg.claim_no,
          cfg.title,
          userIds[cfg.applicant],
          empIds[cfg.empNo],
          hotelIds[cfg.hotel],
          deptIds[`${cfg.hotel}:${cfg.dept}`],
          cfg.month,
          total,
          cfg.cashAdvanceId ?? null,
          offset,
          netPay,
          cfg.status,
          cfg.status === 'DRAFT' ? 0 : cfg.currentStep,
          cfg.status === 'DRAFT' ? 0 : route.length,
          cfg.riskFlags || '',
          cfg.riskSummary ?? null,
          payeeType,
          payeeName,
          payeeBank,
          payeeAccount,
          cfg.paymentChannel ?? null,
          cfg.paymentRef ?? null,
          cfg.status === 'PAID' ? userIds['finance'] : null,
          cfg.status === 'PAID' ? ts : null,
          cfg.status === 'DRAFT' ? null : ts,
          ts,
          ts,
        ]
      );
      const claimId = res.insertId;

      if (cfg.status === 'PAID' && payeeAccount && payeeBank) {
        const exPayee = await tx.queryOne<{ id: number; paid_count: number }>(
          'SELECT id, paid_count FROM payee_accounts WHERE payment_type = ? AND account_number = ?',
          [payeeType, payeeAccount]
        );
        if (exPayee) {
          await tx.execute(
            `UPDATE payee_accounts SET paid_count = ?, last_paid_at = ?, updated_at = ? WHERE id = ?`,
            [Number(exPayee.paid_count || 0) + 1, ts, ts, exPayee.id]
          );
        } else {
          await tx.execute(
            `INSERT INTO payee_accounts (payment_type, account_name, account_number, bank_name, hotel_id, last_paid_at, paid_count, created_by, created_at, updated_at)
             VALUES (?, ?, ?, ?, ?, ?, 1, ?, ?, ?)`,
            [payeeType, payeeName, payeeAccount, payeeBank, hotelIds[cfg.hotel], ts, userIds['finance'], ts, ts]
          );
        }
      }

      for (const it of cfg.items) {
        await tx.execute(
          `INSERT INTO reimbursement_items (reimbursement_id, category, expense_date, description, amount, invoice_no, attachment_url, attachment_name, is_duplicate_invoice, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0, ?)`,
          [
            claimId,
            it.category,
            it.date,
            it.desc,
            it.amount,
            it.invoiceNo ?? null,
            it.attachmentUrl ?? null,
            it.attachmentName ?? null,
            ts,
          ]
        );
      }

      if (cfg.status !== 'DRAFT') {
        await replaceApprovalSteps(tx, 'REIMBURSEMENT', claimId, route);
        const actorByRole = (role: UserRole): number => {
          if (role === 'STORE_MANAGER') {
            return cfg.hotel === 'BJ-GM' ? userIds['mgr_bj'] : userIds['mgr_sh'];
          }
          if (role === 'REGIONAL_MANAGER') return userIds['region_east'];
          if (role === 'GENERAL_MANAGER') return userIds['gm'];
          if (role === 'HQ_ADMIN') return userIds['admin'];
          return userIds['gm'];
        };
        for (const step of route) {
          if (cfg.status === 'APPROVED' || cfg.status === 'PAID' || step.stepOrder < cfg.currentStep) {
            await tx.execute(
              `UPDATE approval_steps SET status = 'APPROVED', acted_by = ?, acted_at = ?, comment = '审核通过'
               WHERE biz_type = 'REIMBURSEMENT' AND biz_id = ? AND step_order = ?`,
              [actorByRole(step.approverRole), ts, claimId, step.stepOrder]
            );
          } else if (cfg.status === 'RETURNED' && step.stepOrder === cfg.currentStep) {
            await tx.execute(
              `UPDATE approval_steps SET status = 'RETURNED', acted_by = ?, acted_at = ?, comment = '请补充电子发票附件后重新提交'
               WHERE biz_type = 'REIMBURSEMENT' AND biz_id = ? AND step_order = ?`,
              [actorByRole(step.approverRole), ts, claimId, step.stepOrder]
            );
          } else if (cfg.status === 'PENDING_APPROVAL') {
            const st = step.stepOrder === cfg.currentStep ? 'PENDING' : 'WAITING';
            await tx.execute(
              `UPDATE approval_steps SET status = ? WHERE biz_type = 'REIMBURSEMENT' AND biz_id = ? AND step_order = ?`,
              [st, claimId, step.stepOrder]
            );
          }
        }
      }

      for (const log of cfg.logs) {
        const u = userDefs.find((x) => x.username === log.actor)!;
        await tx.execute(
          `INSERT INTO approval_logs (biz_type, biz_id, action, actor_id, actor_name, actor_role, comment, created_at)
           VALUES ('REIMBURSEMENT', ?, ?, ?, ?, ?, ?, ?)`,
          [claimId, log.action, userIds[log.actor], u.display_name, u.role, log.comment, ts]
        );
      }
    }

    // Paid claims (previous month + current month) for analytics, duplicate check & saved payees
    await insertClaim({
      claim_no: 'BX-202610-001',
      title: '上海静安店10月布草洗涤及客耗品补货',
      applicant: 'mgr_sh',
      empNo: 'YQ-1001',
      hotel: 'SH-JA',
      dept: 'HK',
      month: prevYm,
      status: 'PAID',
      currentStep: 2,
      cashAdvanceId: adv1.insertId,
      offsetAmount: 1200,
      paymentType: 'CORPORATE',
      payeeName: '洁雅布草洗涤服务有限公司',
      payeeBank: '中国银行上海市静安支行',
      payeeAccount: '4533781200091882',
      paymentChannel: 'BANK_TRANSFER',
      paymentRef: 'TXN-20261028-01',
      items: [
        {
          category: 'LINEN_SUPPLIES',
          date: `${prevYm}-18`,
          desc: '客房床品布草洗护及一次性洗漱补给',
          amount: 1860,
          invoiceNo: 'INV-2026-88012',
          attachmentUrl: '/seed-assets/invoice-sample-1.svg',
          attachmentName: 'invoice-sample-1.svg',
        },
        {
          category: 'OTHER',
          date: `${prevYm}-20`,
          desc: '前台迎宾香薰补充装采购',
          amount: 420,
          invoiceNo: 'INV-2026-88019',
        },
      ],
      logs: [
        { action: 'SUBMIT', actor: 'mgr_sh', comment: '提交10月布草补货报销（含备用金冲销）' },
        { action: 'APPROVE', actor: 'region_east', comment: '同意' },
        { action: 'APPROVE', actor: 'gm', comment: '总经理审批通过，转财务付款' },
        { action: 'PAY', actor: 'finance', comment: '已通过银企直连打款 ¥1,080.00，冲销备用金 ¥1,200.00' },
      ],
    });

    await insertClaim({
      claim_no: 'BX-202610-002',
      title: '北京国贸店10月暖通空调维保费',
      applicant: 'mgr_bj',
      empNo: 'YQ-3001',
      hotel: 'BJ-GM',
      dept: 'ENG',
      month: prevYm,
      status: 'PAID',
      currentStep: 2,
      paymentType: 'CORPORATE',
      payeeName: '华北暖通机电维保工程有限公司',
      payeeBank: '工商银行北京国贸支行',
      payeeAccount: '0200041609200188731',
      paymentChannel: 'BANK_TRANSFER',
      paymentRef: 'TXN-20261029-02',
      items: [
        {
          category: 'MAINTENANCE',
          date: `${prevYm}-22`,
          desc: '中央空调新风滤网更换及温控阀检修',
          amount: 3240,
          invoiceNo: 'INV-2026-99104',
          attachmentUrl: '/seed-assets/invoice-sample-2.svg',
          attachmentName: 'invoice-sample-2.svg',
        },
      ],
      logs: [
        { action: 'SUBMIT', actor: 'mgr_bj', comment: '提交空调维保报销' },
        { action: 'APPROVE', actor: 'gm', comment: '总经理终审通过' },
        { action: 'PAY', actor: 'finance', comment: '已打款' },
      ],
    });

    await insertClaim({
      claim_no: 'BX-202610-003',
      title: '前厅主管10月零星采购垫付报销',
      applicant: 'staff_sh',
      empNo: 'YQ-1002',
      hotel: 'SH-JA',
      dept: 'FO',
      month: prevYm,
      status: 'PAID',
      currentStep: 2,
      paymentType: 'PERSONAL',
      payeeName: '陆子轩',
      payeeBank: '招商银行静安支行',
      payeeAccount: '6225880100002002',
      paymentChannel: 'BANK_TRANSFER',
      paymentRef: 'TXN-20261030-09',
      items: [
        {
          category: 'OTHER',
          date: `${prevYm}-25`,
          desc: '大堂应急药品与雨具垫付采购',
          amount: 320,
          invoiceNo: 'INV-2026-88150',
        },
      ],
      logs: [
        { action: 'SUBMIT', actor: 'staff_sh', comment: '提交个人垫付报销' },
        { action: 'APPROVE', actor: 'mgr_sh', comment: '同意' },
        { action: 'APPROVE', actor: 'gm', comment: '总经理审批通过' },
        { action: 'PAY', actor: 'finance', comment: '已向个人账户打款' },
      ],
    });

    // Current month PAID
    await insertClaim({
      claim_no: 'BX-202611-001',
      title: '杭州西湖店11月水电物业费结算',
      applicant: 'region_east',
      empNo: 'YQ-0004',
      hotel: 'HZ-XH',
      dept: 'ADM',
      month: curYm,
      status: 'PAID',
      currentStep: 1,
      paymentType: 'CORPORATE',
      payeeName: '国网浙江省电力有限公司杭州供电公司',
      payeeBank: '建设银行杭州西湖支行',
      payeeAccount: '33001616235050008812',
      paymentChannel: 'BANK_TRANSFER',
      paymentRef: 'TXN-20261112-03',
      items: [
        {
          category: 'UTILITIES',
          date: `${curYm}-10`,
          desc: '11月上旬门店水电费预缴及排污费',
          amount: 4800,
          invoiceNo: 'INV-2026-77301',
        },
      ],
      logs: [
        { action: 'SUBMIT', actor: 'region_east', comment: '提交杭州店水电费报销' },
        { action: 'APPROVE', actor: 'gm', comment: '总经理终审通过' },
        { action: 'PAY', actor: 'finance', comment: '打款完成' },
      ],
    });

    // APPROVED -> in Finance Payout Queue (brand new vendor account, auto-saved once Finance pays)
    await insertClaim({
      claim_no: 'BX-202611-002',
      title: '上海静安店11月早餐厅有机食材采购',
      applicant: 'staff_sh',
      empNo: 'YQ-1002',
      hotel: 'SH-JA',
      dept: 'FB',
      month: curYm,
      status: 'APPROVED',
      currentStep: 3,
      paymentType: 'CORPORATE',
      payeeName: '绿源有机食品配送有限公司',
      payeeBank: '招商银行上海静安支行',
      payeeAccount: '121928374610901',
      items: [
        {
          category: 'FB_PROCUREMENT',
          date: `${curYm}-12`,
          desc: '自助早餐牛奶、烘焙原料及鲜果采购',
          amount: 2680,
          invoiceNo: 'INV-2026-66201',
          attachmentUrl: '/seed-assets/invoice-sample-1.svg',
          attachmentName: 'invoice-sample-1.svg',
        },
      ],
      logs: [
        { action: 'SUBMIT', actor: 'staff_sh', comment: '提交11月早餐食材报销' },
        { action: 'APPROVE', actor: 'mgr_sh', comment: '店长确认入库单一致' },
        { action: 'APPROVE', actor: 'region_east', comment: '同意' },
        { action: 'APPROVE', actor: 'gm', comment: '总经理终审通过，转财务待付款队列' },
      ],
    });

    // PENDING_APPROVAL at Step 1 (Store Manager mgr_sh)
    await insertClaim({
      claim_no: 'BX-202611-003',
      title: '前厅迎宾耗材及应急充电宝采购',
      applicant: 'staff_sh',
      empNo: 'YQ-1002',
      hotel: 'SH-JA',
      dept: 'FO',
      month: curYm,
      status: 'PENDING_APPROVAL',
      currentStep: 1,
      items: [
        {
          category: 'LINEN_SUPPLIES',
          date: `${curYm}-15`,
          desc: '大堂一次性雨伞、客用拖鞋及应急数据线',
          amount: 680,
          invoiceNo: 'INV-2026-55109',
        },
      ],
      logs: [{ action: 'SUBMIT', actor: 'staff_sh', comment: '提交审批' }],
    });

    // PENDING_APPROVAL at Step 2 (Regional Manager region_east)
    await insertClaim({
      claim_no: 'BX-202611-004',
      title: '上海静安店客房智能门锁批量维修',
      applicant: 'staff_sh',
      empNo: 'YQ-1002',
      hotel: 'SH-JA',
      dept: 'ENG',
      month: curYm,
      status: 'PENDING_APPROVAL',
      currentStep: 2,
      items: [
        {
          category: 'MAINTENANCE',
          date: `${curYm}-16`,
          desc: '3层与5层共12间客房感应门锁主板更换',
          amount: 2450,
          invoiceNo: 'INV-2026-55188',
          attachmentUrl: '/seed-assets/invoice-sample-2.svg',
          attachmentName: 'invoice-sample-2.svg',
        },
      ],
      logs: [
        { action: 'SUBMIT', actor: 'staff_sh', comment: '提交门锁维保报销' },
        { action: 'APPROVE', actor: 'mgr_sh', comment: '门店已验收门锁恢复正常，呈区域复核' },
      ],
    });

    // PENDING_APPROVAL at Step 2 (General Manager)
    await insertClaim({
      claim_no: 'BX-202611-005',
      title: '上海静安店双十一OTA推广与本地生活投流',
      applicant: 'mgr_sh',
      empNo: 'YQ-1001',
      hotel: 'SH-JA',
      dept: 'ADM',
      month: curYm,
      status: 'PENDING_APPROVAL',
      currentStep: 2,
      items: [
        {
          category: 'MARKETING',
          date: `${curYm}-11`,
          desc: '携程/美团门店首页置顶及套票推广费用',
          amount: 4200,
          invoiceNo: 'INV-2026-55320',
        },
      ],
      logs: [
        { action: 'SUBMIT', actor: 'mgr_sh', comment: '提交OTA推广费报销' },
        { action: 'APPROVE', actor: 'region_east', comment: 'ROI达标，呈总经理终审' },
      ],
    });

    // PENDING_APPROVAL large + OVER_BUDGET at General Manager (BJ-GM: GM == Regional Manager, skips to Step 1 GM)
    await insertClaim({
      claim_no: 'BX-202611-006',
      title: '北京国贸店冬季锅炉改造与大堂暖风工程',
      applicant: 'mgr_bj',
      empNo: 'YQ-3001',
      hotel: 'BJ-GM',
      dept: 'ENG',
      month: curYm,
      status: 'PENDING_APPROVAL',
      currentStep: 1,
      riskFlags: 'OVER_BUDGET',
      riskSummary: '预算超标：工程维修与维保超预算 ¥1,800.00',
      items: [
        {
          category: 'MAINTENANCE',
          date: `${curYm}-14`,
          desc: '主锅炉板换清洗及大堂热风幕安装工程',
          amount: 6800,
          invoiceNo: 'INV-2026-55901',
          attachmentUrl: '/seed-assets/invoice-sample-2.svg',
          attachmentName: 'invoice-sample-2.svg',
        },
      ],
      logs: [
        { action: 'SUBMIT', actor: 'mgr_bj', comment: '冬季供暖紧急改造工程，金额超预算需总经理特批' },
        { action: 'AUTO_SKIP', actor: 'mgr_bj', comment: '区域经理与总经理为同一人（周志远），已自动跳过区域经理审核，直达总经理审批' },
      ],
    });

    // RETURNED claim for testing edit & resubmit
    await insertClaim({
      claim_no: 'BX-202611-007',
      title: '杭州跨店培训交通住宿报销',
      applicant: 'staff_sh',
      empNo: 'YQ-1002',
      hotel: 'SH-JA',
      dept: 'FO',
      month: curYm,
      status: 'RETURNED',
      currentStep: 1,
      items: [
        {
          category: 'TRAVEL_TRAINING',
          date: `${curYm}-09`,
          desc: '沪杭高铁往返车票及市内交通',
          amount: 460,
          invoiceNo: 'INV-2026-55011',
        },
      ],
      logs: [
        { action: 'SUBMIT', actor: 'staff_sh', comment: '提交跨店培训差旅费' },
        { action: 'RETURN', actor: 'mgr_sh', comment: '请补充电子客票截图附件后重新提交' },
      ],
    });

    // DRAFT claim
    await insertClaim({
      claim_no: 'BX-202611-008',
      title: '11月下旬客房绿植租摆草稿',
      applicant: 'staff_sh',
      empNo: 'YQ-1002',
      hotel: 'SH-JA',
      dept: 'HK',
      month: curYm,
      status: 'DRAFT',
      currentStep: 0,
      items: [
        {
          category: 'OTHER',
          date: today,
          desc: '大堂及行政楼层绿植养护月费',
          amount: 520,
          invoiceNo: '',
        },
      ],
      logs: [{ action: 'SAVE_DRAFT', actor: 'staff_sh', comment: '保存报销草稿' }],
    });
  });

  console.log('[db:seed] Seeded YueQi Hotel Ops database successfully.');
}

async function main() {
  const reset = process.argv.includes('--reset');
  const db = createDbAdapterFromEnv();
  try {
    await initSchema(db);
    await seedDatabase(db, { reset });
  } finally {
    await db.close();
  }
}

if (require.main === module) {
  main().catch((err) => {
    console.error('[db:seed] Failed:', err);
    process.exit(1);
  });
}
