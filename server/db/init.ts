import fs from 'node:fs';
import path from 'node:path';
import dotenv from 'dotenv';
import { DbAdapter } from './adapter';
import { createDbAdapterFromEnv, isDemoMode } from './index';
import { ensureMysqlDatabase } from './mysqlAdapter';

dotenv.config({ path: path.resolve(__dirname, '../../.env') });

export async function initSchema(db: DbAdapter): Promise<void> {
  const schemaFile =
    db.dialect === 'mysql'
      ? path.resolve(__dirname, 'mysql/schema.sql')
      : path.resolve(__dirname, 'sqlite/schema.sql');
  const sql = fs.readFileSync(schemaFile, 'utf8');
  await db.execScript(sql);

  // Idempotent column migration for existing databases
  if (db.dialect === 'sqlite') {
    const cols = await db.query<{ name: string }>('PRAGMA table_info(regions)');
    if (!cols.some((c) => c.name === 'manager_user_id')) {
      await db.execute('ALTER TABLE regions ADD COLUMN manager_user_id INTEGER');
    }
    if (!cols.some((c) => c.name === 'sort_order')) {
      await db.execute('ALTER TABLE regions ADD COLUMN sort_order INTEGER NOT NULL DEFAULT 0');
      await db.execute('UPDATE regions SET sort_order = id WHERE sort_order = 0');
    }
    const rCols = await db.query<{ name: string }>('PRAGMA table_info(reimbursements)');
    const rColNames = new Set(rCols.map((c) => c.name));
    if (!rColNames.has('payment_type')) {
      await db.execute(`ALTER TABLE reimbursements ADD COLUMN payment_type TEXT NOT NULL DEFAULT 'PERSONAL'`);
    }
    for (const [colName, colDef] of [
      ['returned_to_step', 'INTEGER'],
      ['returned_to_user_id', 'INTEGER'],
      ['returned_to_role', 'TEXT'],
      ['returned_from_step', 'INTEGER'],
      ['return_reason', 'TEXT'],
      ['urgency', `TEXT NOT NULL DEFAULT 'NORMAL'`],
      ['payment_fail_reason', 'TEXT'],
      ['payment_attempts', 'INTEGER NOT NULL DEFAULT 0'],
    ] as const) {
      if (!rColNames.has(colName)) {
        await db.execute(`ALTER TABLE reimbursements ADD COLUMN ${colName} ${colDef}`);
      }
    }
    for (const tbl of ['cash_advances', 'leave_requests'] as const) {
      const tCols = await db.query<{ name: string }>(`PRAGMA table_info(${tbl})`);
      if (!tCols.some((c) => c.name === 'urgency')) {
        await db.execute(`ALTER TABLE ${tbl} ADD COLUMN urgency TEXT NOT NULL DEFAULT 'NORMAL'`);
      }
    }
    const hCols = new Set((await db.query<{ name: string }>('PRAGMA table_info(hotels)')).map((c) => c.name));
    for (const [colName, colDef] of [
      ['city_id', 'INTEGER'],
      ['district_id', 'INTEGER'],
      ['district', 'TEXT'],
    ] as const) {
      if (!hCols.has(colName)) {
        await db.execute(`ALTER TABLE hotels ADD COLUMN ${colName} ${colDef}`);
      }
    }
    const eCols = new Set((await db.query<{ name: string }>('PRAGMA table_info(employees)')).map((c) => c.name));
    for (const [colName, colDef] of [
      ['position_id', 'INTEGER'],
      ['education', 'TEXT'],
      ['marital_status', 'TEXT'],
      ['political_status', 'TEXT'],
      ['probation_salary_ratio', 'REAL NOT NULL DEFAULT 1.00'],
      ['resign_date', 'TEXT'],
      ['special_additional_deduction', 'REAL NOT NULL DEFAULT 0.00'],
    ] as const) {
      if (!eCols.has(colName)) {
        await db.execute(`ALTER TABLE employees ADD COLUMN ${colName} ${colDef}`);
      }
    }
    const prCols = new Set((await db.query<{ name: string }>('PRAGMA table_info(payroll_records)')).map((c) => c.name));
    for (const [colName, colDef] of [
      ['prorated_days', 'REAL NOT NULL DEFAULT 0.00'],
      ['total_month_days', 'INTEGER NOT NULL DEFAULT 30'],
      ['other_allowance', 'REAL NOT NULL DEFAULT 0.00'],
      ['advance_deduction', 'REAL NOT NULL DEFAULT 0.00'],
      ['other_deduction', 'REAL NOT NULL DEFAULT 0.00'],
      ['is_resigned_settlement', 'INTEGER NOT NULL DEFAULT 0'],
      ['city_ss_base', 'REAL NOT NULL DEFAULT 0.00'],
      ['special_deduction', 'REAL NOT NULL DEFAULT 0.00'],
      ['taxable_income', 'REAL NOT NULL DEFAULT 0.00'],
      ['ytd_taxable_income', 'REAL NOT NULL DEFAULT 0.00'],
      ['ytd_tax_paid', 'REAL NOT NULL DEFAULT 0.00'],
      ['income_tax', 'REAL NOT NULL DEFAULT 0.00'],
    ] as const) {
      if (!prCols.has(colName)) {
        await db.execute(`ALTER TABLE payroll_records ADD COLUMN ${colName} ${colDef}`);
      }
    }
    const offCols = new Set((await db.query<{ name: string }>('PRAGMA table_info(offboarding_requests)')).map((c) => c.name));
    for (const [colName, colDef] of [
      ['effective_executed_at', 'TEXT'],
      ['settlement_status', "TEXT NOT NULL DEFAULT 'PENDING'"],
      ['unsettled_advance_amount', 'REAL NOT NULL DEFAULT 0.00'],
      ['pending_reimbursement_count', 'INTEGER NOT NULL DEFAULT 0'],
      ['handover_to_user_id', 'INTEGER'],
      ['scheduled_execute', 'INTEGER NOT NULL DEFAULT 0'],
    ] as const) {
      if (!offCols.has(colName)) {
        await db.execute(`ALTER TABLE offboarding_requests ADD COLUMN ${colName} ${colDef}`);
      }
    }
    const uCols = new Set((await db.query<{ name: string }>('PRAGMA table_info(users)')).map((c) => c.name));
    if (!uCols.has('must_change_password')) {
      await db.execute('ALTER TABLE users ADD COLUMN must_change_password INTEGER NOT NULL DEFAULT 0');
    }
    if (!uCols.has('password_changed_at')) {
      await db.execute('ALTER TABLE users ADD COLUMN password_changed_at TEXT');
    }
    const sCols = new Set((await db.query<{ name: string }>('PRAGMA table_info(approval_steps)')).map((c) => c.name));
    if (!sCols.has('delegated_from_user_id')) {
      await db.execute('ALTER TABLE approval_steps ADD COLUMN delegated_from_user_id INTEGER');
    }
    if (!sCols.has('skip_reason')) {
      await db.execute('ALTER TABLE approval_steps ADD COLUMN skip_reason TEXT');
    }
    const advCols = new Set((await db.query<{ name: string }>('PRAGMA table_info(cash_advances)')).map((c) => c.name));
    for (const [colName, colDef] of [
      ['repaid_amount', 'REAL NOT NULL DEFAULT 0.00'],
      ['payee_name', 'TEXT'],
      ['payee_bank', 'TEXT'],
      ['payee_account', 'TEXT'],
    ] as const) {
      if (!advCols.has(colName)) {
        await db.execute(`ALTER TABLE cash_advances ADD COLUMN ${colName} ${colDef}`);
      }
    }
  } else {
    const col = await db.queryOne<{ cnt: number }>(
      `SELECT COUNT(*) AS cnt
       FROM INFORMATION_SCHEMA.COLUMNS
       WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'regions' AND COLUMN_NAME = 'manager_user_id'`
    );
    if (!col || Number(col.cnt) === 0) {
      await db.execute('ALTER TABLE regions ADD COLUMN manager_user_id BIGINT NULL AFTER name');
    }
    const rSortCol = await db.queryOne<{ cnt: number }>(
      `SELECT COUNT(*) AS cnt
       FROM INFORMATION_SCHEMA.COLUMNS
       WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'regions' AND COLUMN_NAME = 'sort_order'`
    );
    if (!rSortCol || Number(rSortCol.cnt) === 0) {
      await db.execute('ALTER TABLE regions ADD COLUMN sort_order INT NOT NULL DEFAULT 0 AFTER manager_user_id');
      await db.execute('UPDATE regions SET sort_order = id WHERE sort_order = 0');
    }
    for (const [colName, colDef] of [
      ['payment_type', `VARCHAR(24) NOT NULL DEFAULT 'PERSONAL'`],
      ['returned_to_step', 'INT NULL'],
      ['returned_to_user_id', 'BIGINT NULL'],
      ['returned_to_role', 'VARCHAR(32) NULL'],
      ['returned_from_step', 'INT NULL'],
      ['return_reason', 'VARCHAR(500) NULL'],
      ['urgency', `VARCHAR(16) NOT NULL DEFAULT 'NORMAL'`],
      ['payment_fail_reason', 'VARCHAR(255) NULL'],
      ['payment_attempts', 'INT NOT NULL DEFAULT 0'],
    ] as const) {
      const c = await db.queryOne<{ cnt: number }>(
        `SELECT COUNT(*) AS cnt
         FROM INFORMATION_SCHEMA.COLUMNS
         WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'reimbursements' AND COLUMN_NAME = ?`,
        [colName]
      );
      if (!c || Number(c.cnt) === 0) {
        await db.execute(`ALTER TABLE reimbursements ADD COLUMN ${colName} ${colDef}`);
      }
    }
    for (const tbl of ['cash_advances', 'leave_requests'] as const) {
      const c = await db.queryOne<{ cnt: number }>(
        `SELECT COUNT(*) AS cnt
         FROM INFORMATION_SCHEMA.COLUMNS
         WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ? AND COLUMN_NAME = 'urgency'`,
        [tbl]
      );
      if (!c || Number(c.cnt) === 0) {
        await db.execute(`ALTER TABLE ${tbl} ADD COLUMN urgency VARCHAR(16) NOT NULL DEFAULT 'NORMAL'`);
      }
    }
    for (const [tbl, colName, colDef] of [
      ['hotels', 'city_id', 'BIGINT NULL'],
      ['hotels', 'district_id', 'BIGINT NULL'],
      ['hotels', 'district', 'VARCHAR(64) NULL'],
      ['employees', 'position_id', 'BIGINT NULL'],
      ['employees', 'education', 'VARCHAR(32) NULL'],
      ['employees', 'marital_status', 'VARCHAR(24) NULL'],
      ['employees', 'political_status', 'VARCHAR(24) NULL'],
      ['users', 'must_change_password', 'TINYINT(1) NOT NULL DEFAULT 0'],
      ['users', 'password_changed_at', 'VARCHAR(32) NULL'],
      ['approval_steps', 'delegated_from_user_id', 'BIGINT NULL'],
      ['approval_steps', 'skip_reason', 'VARCHAR(255) NULL'],
      ['cash_advances', 'repaid_amount', 'DECIMAL(12,2) NOT NULL DEFAULT 0.00'],
      ['cash_advances', 'payee_name', 'VARCHAR(80) NULL'],
      ['cash_advances', 'payee_bank', 'VARCHAR(120) NULL'],
      ['cash_advances', 'payee_account', 'VARCHAR(64) NULL'],
      ['employees', 'probation_salary_ratio', 'DECIMAL(4,2) NOT NULL DEFAULT 1.00'],
      ['employees', 'resign_date', 'VARCHAR(16) NULL'],
      ['payroll_records', 'prorated_days', 'DECIMAL(6,2) NOT NULL DEFAULT 0.00'],
      ['payroll_records', 'total_month_days', 'INT NOT NULL DEFAULT 30'],
      ['payroll_records', 'other_allowance', 'DECIMAL(12,2) NOT NULL DEFAULT 0.00'],
      ['payroll_records', 'advance_deduction', 'DECIMAL(12,2) NOT NULL DEFAULT 0.00'],
      ['payroll_records', 'other_deduction', 'DECIMAL(12,2) NOT NULL DEFAULT 0.00'],
      ['payroll_records', 'is_resigned_settlement', 'TINYINT(1) NOT NULL DEFAULT 0'],
      ['offboarding_requests', 'effective_executed_at', 'VARCHAR(32) NULL'],
      ['offboarding_requests', 'settlement_status', "VARCHAR(24) NOT NULL DEFAULT 'PENDING'"],
      ['offboarding_requests', 'unsettled_advance_amount', 'DECIMAL(12,2) NOT NULL DEFAULT 0.00'],
      ['offboarding_requests', 'pending_reimbursement_count', 'INT NOT NULL DEFAULT 0'],
      ['offboarding_requests', 'handover_to_user_id', 'BIGINT NULL'],
      ['offboarding_requests', 'scheduled_execute', 'TINYINT(1) NOT NULL DEFAULT 0'],
      ['employees', 'special_additional_deduction', 'DECIMAL(12,2) NOT NULL DEFAULT 0.00'],
      ['payroll_records', 'city_ss_base', 'DECIMAL(12,2) NOT NULL DEFAULT 0.00'],
      ['payroll_records', 'special_deduction', 'DECIMAL(12,2) NOT NULL DEFAULT 0.00'],
      ['payroll_records', 'taxable_income', 'DECIMAL(12,2) NOT NULL DEFAULT 0.00'],
      ['payroll_records', 'ytd_taxable_income', 'DECIMAL(12,2) NOT NULL DEFAULT 0.00'],
      ['payroll_records', 'ytd_tax_paid', 'DECIMAL(12,2) NOT NULL DEFAULT 0.00'],
      ['payroll_records', 'income_tax', 'DECIMAL(12,2) NOT NULL DEFAULT 0.00'],
    ] as const) {
      const c = await db.queryOne<{ cnt: number }>(
        `SELECT COUNT(*) AS cnt
         FROM INFORMATION_SCHEMA.COLUMNS
         WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ? AND COLUMN_NAME = ?`,
        [tbl, colName]
      );
      if (!c || Number(c.cnt) === 0) {
        await db.execute(`ALTER TABLE ${tbl} ADD COLUMN ${colName} ${colDef}`);
      }
    }
  }

  // T1-02: Backfill approver_user_id on any existing PENDING approval_steps missing concrete approver
  const nullPendingSteps = await db.query<{
    id: number;
    biz_type: string;
    biz_id: number;
    approver_role: string;
  }>(`SELECT id, biz_type, biz_id, approver_role FROM approval_steps WHERE status = 'PENDING' AND approver_user_id IS NULL`);
  for (const st of nullPendingSteps) {
    let hotelId: number | null = null;
    if (st.biz_type === 'REIMBURSEMENT') {
      hotelId = (await db.queryOne<{ hotel_id: number }>('SELECT hotel_id FROM reimbursements WHERE id = ?', [st.biz_id]))?.hotel_id ?? null;
    } else if (st.biz_type === 'CASH_ADVANCE') {
      hotelId = (await db.queryOne<{ hotel_id: number }>('SELECT hotel_id FROM cash_advances WHERE id = ?', [st.biz_id]))?.hotel_id ?? null;
    } else if (st.biz_type === 'HEADCOUNT') {
      hotelId = (await db.queryOne<{ hotel_id: number }>('SELECT hotel_id FROM headcount_requests WHERE id = ?', [st.biz_id]))?.hotel_id ?? null;
    } else if (st.biz_type === 'LEAVE') {
      hotelId = (await db.queryOne<{ hotel_id: number }>('SELECT hotel_id FROM leave_requests WHERE id = ?', [st.biz_id]))?.hotel_id ?? null;
    }
    if (!hotelId) continue;
    let uid: number | null = null;
    if (st.approver_role === 'STORE_MANAGER') {
      uid = (await db.queryOne<{ id: number }>(`SELECT id FROM users WHERE role = 'STORE_MANAGER' AND hotel_id = ? AND is_active = 1 ORDER BY id ASC LIMIT 1`, [hotelId]))?.id ?? null;
    } else if (st.approver_role === 'REGIONAL_MANAGER') {
      const reg = await db.queryOne<{ id: number; manager_user_id: number | null }>(`SELECT r.id, r.manager_user_id FROM hotels h JOIN regions r ON r.id = h.region_id WHERE h.id = ?`, [hotelId]);
      uid = reg?.manager_user_id ?? (reg?.id ? (await db.queryOne<{ id: number }>(`SELECT id FROM users WHERE role = 'REGIONAL_MANAGER' AND region_id = ? AND is_active = 1 ORDER BY id ASC LIMIT 1`, [reg.id]))?.id ?? null : null);
    } else {
      uid = (await db.queryOne<{ id: number }>(`SELECT id FROM users WHERE role = ? AND is_active = 1 ORDER BY id ASC LIMIT 1`, [st.approver_role]))?.id ?? null;
    }
    if (uid) {
      await db.execute('UPDATE approval_steps SET approver_user_id = ? WHERE id = ?', [uid, st.id]);
    }
  }
}

async function main() {
  const client = isDemoMode() ? 'sqlite' : (process.env.DB_CLIENT || 'mysql').toLowerCase();
  if (client === 'mysql') {
    await ensureMysqlDatabase({
      host: process.env.DB_HOST || '127.0.0.1',
      port: Number(process.env.DB_PORT || 3306),
      user: process.env.DB_USER || 'hotel_ops',
      password: process.env.DB_PASSWORD || 'hotel_ops_pass',
      database: process.env.DB_NAME || 'hotel_manage',
    });
  }
  const db = createDbAdapterFromEnv();
  try {
    await initSchema(db);
    console.log(`[db:init] Schema initialized successfully (${db.dialect})`);
  } finally {
    await db.close();
  }
}

if (require.main === module) {
  main().catch((err) => {
    console.error('[db:init] Failed:', err);
    process.exit(1);
  });
}
