import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import express from 'express';
import multer from 'multer';
import { badRequest } from '../http/errors.js';

const PUBLIC_PREFIX = '/media';

// 업로드 영상 파일의 저장·삭제·서빙을 한 곳에서 다룬다.
// DB에는 여기서 정한 파일명(location)만 남기고, 재생 주소는 publicUrl 로 만든다.
export function createVideoStorage({ uploadDir, maxUploadBytes }) {
  fs.mkdirSync(uploadDir, { recursive: true });

  const upload = multer({
    storage: multer.diskStorage({
      destination: uploadDir,
      filename: (_req, file, cb) => {
        const ext = path.extname(file.originalname).toLowerCase().replace(/[^.a-z0-9]/g, '');
        cb(null, `${Date.now()}-${crypto.randomUUID()}${ext}`);
      },
    }),
    limits: { fileSize: maxUploadBytes, files: 1 },
    fileFilter: (_req, file, cb) => {
      if (file.mimetype.startsWith('video/')) return cb(null, true);
      cb(badRequest('영상 파일(video/*)만 업로드할 수 있습니다.'));
    },
  });

  return {
    publicPrefix: PUBLIC_PREFIX,

    // multipart 요청에서 영상 파일 하나를 받아 req.file 에 둔다.
    acceptSingle(fieldName) {
      const handle = upload.single(fieldName);
      return (req, res, next) => handle(req, res, (err) => next(toHttpError(err, maxUploadBytes)));
    },

    // express.static 이 Range 요청을 처리하므로 플레이어에서 탐색(seek)이 된다.
    serve() {
      return express.static(uploadDir, { index: false, fallthrough: false });
    },

    publicUrl(location) {
      return `${PUBLIC_PREFIX}/${encodeURIComponent(location)}`;
    },

    remove(location) {
      fs.rm(path.join(uploadDir, path.basename(location)), { force: true }, () => {});
    },
  };
}

function toHttpError(err, maxUploadBytes) {
  if (!(err instanceof multer.MulterError)) return err;
  if (err.code === 'LIMIT_FILE_SIZE') {
    return badRequest(`파일이 너무 큽니다. 최대 ${Math.floor(maxUploadBytes / 1024 / 1024)}MB까지 업로드할 수 있습니다.`);
  }
  return badRequest(`업로드 오류: ${err.message}`);
}
