import crypto from 'node:crypto';
import { z } from 'zod';

export const isoDateSchema = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, '日期格式须为 YYYY-MM-DD');

export function roundMoney(val: number): number {
  return Math.round((Number(val) + Number.EPSILON) * 100) / 100;
}

const BEIJING_OFFSET_MS = 8 * 60 * 60 * 1000;

function beijingNow(): Date {
  return new Date(Date.now() + BEIJING_OFFSET_MS);
}

export function nowIso(): string {
  return beijingNow().toISOString().replace('T', ' ').slice(0, 19);
}

export function todayStr(): string {
  return beijingNow().toISOString().slice(0, 10);
}

export function addDays(baseDateStr: string, days: number): string {
  const d = new Date(`${baseDateStr}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

export function currentYearMonth(): string {
  return beijingNow().toISOString().slice(0, 7);
}

export function offsetYearMonth(baseYm: string, deltaMonths: number): string {
  const [y, m] = baseYm.split('-').map(Number);
  const d = new Date(y, m - 1 + deltaMonths, 1);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
}

export function getMondayOfCurrentWeek(): string {
  const d = new Date();
  const day = d.getDay();
  const diff = day === 0 ? -6 : 1 - day;
  d.setDate(d.getDate() + diff);
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const dd = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${dd}`;
}

export function generateCode(prefix: string): string {
  const d = new Date();
  const ym = `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, '0')}${String(d.getDate()).padStart(2, '0')}`;
  const rand = crypto.randomBytes(4).toString('hex').toUpperCase();
  return `${prefix}-${ym}-${rand}`;
}

export function randomTokenSuffix(bytes = 4): string {
  return crypto.randomBytes(bytes).toString('hex').toUpperCase();
}

export function generateTempPassword(): string {
  return `Yq!${crypto.randomBytes(6).toString('base64url')}`;
}
