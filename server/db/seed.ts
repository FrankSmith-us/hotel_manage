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
  buildOffboardingRoute,
  buildOnboardingRoute,
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
      'shift_swap_requests',
      'schedule_publications',
      'shift_definitions',
      'employee_change_requests',
      'payroll_batches',
      'city_social_security_rules',
      'offboarding_clearance_items',
      'cash_advance_repayments',
      'approval_delegations',
      'budget_change_logs',
      'employee_archives',
      'offboarding_requests',
      'onboarding_requests',
      'master_data_sequences',
      'master_data_audit_logs',
      'master_dict_items',
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
      'job_positions',
      'dept_templates',
      'departments',
      'hotels',
      'districts',
      'cities',
      'regions',
    ];
    for (const t of tables) {
      await db.execute(`DELETE FROM ${t}`);
      if (db.dialect === 'mysql' && t !== 'master_data_sequences') {
        await db.execute(`ALTER TABLE ${t} AUTO_INCREMENT = 1`);
      }
    }
    if (db.dialect === 'sqlite') {
      try {
        await db.execute('DELETE FROM sqlite_sequence');
      } catch {
        // Ignore if sqlite_sequence has not been initialized yet
      }
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
      { code: 'HQ', name: '集团总部', sort: 1 },
      { code: 'EAST', name: '华东大区', sort: 2 },
      { code: 'NORTH', name: '华北大区', sort: 3 },
      { code: 'SOUTH', name: '华南大区', sort: 4 },
    ]) {
      const res = await tx.execute('INSERT INTO regions (code, name, sort_order, created_at) VALUES (?, ?, ?, ?)', [
        r.code,
        r.name,
        r.sort,
        ts,
      ]);
      regionIds[r.code] = res.insertId;
    }

    // 1b. Cities & Districts (Master Data)
    const cityIds: Record<string, number> = {};
    const cityDefs = [
      { code: 'SH', name: '上海市', region: 'EAST', sort: 1 },
      { code: 'HZ', name: '杭州市', region: 'EAST', sort: 2 },
      { code: 'NJ', name: '南京市', region: 'EAST', sort: 3 },
      { code: 'BJ', name: '北京市', region: 'NORTH', sort: 4 },
      { code: 'TJ', name: '天津市', region: 'NORTH', sort: 5 },
      { code: 'SZ', name: '深圳市', region: 'SOUTH', sort: 6 },
      { code: 'GZ', name: '广州市', region: 'SOUTH', sort: 7 },
    ];
    for (const c of cityDefs) {
      const res = await tx.execute(
        `INSERT INTO cities (region_id, code, name, sort_order, is_active, created_at, updated_at)
         VALUES (?, ?, ?, ?, 1, ?, ?)`,
        [regionIds[c.region], c.code, c.name, c.sort, ts, ts]
      );
      cityIds[c.code] = res.insertId;
    }

    const districtIds: Record<string, number> = {};
    const districtDefs = [
      { code: 'SH-JA', name: '静安区', city: 'SH', sort: 1 },
      { code: 'SH-HP', name: '黄浦区', city: 'SH', sort: 2 },
      { code: 'SH-PD', name: '浦东新区', city: 'SH', sort: 3 },
      { code: 'HZ-XH', name: '西湖区', city: 'HZ', sort: 1 },
      { code: 'HZ-SC', name: '上城区', city: 'HZ', sort: 2 },
      { code: 'NJ-GL', name: '鼓楼区', city: 'NJ', sort: 1 },
      { code: 'BJ-CY', name: '朝阳区', city: 'BJ', sort: 1 },
      { code: 'BJ-HD', name: '海淀区', city: 'BJ', sort: 2 },
      { code: 'TJ-HP', name: '和平区', city: 'TJ', sort: 1 },
      { code: 'SZ-NS', name: '南山区', city: 'SZ', sort: 1 },
      { code: 'SZ-FT', name: '福田区', city: 'SZ', sort: 2 },
      { code: 'GZ-TH', name: '天河区', city: 'GZ', sort: 1 },
    ];
    for (const d of districtDefs) {
      const res = await tx.execute(
        `INSERT INTO districts (city_id, code, name, sort_order, is_active, created_at, updated_at)
         VALUES (?, ?, ?, ?, 1, ?, ?)`,
        [cityIds[d.city], d.code, d.name, d.sort, ts, ts]
      );
      districtIds[d.code] = res.insertId;
    }

    // 1c. Department Templates (HQ / REGION / STORE)
    const deptTplIds: Record<string, number> = {};
    const deptTplDefs: Array<{ org_level: 'HQ' | 'REGION' | 'STORE'; code: string; name: string; category: string; sort: number }> = [
      // HQ
      { org_level: 'HQ', code: 'EXEC', name: '总经办', category: 'ADMIN', sort: 1 },
      { org_level: 'HQ', code: 'HR', name: '人力资源中心', category: 'ADMIN', sort: 2 },
      { org_level: 'HQ', code: 'FIN', name: '财务管理中心', category: 'ADMIN', sort: 3 },
      { org_level: 'HQ', code: 'OPS', name: '运营督导中心', category: 'ADMIN', sort: 4 },
      { org_level: 'HQ', code: 'IT', name: '信息系统部', category: 'ADMIN', sort: 5 },
      { org_level: 'HQ', code: 'DEV', name: '品牌拓展部', category: 'ADMIN', sort: 6 },
      // REGION
      { org_level: 'REGION', code: 'REG_OPS', name: '区域运营督导部', category: 'ADMIN', sort: 1 },
      { org_level: 'REGION', code: 'REG_HR', name: '区域人事培训部', category: 'ADMIN', sort: 2 },
      { org_level: 'REGION', code: 'REG_FIN', name: '区域财务核算部', category: 'ADMIN', sort: 3 },
      { org_level: 'REGION', code: 'REG_ENG', name: '区域工程支持部', category: 'ENGINEERING', sort: 4 },
      // STORE
      { org_level: 'STORE', code: 'FO', name: '前厅部', category: 'FRONT_OFFICE', sort: 1 },
      { org_level: 'STORE', code: 'HK', name: '客房部', category: 'HOUSEKEEPING', sort: 2 },
      { org_level: 'STORE', code: 'ENG', name: '工程维保部', category: 'ENGINEERING', sort: 3 },
      { org_level: 'STORE', code: 'FB', name: '餐饮部', category: 'FB', sort: 4 },
      { org_level: 'STORE', code: 'ADM', name: '门店综合管理部', category: 'ADMIN', sort: 5 },
    ];
    for (const dt of deptTplDefs) {
      const res = await tx.execute(
        `INSERT INTO dept_templates (org_level, code, name, category, sort_order, is_active, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, 1, ?, ?)`,
        [dt.org_level, dt.code, dt.name, dt.category, dt.sort, ts, ts]
      );
      deptTplIds[`${dt.org_level}:${dt.code}`] = res.insertId;
    }

    // 1d. Job Positions (separated strictly by org_level + dept_template)
    const posIds: Record<string, number> = {};
    const posDefs: Array<{ org_level: 'HQ' | 'REGION' | 'STORE'; dept: string; code: string; name: string; sort: number }> = [
      // HQ positions
      { org_level: 'HQ', dept: 'EXEC', code: 'HQ_GM', name: '集团总经理', sort: 1 },
      { org_level: 'HQ', dept: 'HR', code: 'HQ_HR_DIR', name: '集团HR总监', sort: 1 },
      { org_level: 'HQ', dept: 'HR', code: 'HQ_HR_SPEC', name: '人事专员', sort: 2 },
      { org_level: 'HQ', dept: 'FIN', code: 'HQ_FIN_MGR', name: '集团财务经理', sort: 1 },
      { org_level: 'HQ', dept: 'FIN', code: 'HQ_FIN_SPEC', name: '财务专员', sort: 2 },
      { org_level: 'HQ', dept: 'OPS', code: 'HQ_REG_MGR', name: '华东区区域经理', sort: 1 },
      { org_level: 'HQ', dept: 'OPS', code: 'HQ_SYS_ADMIN', name: '集团系统管理员', sort: 2 },
      { org_level: 'HQ', dept: 'IT', code: 'HQ_IT_ENG', name: '系统运维工程师', sort: 1 },
      { org_level: 'HQ', dept: 'DEV', code: 'HQ_DEV_MGR', name: '门店拓展经理', sort: 1 },
      // REGION positions
      { org_level: 'REGION', dept: 'REG_OPS', code: 'REG_DIR', name: '区域运营经理', sort: 1 },
      { org_level: 'REGION', dept: 'REG_HR', code: 'REG_HR_SPEC', name: '人事专员', sort: 1 },
      { org_level: 'REGION', dept: 'REG_FIN', code: 'REG_FIN_SPEC', name: '财务专员', sort: 1 },
      { org_level: 'REGION', dept: 'REG_ENG', code: 'REG_ENG_SUP', name: '区域工程督导', sort: 1 },
      // STORE positions
      { org_level: 'STORE', dept: 'ADM', code: 'ST_MGR', name: '门店店长', sort: 1 },
      { org_level: 'STORE', dept: 'ADM', code: 'ST_FIN_SPEC', name: '财务专员', sort: 2 },
      { org_level: 'STORE', dept: 'ADM', code: 'ST_HR_SPEC', name: '人事专员', sort: 3 },
      { org_level: 'STORE', dept: 'FO', code: 'ST_FO_SUP', name: '前厅主管', sort: 1 },
      { org_level: 'STORE', dept: 'FO', code: 'ST_FO_REC', name: '前台接待专员', sort: 2 },
      { org_level: 'STORE', dept: 'FO', code: 'ST_FO_NIGHT', name: '夜审前台专员', sort: 3 },
      { org_level: 'STORE', dept: 'FO', code: 'ST_FO_CON', name: '礼宾接待员', sort: 4 },
      { org_level: 'STORE', dept: 'HK', code: 'ST_HK_LEAD', name: '客房领班', sort: 1 },
      { org_level: 'STORE', dept: 'HK', code: 'ST_HK_ATT', name: '客房服务员', sort: 2 },
      { org_level: 'STORE', dept: 'ENG', code: 'ST_ENG_TECH', name: '工程维修技师', sort: 1 },
      { org_level: 'STORE', dept: 'ENG', code: 'ST_ENG_HVAC', name: '暖通维保主管', sort: 2 },
      { org_level: 'STORE', dept: 'FB', code: 'ST_FB_CHEF', name: '早餐厅厨师长', sort: 1 },
      { org_level: 'STORE', dept: 'FB', code: 'ST_FB_WAIT', name: '早餐厅服务员', sort: 2 },
    ];
    for (const p of posDefs) {
      const res = await tx.execute(
        `INSERT INTO job_positions (org_level, dept_template_id, code, name, sort_order, is_active, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, 1, ?, ?)`,
        [p.org_level, deptTplIds[`${p.org_level}:${p.dept}`], p.code, p.name, p.sort, ts, ts]
      );
      posIds[`${p.org_level}:${p.name}`] = res.insertId;
    }

    // 1e. Master Dictionary Items
    const dictDefs: Array<{ type: string; code: string; label: string; sort: number; isSystem?: number }> = [
      // 门店状态
      { type: 'HOTEL_STATUS', code: 'CONTRACTED', label: '签约', sort: 1, isSystem: 1 },
      { type: 'HOTEL_STATUS', code: 'RENOVATING', label: '装修', sort: 2, isSystem: 1 },
      { type: 'HOTEL_STATUS', code: 'SOFT_OPENING', label: '试营业', sort: 3, isSystem: 1 },
      { type: 'HOTEL_STATUS', code: 'OPEN', label: '开业', sort: 4, isSystem: 1 },
      { type: 'HOTEL_STATUS', code: 'SUSPENDED', label: '停业整顿', sort: 5, isSystem: 1 },
      { type: 'HOTEL_STATUS', code: 'CLOSED', label: '关闭', sort: 6, isSystem: 1 },
      // 员工性别
      { type: 'GENDER', code: 'M', label: '男', sort: 1, isSystem: 1 },
      { type: 'GENDER', code: 'F', label: '女', sort: 2, isSystem: 1 },
      // 学历类别
      { type: 'EDUCATION', code: 'JUNIOR_HIGH', label: '初中及以下', sort: 1 },
      { type: 'EDUCATION', code: 'HIGH_SCHOOL', label: '高中/中专', sort: 2 },
      { type: 'EDUCATION', code: 'ASSOCIATE', label: '大专', sort: 3 },
      { type: 'EDUCATION', code: 'BACHELOR', label: '本科', sort: 4 },
      { type: 'EDUCATION', code: 'MASTER', label: '硕士', sort: 5 },
      { type: 'EDUCATION', code: 'DOCTOR', label: '博士', sort: 6 },
      // 用工性质
      { type: 'EMPLOYMENT_TYPE', code: 'FULL_TIME', label: '全职', sort: 1, isSystem: 1 },
      { type: 'EMPLOYMENT_TYPE', code: 'PART_TIME', label: '兼职', sort: 2 },
      { type: 'EMPLOYMENT_TYPE', code: 'INTERN', label: '实习生', sort: 3 },
      { type: 'EMPLOYMENT_TYPE', code: 'DISPATCH', label: '劳务派遣', sort: 4 },
      // 婚姻状况
      { type: 'MARITAL_STATUS', code: 'SINGLE', label: '未婚', sort: 1 },
      { type: 'MARITAL_STATUS', code: 'MARRIED', label: '已婚', sort: 2 },
      { type: 'MARITAL_STATUS', code: 'DIVORCED', label: '离异', sort: 3 },
      { type: 'MARITAL_STATUS', code: 'WIDOWED', label: '丧偶', sort: 4 },
      // 政治面貌
      { type: 'POLITICAL_STATUS', code: 'MASSES', label: '群众', sort: 1 },
      { type: 'POLITICAL_STATUS', code: 'LEAGUE_MEMBER', label: '共青团员', sort: 2 },
      { type: 'POLITICAL_STATUS', code: 'PARTY_MEMBER', label: '中共党员', sort: 3 },
      { type: 'POLITICAL_STATUS', code: 'OTHER_PARTY', label: '民主党派', sort: 4 },
      // 费用报销科目
      { type: 'EXPENSE_CATEGORY', code: 'LINEN_SUPPLIES', label: '客房布草与客耗品', sort: 1, isSystem: 1 },
      { type: 'EXPENSE_CATEGORY', code: 'MAINTENANCE', label: '工程维修与维保', sort: 2, isSystem: 1 },
      { type: 'EXPENSE_CATEGORY', code: 'FB_PROCUREMENT', label: '餐饮食材采购', sort: 3, isSystem: 1 },
      { type: 'EXPENSE_CATEGORY', code: 'UTILITIES', label: '水电燃气与物业', sort: 4, isSystem: 1 },
      { type: 'EXPENSE_CATEGORY', code: 'MARKETING', label: '门店营销与OTA推广', sort: 5, isSystem: 1 },
      { type: 'EXPENSE_CATEGORY', code: 'TRAVEL_TRAINING', label: '差旅交通与培训', sort: 6, isSystem: 1 },
      { type: 'EXPENSE_CATEGORY', code: 'OTHER', label: '其他运营杂费', sort: 7, isSystem: 1 },
      // 付款渠道
      { type: 'PAYMENT_CHANNEL', code: 'BANK_TRANSFER', label: '对公/银行转账', sort: 1, isSystem: 1 },
      { type: 'PAYMENT_CHANNEL', code: 'ALIPAY_CORP', label: '企业支付宝', sort: 2 },
      { type: 'PAYMENT_CHANNEL', code: 'WECHAT_CORP', label: '企业微信支付', sort: 3 },
      { type: 'PAYMENT_CHANNEL', code: 'CASH', label: '现金付款', sort: 4 },
      // 请假与加班类型
      { type: 'LEAVE_TYPE', code: 'ANNUAL', label: '年假', sort: 1, isSystem: 1 },
      { type: 'LEAVE_TYPE', code: 'SICK', label: '病假', sort: 2, isSystem: 1 },
      { type: 'LEAVE_TYPE', code: 'PERSONAL', label: '事假', sort: 3, isSystem: 1 },
      { type: 'LEAVE_TYPE', code: 'COMP_OFF', label: '调休', sort: 4, isSystem: 1 },
      { type: 'LEAVE_TYPE', code: 'OVERTIME', label: '加班申请', sort: 5, isSystem: 1 },
      // 酒店排班班次
      { type: 'SHIFT_TYPE', code: 'MORNING', label: '早班', sort: 1, isSystem: 1 },
      { type: 'SHIFT_TYPE', code: 'AFTERNOON', label: '中班', sort: 2, isSystem: 1 },
      { type: 'SHIFT_TYPE', code: 'EVENING', label: '晚班', sort: 3, isSystem: 1 },
      { type: 'SHIFT_TYPE', code: 'NIGHT', label: '夜班', sort: 4, isSystem: 1 },
      { type: 'SHIFT_TYPE', code: 'OFF', label: '休息', sort: 5, isSystem: 1 },
      // 证照资质类型
      { type: 'CERT_TYPE', code: 'HEALTH_CERT', label: '食品/公共场所健康证', sort: 1 },
      { type: 'CERT_TYPE', code: 'ELECTRICIAN_CERT', label: '电工特种作业操作证', sort: 2 },
      { type: 'CERT_TYPE', code: 'FIRE_OPERATOR_CERT', label: '消防设施操作员证', sort: 3 },
      { type: 'CERT_TYPE', code: 'FOOD_SAFETY_CERT', label: '食品安全管理员证', sort: 4 },
      // 合同类型
      { type: 'CONTRACT_TYPE', code: 'FIXED_TERM', label: '固定期限劳动合同', sort: 1 },
      { type: 'CONTRACT_TYPE', code: 'OPEN_ENDED', label: '无固定期限劳动合同', sort: 2 },
      { type: 'CONTRACT_TYPE', code: 'INTERNSHIP', label: '实习协议', sort: 3 },
      { type: 'CONTRACT_TYPE', code: 'LABOR_SERVICE', label: '劳务协议', sort: 4 },
      // 离职原因
      { type: 'RESIGN_REASON', code: 'PERSONAL_DEV', label: '个人职业发展', sort: 1 },
      { type: 'RESIGN_REASON', code: 'COMPENSATION', label: '薪资福利原因', sort: 2 },
      { type: 'RESIGN_REASON', code: 'FAMILY', label: '家庭或居住地变动', sort: 3 },
      { type: 'RESIGN_REASON', code: 'CONTRACT_EXPIRE', label: '合同到期不再续签', sort: 4 },
      { type: 'RESIGN_REASON', code: 'PROBATION_FAIL', label: '试用期考核未通过', sort: 5 },
    ];
    for (const item of dictDefs) {
      await tx.execute(
        `INSERT INTO master_dict_items (dict_type, code, label, sort_order, is_active, is_system, created_at, updated_at)
         VALUES (?, ?, ?, ?, 1, ?, ?, ?)`,
        [item.type, item.code, item.label, item.sort, item.isSystem ?? 0, ts, ts]
      );
    }

    // 1f. Initialize monotonic sequence watermarks so deleted tail items never get reused
    const seqMap = new Map<string, number>();
    const bumpSeq = (key: string, val: number) => {
      seqMap.set(key, Math.max(seqMap.get(key) ?? 0, val));
    };
    bumpSeq('REGION', 4);
    for (const c of cityDefs) bumpSeq('CITY', c.sort);
    for (const d of districtDefs) bumpSeq(`DISTRICT:${cityIds[d.city]}`, d.sort);
    for (const dt of deptTplDefs) bumpSeq(`DEPT:${dt.org_level}`, dt.sort);
    for (const p of posDefs) bumpSeq(`POSITION:${p.org_level}:${deptTplIds[`${p.org_level}:${p.dept}`]}`, p.sort);
    for (const item of dictDefs) bumpSeq(`DICT:${item.type}`, item.sort);
    for (const [seqKey, lastVal] of seqMap.entries()) {
      await tx.execute(
        `INSERT INTO master_data_sequences (seq_key, last_val, updated_at) VALUES (?, ?, ?)`,
        [seqKey, lastVal, ts]
      );
    }

    // 2. Hotels
    const hotelIds: Record<string, number> = {};
    const hotelDefs = [
      {
        code: 'HQ-001',
        name: '悦栖酒店管理集团总部',
        region: 'HQ',
        cityCode: 'SH',
        districtCode: 'SH-JA',
        city: '上海市',
        district: '静安区',
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
        cityCode: 'SH',
        districtCode: 'SH-JA',
        city: '上海市',
        district: '静安区',
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
        cityCode: 'HZ',
        districtCode: 'HZ-XH',
        city: '杭州市',
        district: '西湖区',
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
        cityCode: 'BJ',
        districtCode: 'BJ-CY',
        city: '北京市',
        district: '朝阳区',
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
        cityCode: 'SZ',
        districtCode: 'SZ-NS',
        city: '深圳市',
        district: '南山区',
        address: '深圳市南山区高新南一道18号',
        phone: '0755-26668800',
        room_count: 135,
        is_hq: 0,
        opened_at: '2024-04-12',
      },
    ];
    for (const h of hotelDefs) {
      const res = await tx.execute(
        `INSERT INTO hotels (code, name, region_id, city_id, district_id, city, district, address, phone, room_count, is_hq, status, opened_at, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'OPEN', ?, ?)`,
        [
          h.code,
          h.name,
          regionIds[h.region],
          cityIds[h.cityCode],
          districtIds[h.districtCode],
          h.city,
          h.district,
          h.address,
          h.phone,
          h.room_count,
          h.is_hq,
          h.opened_at,
          ts,
        ]
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
      const orgLevel = e.hotel === 'HQ-001' ? 'HQ' : 'STORE';
      const posId = posIds[`${orgLevel}:${e.position}`] ?? null;
      const education = e.hotel === 'HQ-001' ? 'BACHELOR' : e.position.includes('店长') || e.position.includes('主管') ? 'BACHELOR' : 'ASSOCIATE';
      const maritalStatus = e.emp_no.endsWith('1') || e.emp_no.endsWith('3') ? 'MARRIED' : 'SINGLE';
      const politicalStatus = e.emp_no === 'YQ-0001' || e.emp_no === 'YQ-0002' || e.emp_no === 'YQ-3001' ? 'PARTY_MEMBER' : 'MASSES';
      const res = await tx.execute(
        `INSERT INTO employees (
          emp_no, name, gender, phone, email, id_card_last4, hotel_id, department_id,
          position_id, position, education, marital_status, political_status,
          employment_type, status, hire_date, probation_end_date, contract_end_date,
          health_cert_no, health_cert_expiry, base_salary, night_allowance_rate,
          bank_name, bank_account, emergency_contact, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'FULL_TIME', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          e.emp_no,
          e.name,
          e.gender,
          e.phone,
          e.email,
          e.emp_no.slice(-4),
          hotelIds[e.hotel],
          deptIds[`${e.hotel}:${e.dept}`],
          posId,
          e.position,
          education,
          maritalStatus,
          politicalStatus,
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

    // 5. Demo Users (first 8 IDs preserved; all 16 seeded employees have login accounts)
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
      { username: 'staff_sh_hk', empNo: 'YQ-1003', display_name: '赵小燕', role: 'STAFF', hotel: 'SH-JA', region: 'EAST' },
      { username: 'staff_sh_eng', empNo: 'YQ-1004', display_name: '孙伟强', role: 'STAFF', hotel: 'SH-JA', region: 'EAST' },
      { username: 'staff_sh_fb', empNo: 'YQ-1005', display_name: '吴婷婷', role: 'STAFF', hotel: 'SH-JA', region: 'EAST' },
      { username: 'mgr_hz', empNo: 'YQ-2001', display_name: '顾文博', role: 'STORE_MANAGER', hotel: 'HZ-XH', region: 'EAST' },
      { username: 'staff_hz', empNo: 'YQ-2002', display_name: '方思琪', role: 'STAFF', hotel: 'HZ-XH', region: 'EAST' },
      { username: 'staff_bj_fo', empNo: 'YQ-3002', display_name: '刘思雨', role: 'STAFF', hotel: 'BJ-GM', region: 'NORTH' },
      { username: 'staff_bj_eng', empNo: 'YQ-3003', display_name: '马志鹏', role: 'STAFF', hotel: 'BJ-GM', region: 'NORTH' },
      { username: 'mgr_sz', empNo: 'YQ-4001', display_name: '陈晓东', role: 'STORE_MANAGER', hotel: 'SZ-NS', region: 'SOUTH' },
    ];

    for (const u of userDefs) {
      const res = await tx.execute(
        `INSERT INTO users (username, password_hash, display_name, role, employee_id, hotel_id, region_id, is_active, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, 1, ?)`,
        [u.username, passwordHash, u.display_name, u.role, empIds[u.empNo], hotelIds[u.hotel], regionIds[u.region], ts]
      );
      userIds[u.username] = res.insertId;
    }

    const actorUsernameForStep = (hotelCode: string, role: UserRole): string => {
      if (role === 'STORE_MANAGER') {
        if (hotelCode === 'SH-JA') return 'mgr_sh';
        if (hotelCode === 'HZ-XH') return 'mgr_hz';
        if (hotelCode === 'BJ-GM') return 'mgr_bj';
        if (hotelCode === 'SZ-NS') return 'mgr_sz';
        return 'mgr_sh';
      }
      if (role === 'REGIONAL_MANAGER') {
        if (hotelCode === 'SH-JA' || hotelCode === 'HZ-XH') return 'region_east';
        return 'gm';
      }
      if (role === 'GENERAL_MANAGER') return 'gm';
      if (role === 'HR_MANAGER') return 'hr';
      if (role === 'FINANCE') return 'finance';
      if (role === 'HQ_ADMIN') return 'admin';
      return 'gm';
    };

    const insertLog = async (
      bizType: string,
      bizId: number,
      action: string,
      actorUsername: string,
      comment: string
    ) => {
      const u = userDefs.find((x) => x.username === actorUsername)!;
      await tx.execute(
        `INSERT INTO approval_logs (biz_type, biz_id, action, actor_id, actor_name, actor_role, comment, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        [bizType, bizId, action, userIds[actorUsername], u.display_name, u.role, comment, ts]
      );
    };

    // Assign region managers: EAST has dedicated region_east; NORTH, SOUTH, HQ are concurrently managed by GM
    await tx.execute('UPDATE regions SET manager_user_id = ? WHERE id = ?', [userIds['region_east'], regionIds['EAST']]);
    await tx.execute('UPDATE regions SET manager_user_id = ? WHERE id IN (?, ?, ?)', [
      userIds['gm'],
      regionIds['NORTH'],
      regionIds['SOUTH'],
      regionIds['HQ'],
    ]);

    // Baseline master data audit log
    await tx.execute(
      `INSERT INTO master_data_audit_logs (entity_type, entity_id, entity_label, action, before_data, after_data, operator_id, operator_name, operator_role, created_at)
       VALUES ('SYSTEM_INIT', 1, '基础数据初始化', 'CREATE', NULL, ?, ?, '张景行', 'HQ_ADMIN', ?)`,
      [
        JSON.stringify({
          regions: 4,
          cities: cityDefs.length,
          districts: districtDefs.length,
          dept_templates: deptTplDefs.length,
          job_positions: posDefs.length,
          dict_items: dictDefs.length,
        }),
        userIds['admin'],
        ts,
      ]
    );

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
        [empIds['YQ-2002'], hotelIds['HZ-XH'], hotelIds['HZ-XH'], `${prevYm}-${String(day).padStart(2, '0')}`, userIds['mgr_hz'], ts, ts]
      );
    }

    // 8. Leave Requests
    const leaveSeeds: Array<{
      request_no: string;
      empNo: string;
      applicantUser: string;
      hotel: string;
      type: string;
      start: string;
      end: string;
      days: number;
      hours: number;
      reason: string;
      status: string;
      currentStep: number;
      applicantRole: UserRole;
      approver: string | null;
    }> = [
      {
        request_no: 'LV-202611-001',
        empNo: 'YQ-1002',
        applicantUser: 'staff_sh',
        hotel: 'SH-JA',
        type: 'OVERTIME',
        start: `${curYm}-08`,
        end: `${curYm}-08`,
        days: 0,
        hours: 6,
        reason: '进博会团队入住高峰前厅加班接待',
        status: 'APPROVED',
        currentStep: 1,
        applicantRole: 'STAFF',
        approver: 'mgr_sh',
      },
      {
        request_no: 'LV-202611-002',
        empNo: 'YQ-1003',
        applicantUser: 'staff_sh_hk',
        hotel: 'SH-JA',
        type: 'ANNUAL',
        start: addDays(today, 5),
        end: addDays(today, 6),
        days: 2,
        hours: 16,
        reason: '个人年假安排返乡探亲',
        status: 'PENDING_APPROVAL',
        currentStep: 1,
        applicantRole: 'STAFF',
        approver: null,
      },
      {
        request_no: 'LV-202611-003',
        empNo: 'YQ-1004',
        applicantUser: 'staff_sh_eng',
        hotel: 'SH-JA',
        type: 'SICK',
        start: `${curYm}-04`,
        end: `${curYm}-04`,
        days: 1,
        hours: 8,
        reason: '急性肠胃炎就医休息',
        status: 'APPROVED',
        currentStep: 1,
        applicantRole: 'STAFF',
        approver: 'mgr_sh',
      },
      {
        request_no: 'LV-202611-004',
        empNo: 'YQ-1001',
        applicantUser: 'mgr_sh',
        hotel: 'SH-JA',
        type: 'COMP_OFF',
        start: addDays(today, 8),
        end: addDays(today, 9),
        days: 2,
        hours: 16,
        reason: '节假日值班调休',
        status: 'PENDING_APPROVAL',
        currentStep: 1,
        applicantRole: 'STORE_MANAGER',
        approver: null,
      },
      {
        request_no: 'LV-202611-005',
        empNo: 'YQ-2002',
        applicantUser: 'staff_hz',
        hotel: 'HZ-XH',
        type: 'ANNUAL',
        start: addDays(today, 10),
        end: addDays(today, 12),
        days: 3,
        hours: 24,
        reason: '年度带薪休假旅游',
        status: 'PENDING_APPROVAL',
        currentStep: 2,
        applicantRole: 'STAFF',
        approver: null,
      },
      {
        request_no: 'LV-202611-006',
        empNo: 'YQ-3002',
        applicantUser: 'staff_bj_fo',
        hotel: 'BJ-GM',
        type: 'OVERTIME',
        start: `${curYm}-10`,
        end: `${curYm}-10`,
        days: 0,
        hours: 4,
        reason: '大型会议团夜审及退房高峰加班',
        status: 'APPROVED',
        currentStep: 1,
        applicantRole: 'STAFF',
        approver: 'mgr_bj',
      },
    ];
    for (const l of leaveSeeds) {
      const res = await tx.execute(
        `INSERT INTO leave_requests (request_no, employee_id, hotel_id, leave_type, start_date, end_date, days, hours, reason, status, current_step, approver_id, approved_at, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
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
          l.currentStep,
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
      await insertLog('LEAVE', res.insertId, 'SUBMIT', l.applicantUser, l.reason);
      if (resolvedSteps.skippedRegionalManager && resolvedSteps.skipReason) {
        await insertLog('LEAVE', res.insertId, 'AUTO_SKIP', l.applicantUser, resolvedSteps.skipReason);
      }
      for (const st of resolvedSteps.steps) {
        if (l.status === 'APPROVED' || st.stepOrder < l.currentStep) {
          const actorUname = actorUsernameForStep(l.hotel, st.approverRole);
          await tx.execute(
            `UPDATE approval_steps SET status = 'APPROVED', acted_by = ?, acted_at = ?, comment = '同意'
             WHERE biz_type = 'LEAVE' AND biz_id = ? AND step_order = ?`,
            [userIds[actorUname], ts, res.insertId, st.stepOrder]
          );
          await insertLog('LEAVE', res.insertId, 'APPROVE', actorUname, '同意');
        } else if (l.status === 'PENDING_APPROVAL') {
          const stepStatus = st.stepOrder === l.currentStep ? 'PENDING' : 'WAITING';
          await tx.execute(
            `UPDATE approval_steps SET status = ? WHERE biz_type = 'LEAVE' AND biz_id = ? AND step_order = ?`,
            [stepStatus, res.insertId, st.stepOrder]
          );
        }
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
    await insertLog('HEADCOUNT', hc1.insertId, 'SUBMIT', 'mgr_sh', '静安旗舰店入住率达92%，急需增补客房清扫人员');

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
    await insertLog('HEADCOUNT', hc2.insertId, 'SUBMIT', 'mgr_bj', '国贸商务店VIP商务客人增多，补充礼宾岗位');
    if (hc2Resolved.skippedRegionalManager && hc2Resolved.skipReason) {
      await insertLog('HEADCOUNT', hc2.insertId, 'AUTO_SKIP', 'mgr_bj', hc2Resolved.skipReason);
    }
    for (const st of hc2Resolved.steps) {
      const actorUname = actorUsernameForStep('BJ-GM', st.approverRole);
      await tx.execute(
        `UPDATE approval_steps SET status = 'APPROVED', acted_by = ?, acted_at = ?, comment = '同意补编'
         WHERE biz_type = 'HEADCOUNT' AND biz_id = ? AND step_order = ?`,
        [userIds[actorUname], ts, hc2.insertId, st.stepOrder]
      );
      await insertLog('HEADCOUNT', hc2.insertId, 'APPROVE', actorUname, '同意补编');
    }

    const hc3 = await tx.execute(
      `INSERT INTO headcount_requests (request_no, hotel_id, department_id, position, headcount, urgency, salary_range, reason, applicant_id, status, current_step, created_at, updated_at)
       VALUES ('HC-202611-003', ?, ?, '前厅接待员', 1, 'NORMAL', '5800-6800元/月', '西湖精品店周末客流攀升，补充前厅轮班接待', ?, 'PENDING_APPROVAL', 2, ?, ?)`,
      [hotelIds['HZ-XH'], deptIds['HZ-XH:FO'], userIds['mgr_hz'], ts, ts]
    );
    const hc3Resolved = await resolveApprovalRoute(
      tx,
      hotelIds['HZ-XH'],
      buildHeadcountRoute({ headcount: 1, urgency: 'NORMAL' })
    );
    await replaceApprovalSteps(tx, 'HEADCOUNT', hc3.insertId, hc3Resolved.steps);
    await insertLog('HEADCOUNT', hc3.insertId, 'SUBMIT', 'mgr_hz', '西湖精品店周末客流攀升，补充前厅轮班接待');
    for (const st of hc3Resolved.steps) {
      if (st.stepOrder < 2) {
        const actorUname = actorUsernameForStep('HZ-XH', st.approverRole);
        await tx.execute(
          `UPDATE approval_steps SET status = 'APPROVED', acted_by = ?, acted_at = ?, comment = '区域审核同意'
           WHERE biz_type = 'HEADCOUNT' AND biz_id = ? AND step_order = ?`,
          [userIds[actorUname], ts, hc3.insertId, st.stepOrder]
        );
        await insertLog('HEADCOUNT', hc3.insertId, 'APPROVE', actorUname, '区域审核同意');
      } else {
        await tx.execute(
          `UPDATE approval_steps SET status = ? WHERE biz_type = 'HEADCOUNT' AND biz_id = ? AND step_order = ?`,
          [st.stepOrder === 2 ? 'PENDING' : 'WAITING', hc3.insertId, st.stepOrder]
        );
      }
    }

    const candDefs = [
      { hcId: hc1.insertId, hotel: 'SH-JA', dept: 'HK', name: '周敏', phone: '13900001122', pos: '客房服务员', sal: 6000, stage: 'INTERVIEW', notes: '曾任四星酒店客房领班，沟通踏实' },
      { hcId: hc1.insertId, hotel: 'SH-JA', dept: 'HK', name: '李建军', phone: '13900001123', pos: '客房服务员', sal: 5800, stage: 'INTERVIEW', notes: '复试通过，待补编审批完成后发放 Offer' },
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
    await insertLog('CASH_ADVANCE', adv1.insertId, 'SUBMIT', 'mgr_sh', '上海静安旗舰店11月前台零星采购备用金');
    for (const st of adv1Resolved.steps) {
      const actorUname = actorUsernameForStep('SH-JA', st.approverRole);
      await tx.execute(
        `UPDATE approval_steps SET status = 'APPROVED', acted_by = ?, acted_at = ?, comment = '同意'
         WHERE biz_type = 'CASH_ADVANCE' AND biz_id = ? AND step_order = ?`,
        [userIds[actorUname], ts, adv1.insertId, st.stepOrder]
      );
      await insertLog('CASH_ADVANCE', adv1.insertId, 'APPROVE', actorUname, '同意');
    }
    await insertLog('CASH_ADVANCE', adv1.insertId, 'DISBURSE', 'finance', '已放款，流水号：PAY-ADV-20261101');

    const adv2 = await tx.execute(
      `INSERT INTO cash_advances (advance_no, applicant_id, employee_id, hotel_id, advance_type, amount, offset_amount, purpose, expected_settle_date, status, current_step, payment_ref, disbursed_at, created_at, updated_at)
       VALUES ('ADV-202611-002', ?, ?, ?, 'TRAVEL', 2000.00, 0.00, '前厅主管赴杭州西湖店跨店培训差旅预支', ?, 'DISBURSED', 2, 'PAY-ADV-20261108', ?, ?, ?)`,
      [userIds['staff_sh'], empIds['YQ-1002'], hotelIds['SH-JA'], addDays(today, 15), ts, ts, ts]
    );
    const adv2Resolved = await resolveApprovalRoute(tx, hotelIds['SH-JA'], buildCashAdvanceRoute({ applicantRole: 'STAFF', amount: 2000 }));
    await replaceApprovalSteps(tx, 'CASH_ADVANCE', adv2.insertId, adv2Resolved.steps);
    await insertLog('CASH_ADVANCE', adv2.insertId, 'SUBMIT', 'staff_sh', '前厅主管赴杭州西湖店跨店培训差旅预支');
    for (const st of adv2Resolved.steps) {
      const actorUname = actorUsernameForStep('SH-JA', st.approverRole);
      await tx.execute(
        `UPDATE approval_steps SET status = 'APPROVED', acted_by = ?, acted_at = ?, comment = '同意'
         WHERE biz_type = 'CASH_ADVANCE' AND biz_id = ? AND step_order = ?`,
        [userIds[actorUname], ts, adv2.insertId, st.stepOrder]
      );
      await insertLog('CASH_ADVANCE', adv2.insertId, 'APPROVE', actorUname, '同意');
    }
    await insertLog('CASH_ADVANCE', adv2.insertId, 'DISBURSE', 'finance', '已放款，流水号：PAY-ADV-20261108');

    const adv3 = await tx.execute(
      `INSERT INTO cash_advances (advance_no, applicant_id, employee_id, hotel_id, advance_type, amount, offset_amount, purpose, expected_settle_date, urgency, status, current_step, created_at, updated_at)
       VALUES ('ADV-202611-003', ?, ?, ?, 'PETTY_CASH', 4500.00, 0.00, '北京国贸店冬季供暖设备应急备用金', ?, 'URGENT', 'PENDING_APPROVAL', 1, ?, ?)`,
      [userIds['mgr_bj'], empIds['YQ-3001'], hotelIds['BJ-GM'], addDays(today, 25), ts, ts]
    );
    const adv3Resolved = await resolveApprovalRoute(tx, hotelIds['BJ-GM'], buildCashAdvanceRoute({ applicantRole: 'STORE_MANAGER', amount: 4500 }));
    await replaceApprovalSteps(tx, 'CASH_ADVANCE', adv3.insertId, adv3Resolved.steps);
    await insertLog('CASH_ADVANCE', adv3.insertId, 'SUBMIT', 'mgr_bj', '北京国贸店冬季供暖设备应急备用金');
    if (adv3Resolved.skippedRegionalManager && adv3Resolved.skipReason) {
      await insertLog('CASH_ADVANCE', adv3.insertId, 'AUTO_SKIP', 'mgr_bj', adv3Resolved.skipReason);
    }

    const adv4 = await tx.execute(
      `INSERT INTO cash_advances (advance_no, applicant_id, employee_id, hotel_id, advance_type, amount, offset_amount, purpose, expected_settle_date, status, current_step, created_at, updated_at)
       VALUES ('ADV-202611-004', ?, ?, ?, 'TRAVEL', 1200.00, 0.00, '杭州西湖店夜审专员赴上海总部系统培训差旅借款', ?, 'PENDING_APPROVAL', 2, ?, ?)`,
      [userIds['staff_hz'], empIds['YQ-2002'], hotelIds['HZ-XH'], addDays(today, 18), ts, ts]
    );
    const adv4Resolved = await resolveApprovalRoute(tx, hotelIds['HZ-XH'], buildCashAdvanceRoute({ applicantRole: 'STAFF', amount: 1200 }));
    await replaceApprovalSteps(tx, 'CASH_ADVANCE', adv4.insertId, adv4Resolved.steps);
    await insertLog('CASH_ADVANCE', adv4.insertId, 'SUBMIT', 'staff_hz', '杭州西湖店夜审专员赴上海总部系统培训差旅借款');
    for (const st of adv4Resolved.steps) {
      if (st.stepOrder < 2) {
        const actorUname = actorUsernameForStep('HZ-XH', st.approverRole);
        await tx.execute(
          `UPDATE approval_steps SET status = 'APPROVED', acted_by = ?, acted_at = ?, comment = '门店店长审核同意'
           WHERE biz_type = 'CASH_ADVANCE' AND biz_id = ? AND step_order = ?`,
          [userIds[actorUname], ts, adv4.insertId, st.stepOrder]
        );
        await insertLog('CASH_ADVANCE', adv4.insertId, 'APPROVE', actorUname, '门店店长审核同意');
      } else {
        await tx.execute(
          `UPDATE approval_steps SET status = ? WHERE biz_type = 'CASH_ADVANCE' AND biz_id = ? AND step_order = ?`,
          [st.stepOrder === 2 ? 'PENDING' : 'WAITING', adv4.insertId, st.stepOrder]
        );
      }
    }

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
      urgency?: 'NORMAL' | 'URGENT';
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
          total_amount, cash_advance_id, offset_amount, net_pay_amount, urgency, status, current_step, total_steps,
          risk_flags, risk_summary, returned_to_step, returned_to_user_id, returned_to_role, returned_from_step, return_reason,
          payment_type, payee_name, payee_bank, payee_account, payment_channel, payment_ref,
          paid_by, paid_at, submitted_at, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
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
          cfg.urgency || 'NORMAL',
          cfg.status,
          cfg.status === 'DRAFT' ? 0 : cfg.currentStep,
          cfg.status === 'DRAFT' ? 0 : route.length,
          cfg.riskFlags || '',
          cfg.riskSummary ?? null,
          cfg.status === 'RETURNED' ? 0 : null,
          cfg.status === 'RETURNED' ? userIds[cfg.applicant] : null,
          cfg.status === 'RETURNED' ? 'APPLICANT' : null,
          cfg.status === 'RETURNED' ? cfg.currentStep : null,
          cfg.status === 'RETURNED' ? '请补充电子客票截图附件后重新提交' : null,
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
        const actorByRole = (role: UserRole): number => userIds[actorUsernameForStep(cfg.hotel, role)];
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

    // PENDING_APPROVAL at Step 1 (Store Manager mgr_sh) - marked URGENT
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
      urgency: 'URGENT',
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
      urgency: 'URGENT',
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

    // Additional realistic claims ensuring every employee & branch has rich applied/approved tracking
    await insertClaim({
      claim_no: 'BX-202610-004',
      title: '北京国贸店10月配电房备件采购',
      applicant: 'staff_bj_eng',
      empNo: 'YQ-3003',
      hotel: 'BJ-GM',
      dept: 'ENG',
      month: prevYm,
      status: 'PAID',
      currentStep: 3,
      paymentType: 'PERSONAL',
      payeeName: '马志鹏',
      payeeBank: '工商银行北京朝阳支行',
      payeeAccount: '6222020200003003',
      paymentChannel: 'BANK_TRANSFER',
      paymentRef: 'TXN-20261031-11',
      items: [
        {
          category: 'MAINTENANCE',
          date: `${prevYm}-26`,
          desc: '应急照明电源模块及配电开关备件',
          amount: 1680,
          invoiceNo: 'INV-2026-99302',
        },
      ],
      logs: [
        { action: 'SUBMIT', actor: 'staff_bj_eng', comment: '提交配电房备件采购报销' },
        { action: 'AUTO_SKIP', actor: 'staff_bj_eng', comment: '区域经理与总经理为同一人（周志远），已自动跳过区域经理审核，直达总经理审批' },
        { action: 'APPROVE', actor: 'mgr_bj', comment: '核验入库无误' },
        { action: 'APPROVE', actor: 'gm', comment: '总经理终审通过' },
        { action: 'PAY', actor: 'finance', comment: '已打款至员工个人账户' },
      ],
    });

    await insertClaim({
      claim_no: 'BX-202611-009',
      title: '上海静安店11月客房深度保洁耗材采购',
      applicant: 'staff_sh_hk',
      empNo: 'YQ-1003',
      hotel: 'SH-JA',
      dept: 'HK',
      month: curYm,
      status: 'PENDING_APPROVAL',
      currentStep: 2,
      items: [
        {
          category: 'LINEN_SUPPLIES',
          date: `${curYm}-14`,
          desc: '客房除螨消杀药剂及布草去渍剂补货',
          amount: 1480,
          invoiceNo: 'INV-2026-55410',
        },
      ],
      logs: [
        { action: 'SUBMIT', actor: 'staff_sh_hk', comment: '提交客房保洁耗材报销' },
        { action: 'APPROVE', actor: 'mgr_sh', comment: '店长确认耗材已入库，呈区域经理复核' },
      ],
    });

    await insertClaim({
      claim_no: 'BX-202611-010',
      title: '上海静安店11月水泵密封件应急更换',
      applicant: 'staff_sh_eng',
      empNo: 'YQ-1004',
      hotel: 'SH-JA',
      dept: 'ENG',
      month: curYm,
      status: 'APPROVED',
      currentStep: 2,
      items: [
        {
          category: 'MAINTENANCE',
          date: `${curYm}-15`,
          desc: '负一层生活水泵机械密封件与止回阀采购',
          amount: 620,
          invoiceNo: 'INV-2026-55422',
        },
      ],
      logs: [
        { action: 'SUBMIT', actor: 'staff_sh_eng', comment: '提交工程维保零星配件报销' },
        { action: 'APPROVE', actor: 'mgr_sh', comment: '现场已修复验收，同意' },
        { action: 'APPROVE', actor: 'gm', comment: '总经理审批通过，转财务付款' },
      ],
    });

    await insertClaim({
      claim_no: 'BX-202611-011',
      title: '杭州西湖店11月大堂茶歇及欢迎水果采购',
      applicant: 'staff_hz',
      empNo: 'YQ-2002',
      hotel: 'HZ-XH',
      dept: 'FO',
      month: curYm,
      status: 'PENDING_APPROVAL',
      currentStep: 3,
      items: [
        {
          category: 'FB_PROCUREMENT',
          date: `${curYm}-13`,
          desc: '西湖龙井茶包及行政房欢迎时令水果采购',
          amount: 1350,
          invoiceNo: 'INV-2026-77418',
        },
      ],
      logs: [
        { action: 'SUBMIT', actor: 'staff_hz', comment: '提交茶歇水果采购报销' },
        { action: 'APPROVE', actor: 'mgr_hz', comment: '门店核实无误，呈区域经理复核' },
        { action: 'APPROVE', actor: 'region_east', comment: '同意，呈总经理终审' },
      ],
    });

    await insertClaim({
      claim_no: 'BX-202611-012',
      title: '北京国贸店11月前台礼宾雨伞与行李牌补货',
      applicant: 'staff_bj_fo',
      empNo: 'YQ-3002',
      hotel: 'BJ-GM',
      dept: 'FO',
      month: curYm,
      status: 'PENDING_APPROVAL',
      currentStep: 1,
      items: [
        {
          category: 'LINEN_SUPPLIES',
          date: `${curYm}-16`,
          desc: '定制LOGO长柄迎宾伞及行李寄存牌',
          amount: 390,
          invoiceNo: 'INV-2026-99405',
        },
      ],
      logs: [
        { action: 'SUBMIT', actor: 'staff_bj_fo', comment: '提交前台迎宾物资报销' },
        { action: 'AUTO_SKIP', actor: 'staff_bj_fo', comment: '区域经理与总经理为同一人（周志远），已自动跳过区域经理审核，直达总经理审批' },
      ],
    });

    await insertClaim({
      claim_no: 'BX-202611-013',
      title: '深圳南山店11月高新园区企业协议客户沙龙推广费',
      applicant: 'mgr_sz',
      empNo: 'YQ-4001',
      hotel: 'SZ-NS',
      dept: 'ADM',
      month: curYm,
      status: 'PENDING_APPROVAL',
      currentStep: 1,
      items: [
        {
          category: 'MARKETING',
          date: `${curYm}-15`,
          desc: '大客户推介会物料印刷及茶歇招待费用',
          amount: 2150,
          invoiceNo: 'INV-2026-44108',
        },
      ],
      logs: [
        { action: 'SUBMIT', actor: 'mgr_sz', comment: '提交企业客户沙龙推广报销' },
        { action: 'AUTO_SKIP', actor: 'mgr_sz', comment: '区域经理与总经理为同一人（周志远），已自动跳过区域经理审核，直达总经理审批' },
      ],
    });

    await insertClaim({
      claim_no: 'BX-202611-014',
      title: '上海静安店11月早餐厅烘焙原料急采',
      applicant: 'staff_sh_fb',
      empNo: 'YQ-1005',
      hotel: 'SH-JA',
      dept: 'FB',
      month: curYm,
      status: 'PAID',
      currentStep: 2,
      paymentType: 'PERSONAL',
      payeeName: '吴婷婷',
      payeeBank: '招商银行上海分行',
      payeeAccount: '6225880100002005',
      paymentChannel: 'BANK_TRANSFER',
      paymentRef: 'TXN-20261116-05',
      items: [
        {
          category: 'FB_PROCUREMENT',
          date: `${curYm}-11`,
          desc: '黄油、淡奶油及进口面粉补货垫付',
          amount: 480,
          invoiceNo: 'INV-2026-55290',
        },
      ],
      logs: [
        { action: 'SUBMIT', actor: 'staff_sh_fb', comment: '提交早餐厅原料垫付报销' },
        { action: 'APPROVE', actor: 'mgr_sh', comment: '确认已入库使用' },
        { action: 'APPROVE', actor: 'gm', comment: '总经理终审通过' },
        { action: 'PAY', actor: 'finance', comment: '已向吴婷婷个人账户打款 ¥480.00' },
      ],
    });

    await insertClaim({
      claim_no: 'BX-202611-015',
      title: '集团HR中心11月华东门店巡店招聘差旅费',
      applicant: 'hr',
      empNo: 'YQ-0002',
      hotel: 'HQ-001',
      dept: 'HR',
      month: curYm,
      status: 'PAID',
      currentStep: 1,
      paymentType: 'PERSONAL',
      payeeName: '林婉清',
      payeeBank: '招商银行上海分行',
      payeeAccount: '6225880100001002',
      paymentChannel: 'BANK_TRANSFER',
      paymentRef: 'TXN-20261117-02',
      items: [
        {
          category: 'TRAVEL_TRAINING',
          date: `${curYm}-12`,
          desc: '沪杭高铁差旅及校招场地物料费',
          amount: 960,
          invoiceNo: 'INV-2026-10208',
        },
      ],
      logs: [
        { action: 'SUBMIT', actor: 'hr', comment: '提交巡店招聘差旅报销' },
        { action: 'APPROVE', actor: 'gm', comment: '总经理终审通过' },
        { action: 'PAY', actor: 'finance', comment: '已完成报销打款' },
      ],
    });

    // 10. Onboarding & Offboarding Demo Workflows
    const shJaHotelId = hotelIds['SH-JA'];
    const shJaFoDept = await tx.queryOne<{ id: number }>(
      `SELECT id FROM departments WHERE hotel_id = ? AND code = 'FO'`,
      [shJaHotelId]
    );
    if (shJaFoDept) {
      const obIns = await tx.execute(
        `INSERT INTO onboarding_requests (
          request_no, candidate_name, gender, phone, hotel_id, department_id,
          position, education, employment_type, marital_status, political_status,
          planned_hire_date, base_salary, night_allowance_rate, create_user_account,
          applicant_id, status, current_step, remarks, created_at, updated_at
        ) VALUES ('OB-202611-001', '许文浩', 'M', '13911223344', ?, ?, '礼宾接待员', 'BACHELOR', 'FULL_TIME', 'SINGLE', 'LEAGUE_MEMBER', ?, 6200, 80, 1, ?, 'PENDING_APPROVAL', 1, '前厅礼宾岗增补人员入职审批', ?, ?)`,
        [shJaHotelId, shJaFoDept.id, addDays(today, 3), userIds['mgr_sh'], ts, ts]
      );
      const obRoute = await resolveApprovalRoute(
        tx,
        shJaHotelId,
        buildOnboardingRoute({ applicantRole: 'STORE_MANAGER' })
      );
      await replaceApprovalSteps(tx, 'ONBOARDING', obIns.insertId, obRoute.steps);
      await tx.execute(
        `INSERT INTO approval_logs (biz_type, biz_id, action, actor_id, actor_name, actor_role, comment, created_at)
         VALUES ('ONBOARDING', ?, 'SUBMIT', ?, '沈佳妮', 'STORE_MANAGER', '发起新员工许文浩入职申请', ?)`,
        [obIns.insertId, userIds['mgr_sh'], ts]
      );
    }

    const staffHkEmp = await tx.queryOne<{ id: number }>(`SELECT id FROM employees WHERE emp_no = 'YQ-1002'`);
    const staffFoEmp = await tx.queryOne<{ id: number }>(`SELECT id FROM employees WHERE emp_no = 'YQ-1001'`);
    if (staffHkEmp) {
      const offIns = await tx.execute(
        `INSERT INTO offboarding_requests (
          request_no, employee_id, hotel_id, applicant_id, resign_reason_code,
          resign_reason_detail, last_working_date, handover_to_employee_id, handover_notes,
          status, current_step, created_at, updated_at
        ) VALUES ('OFF-202611-001', ?, ?, ?, 'FAMILY', '家庭居住地变动，申请办理离职交接', ?, ?, '客房排班表与布草盘点台账交接至前厅主管', 'PENDING_APPROVAL', 1, ?, ?)`,
        [
          staffHkEmp.id,
          shJaHotelId,
          userIds['staff_sh_hk'],
          addDays(today, 7),
          staffFoEmp?.id ?? null,
          ts,
          ts,
        ]
      );
      const offRoute = await resolveApprovalRoute(
        tx,
        shJaHotelId,
        buildOffboardingRoute({ targetRole: 'STAFF' })
      );
      await replaceApprovalSteps(tx, 'OFFBOARDING', offIns.insertId, offRoute.steps);
      await tx.execute(
        `INSERT INTO approval_logs (biz_type, biz_id, action, actor_id, actor_name, actor_role, comment, created_at)
         VALUES ('OFFBOARDING', ?, 'SUBMIT', ?, '赵小燕', 'STAFF', '提交个人离职申请', ?)`,
        [offIns.insertId, userIds['staff_sh_hk'], ts]
      );
    }

    const ssRules = [
      ['上海', 2026, 7384, 36921, 0.08, 0.02, 0.005, 0.07, 0.175],
      ['北京', 2026, 6821, 35283, 0.08, 0.02, 0.005, 0.07, 0.175],
      ['杭州', 2026, 4812, 24060, 0.08, 0.02, 0.005, 0.07, 0.175],
      ['深圳', 2026, 4492, 27501, 0.08, 0.02, 0.005, 0.05, 0.155],
      ['广州', 2026, 5510, 27501, 0.08, 0.02, 0.005, 0.05, 0.155],
    ] as const;
    for (const [city, yr, minB, maxB, pR, mR, uR, hR, totR] of ssRules) {
      await tx.execute(
        `INSERT INTO city_social_security_rules (
          city, effective_year, ss_base_min, ss_base_max, pension_rate, medical_rate,
          unemployment_rate, housing_fund_rate, total_personal_rate, updated_by, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [city, yr, minB, maxB, pR, mR, uR, hR, totR, userIds['admin'], ts]
      );
    }

    const defaultShifts = [
      ['MORNING', '早班', '08:00', '16:00', 8, 0, 0],
      ['AFTERNOON', '中班', '14:00', '22:00', 8, 0, 0],
      ['EVENING', '晚班', '16:00', '00:00', 8, 0, 0],
      ['NIGHT', '夜审/夜班', '23:00', '07:00', 8, 1, 80],
      ['OFF', '休息', '00:00', '00:00', 0, 0, 0],
    ] as const;
    for (const [code, name, st, et, hrs, isNight, allow] of defaultShifts) {
      await tx.execute(
        `INSERT INTO shift_definitions (hotel_id, code, name, start_time, end_time, work_hours, is_night, allowance_amount, is_active, created_at)
         VALUES (0, ?, ?, ?, ?, ?, ?, ?, 1, ?)`,
        [code, name, st, et, hrs, isNight, allow, ts]
      );
    }
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
