import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync, SQLInputValue } from 'node:sqlite';
import { DbAdapter, DbQueryRunner, ExecuteResult } from './adapter';

function normalizeParam(val: unknown): SQLInputValue {
  if (val === undefined) return null;
  if (typeof val === 'boolean') return val ? 1 : 0;
  return val as SQLInputValue;
}

export class SqliteAdapter implements DbAdapter {
  public readonly dialect = 'sqlite' as const;
  private readonly db: DatabaseSync;

  constructor(dbPath: string) {
    if (dbPath !== ':memory:') {
      const dir = path.dirname(path.resolve(dbPath));
      if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
      }
    }
    this.db = new DatabaseSync(dbPath);
    this.db.exec('PRAGMA foreign_keys = ON;');
    if (dbPath !== ':memory:') {
      this.db.exec('PRAGMA journal_mode = WAL;');
    }
  }

  async query<T = Record<string, unknown>>(sql: string, params: unknown[] = []): Promise<T[]> {
    const stmt = this.db.prepare(sql);
    const normalized = params.map(normalizeParam);
    const rows = stmt.all(...normalized) as Record<string, unknown>[];
    return rows.map((row) => ({ ...row }) as T);
  }

  async queryOne<T = Record<string, unknown>>(sql: string, params: unknown[] = []): Promise<T | null> {
    const stmt = this.db.prepare(sql);
    const normalized = params.map(normalizeParam);
    const row = stmt.get(...normalized) as Record<string, unknown> | undefined;
    return row ? ({ ...row } as T) : null;
  }

  async execute(sql: string, params: unknown[] = []): Promise<ExecuteResult> {
    const stmt = this.db.prepare(sql);
    const normalized = params.map(normalizeParam);
    const res = stmt.run(...normalized);
    return {
      insertId: Number(res.lastInsertRowid ?? 0),
      affectedRows: Number(res.changes ?? 0),
    };
  }

  forUpdateSuffix(): string {
    return '';
  }

  async transaction<T>(fn: (tx: DbQueryRunner) => Promise<T>): Promise<T> {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const result = await fn(this);
      this.db.exec('COMMIT');
      return result;
    } catch (err) {
      try {
        this.db.exec('ROLLBACK');
      } catch {
        // ignore rollback error if already rolled back
      }
      throw err;
    }
  }

  async execScript(sql: string): Promise<void> {
    this.db.exec(sql);
  }

  async close(): Promise<void> {
    this.db.close();
  }
}
