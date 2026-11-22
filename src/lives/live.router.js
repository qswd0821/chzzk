import express from 'express';

// /api/lives — 목록·상세·시청 설정은 공개. 시작은 로그인 회원, 종료·수정·삭제는 소유자만(서비스에서 검사).
export function createLiveRouter({ service, iceServers }) {
  const router = express.Router();
  const json = express.json({ limit: '10kb' });

  router.get('/', (_req, res) => {
    res.json(service.list());
  });

  // 송출자·시청자 브라우저가 RTCPeerConnection 을 만들 때 쓰는 ICE 서버 목록
  router.get('/rtc-config', (_req, res) => {
    res.json({ iceServers });
  });

  router.get('/:id', (req, res) => {
    res.json(service.get(Number(req.params.id)));
  });

  // { title } → 201 라이브 방송
  router.post('/', json, (req, res) => {
    const live = service.start({ title: req.body?.title }, req.member);
    res.status(201).location(`${req.baseUrl}/${live.id}`).json(live);
  });

  router.post('/:id/end', (req, res) => {
    res.json(service.end(Number(req.params.id), req.member));
  });

  // { title }
  router.patch('/:id', json, (req, res) => {
    res.json(service.rename(Number(req.params.id), req.body?.title, req.member));
  });

  router.delete('/:id', (req, res) => {
    service.remove(Number(req.params.id), req.member);
    res.status(204).end();
  });

  return router;
}
