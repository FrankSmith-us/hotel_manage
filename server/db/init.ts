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
    ] as const) {
      if (!eCols.has(colName)) {
        await db.execute(`ALTER TABLE employees ADD COLUMN ${colName} ${colDef}`);
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
