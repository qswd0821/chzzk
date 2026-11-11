import express from 'express';

// /api/broadcasts — 인증 미들웨어 없이 누구나 등록·조회한다.
export function createBroadcastRouter({ service, storage }) {
  const router = express.Router();

  router.get('/', (_req, res) => {
    res.json(service.list());
  });

  router.get('/:id', (req, res) => {
    res.json(service.get(Number(req.params.id)));
  });

  // multipart/form-data: title(필수), description(선택), 그리고 videoFile 또는 videoUrl 중 하나
  router.post('/', storage.acceptSingle('videoFile'), (req, res) => {
    const created = service.register({
      title: req.body.title,
      description: req.body.description,
      videoUrl: req.body.videoUrl,
      uploadedFile: req.file,
    });
    res.status(201).location(`${req.baseUrl}/${created.id}`).json(created);
  });

  return router;
}
