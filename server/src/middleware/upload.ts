import fs from 'node:fs';
import path from 'node:path';
import multer from 'multer';
import { AppError } from './auth';

export const UPLOADS_DIR = path.resolve(__dirname, '../../uploads');
if (!fs.existsSync(UPLOADS_DIR)) {
  fs.mkdirSync(UPLOADS_DIR, { recursive: true });
}

const ALLOWED_EXT = new Set(['.png', '.jpg', '.jpeg', '.webp', '.pdf', '.svg']);

const storage = multer.diskStorage({
  destination: (_req, _file, cb) => {
    cb(null, UPLOADS_DIR);
  },
  filename: (_req, file, cb) => {
    const ext = path.extname(file.originalname).toLowerCase();
    const unique = `${Date.now()}-${Math.round(Math.random() * 1e6)}${ext}`;
    cb(null, unique);
  },
});

export const uploadInvoiceMiddleware = multer({
  storage,
  limits: { fileSize: 10 * 1024 * 1024 },
  fileFilter: (_req, file, cb) => {
    const ext = path.extname(file.originalname).toLowerCase();
    if (!ALLOWED_EXT.has(ext)) {
      cb(new AppError(400, '仅支持 PNG、JPG、WEBP、PDF 格式的发票或凭证附件'));
      return;
    }
    cb(null, true);
  },
});
