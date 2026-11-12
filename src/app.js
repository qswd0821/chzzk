import express from 'express';
import { createVideoStorage } from './storage/video-storage.js';
import { createBroadcastRepository } from './broadcasts/broadcast.repository.js';
import { createBroadcastService } from './broadcasts/broadcast.service.js';
import { createBroadcastRouter } from './broadcasts/broadcast.router.js';
import { createLiveRepository } from './lives/live.repository.js';
import { createLiveService } from './lives/live.service.js';
import { createLiveRouter } from './lives/live.router.js';
import { attachLiveSignaling } from './lives/live.signaling.js';
import { apiNotFoundHandler, errorHandler } from './http/errors.js';

// 의존성을 조립해 Express 앱을 만든다. 로그인·세션 미들웨어가 없으므로 모든 화면과 API가 공개다.
// 다음 단계 기능(인증, 댓글 등)은 같은 모양의 모듈을 만들어 여기에 라우터를 하나 더 붙이면 된다.
export function createApplication({ db, config, liveOptions = {} }) {
  const storage = createVideoStorage(config);
  const broadcasts = createBroadcastService({
    repository: createBroadcastRepository(db),
    storage,
  });
  const lives = createLiveService({ repository: createLiveRepository(db), ...liveOptions });

  const app = express();
  app.disable('x-powered-by');

  app.use('/api/broadcasts', createBroadcastRouter({ service: broadcasts, storage }));
  app.use('/api/lives', createLiveRouter({ service: lives, iceServers: config.iceServers }));
  app.use(storage.publicPrefix, storage.serve());
  app.use(express.static(config.publicDir));

  app.use('/api', apiNotFoundHandler);
  app.use(errorHandler);

  return {
    app,
    // HTTP(S) 서버에 라이브 방송 WebSocket 시그널링을 붙인다.
    attachTo(server) {
      attachLiveSignaling({ server, service: lives, ...liveOptions });
      return server;
    },
  };
}
