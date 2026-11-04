import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import express from 'express';
import multer from 'multer';

const TITLE_MAX = 100;
const DESCRIPTION_MAX = 2000;

// 인증 없이 누구나 등록·조회할 수 있는 녹화방송 API + 정적 화면.
export function createApp({ db, config }) {
  fs.mkdirSync(config.uploadDir, { recursive: true });

  const upload = multer({
    storage: multer.diskStorage({
      destination: config.uploadDir,
      filename: (_req, file, cb) => {
        const ext = path.extname(file.originalname).toLowerCase().replace(/[^.a-z0-9]/g, '');
        cb(null, `${Date.now()}-${crypto.randomUUID()}${ext}`);
      },
    }),
    limits: { fileSize: config.maxUploadBytes, files: 1 },
    fileFilter: (_req, file, cb) => {
      if (file.mimetype.startsWith('video/')) return cb(null, true);
      cb(new HttpError(400, '영상 파일(video/*)만 업로드할 수 있습니다.'));
    },
  });

  const app = express();
  app.disable('x-powered-by');

  app.get('/api/broadcasts', (_req, res) => {
    res.json(db.listBroadcasts().map((row) => toDto(row)));
  });

  app.get('/api/broadcasts/:id', (req, res) => {
    const id = Number(req.params.id);
    const row = Number.isInteger(id) && id > 0 ? db.getBroadcast(id) : undefined;
    if (!row) return res.status(404).json({ error: '방송을 찾을 수 없습니다.' });
    res.json(toDto(row));
  });

  // multipart/form-data: title(필수), description(선택), 그리고 videoFile 또는 videoUrl 중 하나
  app.post('/api/broadcasts', upload.single('videoFile'), (req, res) => {
    const file = req.file;
    try {
      const title = String(req.body.title ?? '').trim();
      const description = String(req.body.description ?? '').trim();
      const videoUrl = String(req.body.videoUrl ?? '').trim();

      if (!title) throw new HttpError(400, '제목을 입력해 주세요.');
      if (title.length > TITLE_MAX) throw new HttpError(400, `제목은 ${TITLE_MAX}자 이하여야 합니다.`);
      if (description.length > DESCRIPTION_MAX) {
        throw new HttpError(400, `설명은 ${DESCRIPTION_MAX}자 이하여야 합니다.`);
      }
      if (file && videoUrl) throw new HttpError(400, '영상 파일과 영상 URL 중 하나만 입력해 주세요.');
      if (!file && !videoUrl) throw new HttpError(400, '영상 파일을 업로드하거나 영상 URL을 입력해 주세요.');

      const row = file
        ? db.createBroadcast({
            title,
            description,
            sourceType: 'upload',
            videoLocation: file.filename,
            mimeType: file.mimetype,
            fileSize: file.size,
          })
        : db.createBroadcast({
            title,
            description,
            sourceType: 'url',
            videoLocation: parseHttpUrl(videoUrl),
          });

      res.status(201).location(`/api/broadcasts/${row.id}`).json(toDto(row));
    } catch (err) {
      if (file) fs.rm(file.path, { force: true }, () => {});
      throw err;
    }
  });

  // 업로드된 영상 파일. express.static 이 Range 요청을 처리하므로 탐색(seek)이 된다.
  app.use('/media', express.static(config.uploadDir, { index: false, fallthrough: false }));

  app.use(express.static(config.publicDir));

  app.use('/api', (_req, res) => res.status(404).json({ error: '존재하지 않는 API입니다.' }));

  app.use((err, _req, res, _next) => {
    if (err instanceof multer.MulterError) {
      const message = err.code === 'LIMIT_FILE_SIZE'
        ? `파일이 너무 큽니다. 최대 ${Math.floor(config.maxUploadBytes / 1024 / 1024)}MB까지 업로드할 수 있습니다.`
        : `업로드 오류: ${err.message}`;
      return res.status(400).json({ error: message });
    }
    const status = err.status || err.statusCode || 500;
    if (status >= 500) console.error(err);
    res.status(status).json({ error: status >= 500 ? '서버 오류가 발생했습니다.' : err.message });
  });

  return app;
}

function toDto(row) {
  return {
    id: row.id,
    title: row.title,
    description: row.description,
    sourceType: row.source_type,
    videoLocation: row.video_location,
    // 플레이어가 그대로 <video src> 로 쓸 수 있는 주소
    videoSrc: row.source_type === 'upload'
      ? `/media/${encodeURIComponent(row.video_location)}`
      : row.video_location,
    mimeType: row.mime_type,
    fileSize: row.file_size,
    createdAt: row.created_at,
  };
}

function parseHttpUrl(value) {
  let url;
  try {
    url = new URL(value);
  } catch {
    throw new HttpError(400, '영상 URL 형식이 올바르지 않습니다.');
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new HttpError(400, '영상 URL은 http:// 또는 https:// 로 시작해야 합니다.');
  }
  return url.href;
}

class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}
