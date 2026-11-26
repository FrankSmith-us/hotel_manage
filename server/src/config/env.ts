import path from 'node:path';
import dotenv from 'dotenv';

dotenv.config({ path: path.resolve(__dirname, '../../../.env') });

export const env = {
  port: Number(process.env.PORT || 3001),
  jwtSecret: process.env.JWT_SECRET || 'yueqi-hotel-ops-dev-secret-2026',
  demoRoleSwitch: (process.env.DEMO_ROLE_SWITCH || 'true').toLowerCase() === 'true',
  dbClient: (process.env.DB_CLIENT || 'mysql').toLowerCase() as 'mysql' | 'sqlite',
};
