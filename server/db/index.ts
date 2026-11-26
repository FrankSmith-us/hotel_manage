import path from 'node:path';
import dotenv from 'dotenv';
import { DbAdapter } from './adapter';
import { MysqlAdapter } from './mysqlAdapter';
import { SqliteAdapter } from './sqliteAdapter';

dotenv.config({ path: path.resolve(__dirname, '../../.env') });

let singletonDb: DbAdapter | null = null;

export function createDbAdapterFromEnv(): DbAdapter {
  const client = (process.env.DB_CLIENT || 'mysql').toLowerCase();
  if (client === 'sqlite') {
    const sqlitePath = process.env.SQLITE_PATH || './data/hotel_manage.db';
    const resolved = sqlitePath === ':memory:' ? ':memory:' : path.resolve(__dirname, '..', sqlitePath);
    return new SqliteAdapter(resolved);
  }
  return new MysqlAdapter({
    host: process.env.DB_HOST || '127.0.0.1',
    port: Number(process.env.DB_PORT || 3306),
    user: process.env.DB_USER || 'hotel_ops',
    password: process.env.DB_PASSWORD || 'hotel_ops_pass',
    database: process.env.DB_NAME || 'hotel_manage',
  });
}

export function getDb(): DbAdapter {
  if (!singletonDb) {
    singletonDb = createDbAdapterFromEnv();
  }
  return singletonDb;
}

export function setDb(db: DbAdapter): void {
  singletonDb = db;
}

export async function closeDb(): Promise<void> {
  if (singletonDb) {
    await singletonDb.close();
    singletonDb = null;
  }
}
