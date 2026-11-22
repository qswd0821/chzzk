import express from 'express';
import { requireLogin } from '../auth/session-cookie.js';

// /api/broadcasts — 목록·상세는 공개, 등록은 로그인 회원, 수정·삭제는 소유자만(서비스에서 검사).
export function createBroadcastRouter({ service, storage }) {
  const router = express.Router();

  router.get('/', (_req, res) => {
    res.json(service.list());
  });

  router.get('/:id', (req, res) => {
    res.json(service.get(Number(req.params.id)));
  });

  // multipart/form-data: title(필수), description(선택), 그리고 videoFile 또는 videoUrl 중 하나
  // requireLogin 을 업로드보다 먼저 두어 비로그인 요청의 파일은 디스크에 닿지도 않게 한다.
  router.post('/', requireLogin, storage.acceptSingle('videoFile'), (req, res) => {
    const created = service.register({
      title: req.body.title,
      description: req.body.description,
      videoUrl: req.body.videoUrl,
      uploadedFile: req.file,
    }, req.member);
    res.status(201).location(`${req.baseUrl}/${created.id}`).json(created);
  });

  // JSON { title?, description? }
  router.patch('/:id', express.json({ limit: '10kb' }), (req, res) => {
    const { title, description } = req.body ?? {};
    res.json(service.update(Number(req.params.id), { title, description }, req.member));
  });

  router.delete('/:id', (req, res) => {
    service.remove(Number(req.params.id), req.member);
    res.status(204).end();
  });

  return router;
}
