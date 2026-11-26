import fs from 'node:fs';
import path from 'node:path';
import dotenv from 'dotenv';
import { DbAdapter } from './adapter';
import { createDbAdapterFromEnv } from './index';
import { ensureMysqlDatabase } from './mysqlAdapter';

dotenv.config({ path: path.resolve(__dirname, '../../.env') });

export async function initSchema(db: DbAdapter): Promise<void> {
  const schemaFile =
    db.dialect === 'mysql'
      ? path.resolve(__dirname, 'mysql/schema.sql')
      : path.resolve(__dirname, 'sqlite/schema.sql');
  const sql = fs.readFileSync(schemaFile, 'utf8');
  await db.execScript(sql);
}

async function main() {
  const client = (process.env.DB_CLIENT || 'mysql').toLowerCase();
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
