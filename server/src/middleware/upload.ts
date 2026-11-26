import fs from 'node:fs';
import path from 'node:path';
import multer from 'multer';
import { AppError } from './auth';

export const UPLOADS_DIR = path.resolve(__dirname, '../../uploads');
if (!fs.existsSync(UPLOADS_DIR)) {
  fs.mkdirSync(UPLOADS_DIR, { recursive: true });
}

const ALLOWED_EXT = new Set(['.png', '.jpg', '.jpeg', '.webp', '.pdf']);

export function validateUploadedFileMagic(filePath: string, ext: string): boolean {
  const fd = fs.openSync(filePath, 'r');
  try {
    const buf = Buffer.alloc(12);
    const bytesRead = fs.readSync(fd, buf, 0, 12, 0);
    if (bytesRead < 4) return false;
    if (ext === '.png') {
      return buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47;
    }
    if (ext === '.jpg' || ext === '.jpeg') {
      return buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff;
    }
    if (ext === '.pdf') {
      return buf.subarray(0, 4).toString('ascii') === '%PDF';
    }
    if (ext === '.webp') {
      return (
        bytesRead >= 12 &&
        buf.subarray(0, 4).toString('ascii') === 'RIFF' &&
        buf.subarray(8, 12).toString('ascii') === 'WEBP'
      );
    }
    return false;
  } finally {
    fs.closeSync(fd);
  }
}

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
