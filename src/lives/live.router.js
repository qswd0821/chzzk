import express from 'express';

// /api/lives — 로그인 없이 누구나 라이브 방송을 시작하고 시청한다.
// 종료만은 시작할 때 받은 송출 키(X-Stream-Key 헤더)가 있어야 한다.
export function createLiveRouter({ service, iceServers }) {
  const router = express.Router();

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

  // { title } → 201 { live, streamKey }. 송출 키는 이 응답에서 한 번만 내려간다.
  router.post('/', express.json({ limit: '10kb' }), (req, res) => {
    const { live, streamKey } = service.start({ title: req.body?.title });
    res.status(201).location(`${req.baseUrl}/${live.id}`).json({ live, streamKey });
  });

  router.post('/:id/end', (req, res) => {
    res.json(service.end(Number(req.params.id), req.get('X-Stream-Key')));
  });

  return router;
}
