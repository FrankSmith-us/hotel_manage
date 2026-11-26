import { NextFunction, Request, Response } from 'express';
import { MulterError } from 'multer';
import { ZodError } from 'zod';
import { AppError } from './auth';

export function errorHandler(err: unknown, _req: Request, res: Response, _next: NextFunction) {
  if (err instanceof AppError) {
    res.status(err.statusCode).json({
      error: err.message,
      details: err.details,
    });
    return;
  }

  if (err instanceof ZodError) {
    res.status(400).json({
      error: '请求参数校验失败',
      details: err.errors.map((e) => `${e.path.join('.')}: ${e.message}`),
    });
    return;
  }

  if (err instanceof MulterError) {
    res.status(400).json({
      error: err.code === 'LIMIT_FILE_SIZE' ? '附件大小不能超过 10MB' : `文件上传失败: ${err.message}`,
    });
    return;
  }

  const errCode = err && typeof err === 'object' && 'code' in err ? String((err as { code?: unknown }).code) : '';
  if (
    errCode === 'ECONNREFUSED' ||
    errCode === 'ER_ACCESS_DENIED_ERROR' ||
    errCode === 'ER_BAD_DB_ERROR' ||
    errCode === 'ETIMEDOUT'
  ) {
    res.status(503).json({
      error: `数据库连接失败 (${errCode})：请确认 MySQL 服务已启动，或使用 npm run dev:demo 启动本地免安装演示模式`,
    });
    return;
  }

  const msg = err instanceof Error ? err.message : '服务器内部错误';
  if (
    errCode === 'ER_DUP_ENTRY' ||
    errCode === 'SQLITE_CONSTRAINT_UNIQUE' ||
    (errCode === 'ERR_SQLITE_ERROR' && msg.includes('UNIQUE constraint failed'))
  ) {
    res.status(409).json({ error: '数据记录已存在或编号重复' });
    return;
  }

  console.error('[Unhandled Error]', err);
  res.status(500).json({ error: '服务器内部错误，请稍后重试' });
}
