import mysql, { Pool, PoolConnection, ResultSetHeader, RowDataPacket } from 'mysql2/promise';
import { DbAdapter, DbQueryRunner, ExecuteResult } from './adapter';

export interface MysqlConfig {
  host: string;
  port: number;
  user: string;
  password: string;
  database: string;
}

class MysqlRunner implements DbQueryRunner {
  public readonly dialect = 'mysql' as const;

  constructor(private readonly executor: Pool | PoolConnection) {}

  async query<T = Record<string, unknown>>(sql: string, params: unknown[] = []): Promise<T[]> {
    const [rows] = await this.executor.query<RowDataPacket[]>(sql, params);
    return rows as unknown as T[];
  }

  async queryOne<T = Record<string, unknown>>(sql: string, params: unknown[] = []): Promise<T | null> {
    const rows = await this.query<T>(sql, params);
    return rows.length > 0 ? rows[0] : null;
  }

  async execute(sql: string, params: unknown[] = []): Promise<ExecuteResult> {
    const [result] = await this.executor.query<ResultSetHeader>(sql, params);
    return {
      insertId: Number(result.insertId || 0),
      affectedRows: Number(result.affectedRows || 0),
    };
  }

  forUpdateSuffix(): string {
    return ' FOR UPDATE';
  }
}

export class MysqlAdapter extends MysqlRunner implements DbAdapter {
  private readonly pool: Pool;

  constructor(private readonly config: MysqlConfig) {
    const pool = mysql.createPool({
      host: config.host,
      port: config.port,
      user: config.user,
      password: config.password,
      database: config.database,
      waitForConnections: true,
      connectionLimit: 10,
      decimalNumbers: true,
      charset: 'utf8mb4',
      multipleStatements: true,
    });
    super(pool);
    this.pool = pool;
  }

  async transaction<T>(fn: (tx: DbQueryRunner) => Promise<T>): Promise<T> {
    const conn = await this.pool.getConnection();
    try {
      await conn.beginTransaction();
      const runner = new MysqlRunner(conn);
      const result = await fn(runner);
      await conn.commit();
      return result;
    } catch (err) {
      await conn.rollback();
      throw err;
    } finally {
      conn.release();
    }
  }

  async execScript(sql: string): Promise<void> {
    await this.pool.query(sql);
  }

  async close(): Promise<void> {
    await this.pool.end();
  }
}

export async function ensureMysqlDatabase(config: MysqlConfig): Promise<void> {
  const conn = await mysql.createConnection({
    host: config.host,
    port: config.port,
    user: config.user,
    password: config.password,
    charset: 'utf8mb4',
  });
  try {
    await conn.query(
      `CREATE DATABASE IF NOT EXISTS \`${config.database.replace(/`/g, '')}\` CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci`
    );
  } finally {
    await conn.end();
  }
}
