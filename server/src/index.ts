import { closeDb, getDb } from '../db';
import { initSchema } from '../db/init';
import { seedDatabase } from '../db/seed';
import { createApp } from './app';
import { env, validateRuntimeSecurity } from './config/env';
import { startScheduler } from './services/schedulerService';

async function bootstrap() {
  validateRuntimeSecurity();
  const db = getDb();
  if (db.dialect === 'sqlite') {
    await initSchema(db);
    await seedDatabase(db);
  }

  startScheduler(() => getDb());
  const app = createApp();
  const server = app.listen(env.port, () => {
    console.log(`[YueQi Ops API] Running on http://127.0.0.1:${env.port} (DB: ${db.dialect})`);
  });

  const shutdown = async () => {
    server.close();
    await closeDb();
    process.exit(0);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

bootstrap().catch((err) => {
  console.error('[YueQi Ops API] Failed to start:', err);
  process.exit(1);
});
