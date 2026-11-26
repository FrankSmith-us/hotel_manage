import path from 'node:path';
import dotenv from 'dotenv';

dotenv.config({ path: path.resolve(__dirname, '../../../.env') });

const isDemoMode = process.argv.includes('--demo');
if (isDemoMode) {
  process.env.DB_CLIENT = 'sqlite';
  process.env.DEMO_ROLE_SWITCH = 'true';
}

const DEFAULT_INSECURE_SECRETS = new Set([
  'yueqi-hotel-ops-dev-secret-2026',
  'change-this-secret-in-production',
]);

export function isDemoSwitchEnabled(): boolean {
  if ((process.env.NODE_ENV || '').toLowerCase() === 'production') {
    return false;
  }
  return (process.env.DEMO_ROLE_SWITCH || 'false').toLowerCase() === 'true';
}

export function validateRuntimeSecurity(): void {
  const isProd = (process.env.NODE_ENV || '').toLowerCase() === 'production';
  const dbClient = (process.env.DB_CLIENT || 'mysql').toLowerCase();
  const requireStrongSecret = isProd || (dbClient === 'mysql' && !isDemoMode);

  if (requireStrongSecret) {
    const rawSecret = (process.env.JWT_SECRET || '').trim();
    if (!rawSecret || rawSecret.length < 16 || DEFAULT_INSECURE_SECRETS.has(rawSecret)) {
      throw new Error(
        '[Security] Production/MySQL mode requires a strong JWT_SECRET (>= 16 chars, not the example placeholder).'
      );
    }
  }
}

export const env = {
  port: Number(process.env.PORT || 3001),
  jwtSecret: process.env.JWT_SECRET || 'yueqi-hotel-ops-dev-secret-2026',
  get demoRoleSwitch(): boolean {
    return isDemoSwitchEnabled();
  },
  dbClient: (process.env.DB_CLIENT || 'mysql').toLowerCase() as 'mysql' | 'sqlite',
  corsOrigins: (process.env.CORS_ORIGINS || '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean),
};
