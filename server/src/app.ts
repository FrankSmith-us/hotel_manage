import fs from 'node:fs';
import path from 'node:path';
import cors from 'cors';
import express from 'express';
import { getDb } from '../db';
import { env } from './config/env';
import { AppError, asyncHandler, authenticate, canAccessHotel } from './middleware/auth';
import { errorHandler } from './middleware/errorHandler';
import { UPLOADS_DIR } from './middleware/upload';
import { hasUserActedOnBiz } from './services/workflowEngine';
import advancesRouter from './routes/advances';
import authRouter from './routes/auth';
import budgetsRouter from './routes/budgets';
import dashboardRouter from './routes/dashboard';
import employeesRouter from './routes/employees';
import leavesRouter from './routes/leaves';
import masterDataRouter from './routes/masterData';
import organizationRouter from './routes/organization';
import payrollRouter from './routes/payroll';
import recruitmentRouter from './routes/recruitment';
import reimbursementsRouter from './routes/reimbursements';
import reportsRouter from './routes/reports';
import schedulesRouter from './routes/schedules';

export function createApp() {
  const app = express();

  app.use(
    cors({
      origin: env.corsOrigins.length > 0 ? env.corsOrigins : true,
      credentials: false,
    })
  );
  app.use(express.json({ limit: '5mb' }));
  app.use(express.urlencoded({ extended: true }));

  // Authenticated attachment download & built-in seed assets
  app.get(
    '/uploads/:filename',
    authenticate,
    asyncHandler(async (req, res) => {
      const filename = String(req.params.filename || '');
      if (!/^[a-zA-Z0-9._-]+$/.test(filename)) {
        throw new AppError(400, '无效的文件名');
      }
      const resolved = path.resolve(UPLOADS_DIR, filename);
      if (!resolved.startsWith(UPLOADS_DIR + path.sep) || !fs.existsSync(resolved)) {
        throw new AppError(404, '附件不存在');
      }

      const db = getDb();
      const user = req.user!;
      const linked = await db.queryOne<{ reimbursement_id: number; applicant_id: number; hotel_id: number }>(
        `SELECT r.id AS reimbursement_id, r.applicant_id, r.hotel_id
         FROM reimbursement_items ri
         JOIN reimbursements r ON r.id = ri.reimbursement_id
         WHERE ri.attachment_url = ?
         LIMIT 1`,
        [`/uploads/${filename}`]
      );

      if (linked) {
        const isOwner = Number(linked.applicant_id) === Number(user.id);
        const hasAccess = await canAccessHotel(user, linked.hotel_id);
        const hasActed = await hasUserActedOnBiz(db, 'REIMBURSEMENT', linked.reimbursement_id, user.id);
        if (
          !isOwner &&
          !hasAccess &&
          !hasActed &&
          !['FINANCE', 'HQ_ADMIN', 'GENERAL_MANAGER'].includes(user.role)
        ) {
          throw new AppError(403, '无权查看此报销凭证');
        }
      }

      res.setHeader('X-Content-Type-Options', 'nosniff');
      res.setHeader('Content-Security-Policy', "default-src 'none'");
      res.setHeader('Cache-Control', 'private, max-age=300');
      res.sendFile(resolved);
    })
  );
  app.use('/seed-assets', express.static(path.resolve(__dirname, '../seed-assets')));

  app.get('/api/health', (_req, res) => {
    res.json({ ok: true, service: 'yueqi-hotel-ops', db: getDb().dialect });
  });

  app.use('/api/auth', authRouter);
  app.use('/api/master-data', masterDataRouter);
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
