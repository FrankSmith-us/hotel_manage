export type DbDialect = 'mysql' | 'sqlite';

export interface ExecuteResult {
  insertId: number;
  affectedRows: number;
}

export interface DbQueryRunner {
  dialect: DbDialect;
  query<T = Record<string, unknown>>(sql: string, params?: unknown[]): Promise<T[]>;
  queryOne<T = Record<string, unknown>>(sql: string, params?: unknown[]): Promise<T | null>;
  execute(sql: string, params?: unknown[]): Promise<ExecuteResult>;
  forUpdateSuffix(): string;
}

export interface DbAdapter extends DbQueryRunner {
  transaction<T>(fn: (tx: DbQueryRunner) => Promise<T>): Promise<T>;
  execScript(sql: string): Promise<void>;
  close(): Promise<void>;
}
