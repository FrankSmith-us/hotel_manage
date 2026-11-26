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
    const rCols = await db.query<{ name: string }>('PRAGMA table_info(reimbursements)');
    if (!rCols.some((c) => c.name === 'payment_type')) {
      await db.execute(`ALTER TABLE reimbursements ADD COLUMN payment_type TEXT NOT NULL DEFAULT 'PERSONAL'`);
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
    const rCol = await db.queryOne<{ cnt: number }>(
      `SELECT COUNT(*) AS cnt
       FROM INFORMATION_SCHEMA.COLUMNS
       WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'reimbursements' AND COLUMN_NAME = 'payment_type'`
    );
    if (!rCol || Number(rCol.cnt) === 0) {
      await db.execute(
        `ALTER TABLE reimbursements ADD COLUMN payment_type VARCHAR(24) NOT NULL DEFAULT 'PERSONAL' AFTER remarks`
      );
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
