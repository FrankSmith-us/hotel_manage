import fs from 'node:fs';
import path from 'node:path';
import cors from 'cors';
import express from 'express';
import { getDb } from '../db';
import { errorHandler } from './middleware/errorHandler';
import { UPLOADS_DIR } from './middleware/upload';
import advancesRouter from './routes/advances';
import authRouter from './routes/auth';
import budgetsRouter from './routes/budgets';
import dashboardRouter from './routes/dashboard';
import employeesRouter from './routes/employees';
import leavesRouter from './routes/leaves';
import organizationRouter from './routes/organization';
import payrollRouter from './routes/payroll';
import recruitmentRouter from './routes/recruitment';
import reimbursementsRouter from './routes/reimbursements';
import reportsRouter from './routes/reports';
import schedulesRouter from './routes/schedules';

export function createApp() {
  const app = express();

  app.use(cors());
  app.use(express.json({ limit: '5mb' }));
  app.use(express.urlencoded({ extended: true }));

  // Static invoice uploads & seed sample assets
  app.use('/uploads', express.static(UPLOADS_DIR));
  app.use('/seed-assets', express.static(path.resolve(__dirname, '../seed-assets')));

  app.get('/api/health', (_req, res) => {
    res.json({ ok: true, service: 'yueqi-hotel-ops', db: getDb().dialect });
  });

  app.use('/api/auth', authRouter);
  app.use('/api/dashboard', dashboardRouter);
  app.use('/api/organization', organizationRouter);
  app.use('/api/employees', employeesRouter);
  app.use('/api/schedules', schedulesRouter);
  app.use('/api/leaves', leavesRouter);
  app.use('/api/payroll', payrollRouter);
  app.use('/api/recruitment', recruitmentRouter);
  app.use('/api/budgets', budgetsRouter);
  app.use('/api/advances', advancesRouter);
  app.use('/api/reimbursements', reimbursementsRouter);
  app.use('/api/reports', reportsRouter);

  // Serve built frontend in production if present
  const clientDist = path.resolve(__dirname, '../../client/dist');
  if (fs.existsSync(clientDist)) {
    app.use(express.static(clientDist));
    app.get('*', (req, res, next) => {
      if (req.path.startsWith('/api/')) return next();
      res.sendFile(path.join(clientDist, 'index.html'));
    });
  }

  app.use(errorHandler);
  return app;
}
