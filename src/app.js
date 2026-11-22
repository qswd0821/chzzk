import path from 'node:path';
import express from 'express';
import { createVideoStorage } from './storage/video-storage.js';
import { createMemberRepository } from './auth/member.repository.js';
import { createAuthService } from './auth/auth.service.js';
import { createAuthRouter } from './auth/auth.router.js';
import { loadMember, readSessionToken, rejectCrossOrigin } from './auth/session-cookie.js';
import { createBroadcastRepository } from './broadcasts/broadcast.repository.js';
import { createBroadcastService } from './broadcasts/broadcast.service.js';
import { createBroadcastRouter } from './broadcasts/broadcast.router.js';
import { createLiveRepository } from './lives/live.repository.js';
import { createLiveService } from './lives/live.service.js';
import { createLiveRouter } from './lives/live.router.js';
import { attachLiveSignaling } from './lives/live.signaling.js';
import { createCommentRepository } from './comments/comment.repository.js';
import { createCommentService, CommentTarget } from './comments/comment.service.js';
import { createTargetCommentRouter, createCommentRouter } from './comments/comment.router.js';
import { createDonationRepository } from './donations/donation.repository.js';
import { createDonationService } from './donations/donation.service.js';
import { createDonationRouter, createTargetDonationRouter } from './donations/donation.router.js';
import { createPaymentProvider } from './donations/providers/index.js';
import { apiNotFoundHandler, errorHandler } from './http/errors.js';

// 의존성을 조립해 Express 앱을 만든다.
// 모든 요청은 loadMember 를 거쳐 req.member(로그인 회원 또는 null)를 갖고, 각 서비스가 그 회원으로 권한을 검사한다.
// 공개 범위: 목록·시청·댓글·후원 내역 조회는 누구나, 등록·라이브 시작·댓글 작성·후원은 회원,
//           관리·송출 제어는 소유자, 댓글 수정·삭제는 작성자.
export function createApplication({ db, config, liveOptions = {} }) {
  const storage = createVideoStorage(config);
  const auth = createAuthService({ repository: createMemberRepository(db) });

  // 댓글 서비스는 대상 방송이 있는지 확인해야 하고, 방송 서비스는 삭제할 때 댓글을 지워야 한다.
  const findTarget = {};
  const comments = createCommentService({ repository: createCommentRepository(db), findTarget });
  const broadcasts = createBroadcastService({ repository: createBroadcastRepository(db), storage, comments });
  const lives = createLiveService({ repository: createLiveRepository(db), comments, ...liveOptions });
  findTarget[CommentTarget.BROADCAST] = (id) => broadcasts.get(id);
  findTarget[CommentTarget.LIVE] = (id) => lives.get(id);

  // 후원: 결제 서비스(토스 테스트 모드 또는 내장 모의 결제)의 승인을 서버가 확인해 확정한다.
  const { provider, mockGateway } = createPaymentProvider({ config: config.payment, db });
  const donations = createDonationService({ repository: createDonationRepository(db), provider, findTarget });
  mockGateway?.onWebhook((body) => donations.handleWebhook(body));

  const app = express();
  app.disable('x-powered-by');
  app.set('trust proxy', 'loopback');

  app.use(loadMember(auth));
  app.use('/api', rejectCrossOrigin);

  app.use('/api/auth', createAuthRouter({ service: auth }));
  app.use('/api/broadcasts/:id/comments', createTargetCommentRouter({ service: comments, targetType: CommentTarget.BROADCAST }));
  app.use('/api/lives/:id/comments', createTargetCommentRouter({ service: comments, targetType: CommentTarget.LIVE }));
  app.use('/api/comments', createCommentRouter({ service: comments }));
  app.use('/api/broadcasts/:id/donations', createTargetDonationRouter({ service: donations, targetType: 'broadcast' }));
  app.use('/api/lives/:id/donations', createTargetDonationRouter({ service: donations, targetType: 'live' }));
  app.use('/api/donations', createDonationRouter({ service: donations }));
  app.use('/api/broadcasts', createBroadcastRouter({ service: broadcasts, storage }));
  app.use('/api/lives', createLiveRouter({ service: lives, iceServers: config.iceServers }));
  app.use(storage.publicPrefix, storage.serve());

  // 모의 결제 서비스는 토스 키가 없을 때만 열린다.
  if (mockGateway) app.use('/mock-pg', mockGateway.router());
  else app.use(['/mock-pg', '/mock-pay.html', '/mock-pay.js'], (_req, res) => res.status(404).end());

  // 결제창이 돌아오는 주소(successUrl/failUrl). 결제 서비스가 ?paymentKey=… 등을 붙이므로 해시가 아닌 경로로 받는다.
  app.get(['/donation/success', '/donation/fail'], (_req, res) => res.sendFile(path.join(config.publicDir, 'index.html')));
  app.use(express.static(config.publicDir));

  app.use('/api', apiNotFoundHandler);
  app.use(errorHandler);

  return {
    app,
    paymentProvider: provider.name,
    // HTTP(S) 서버에 라이브 방송 WebSocket(시그널링 + 라이브 댓글)을 붙인다.
    attachTo(server) {
      attachLiveSignaling({
        server,
        service: lives,
        comments,
        donations,
        authenticate: (req) => auth.authenticate(readSessionToken(req)),
        ...liveOptions,
      });
      return server;
    },
  };
}
