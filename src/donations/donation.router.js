import express from 'express';

const json = express.json({ limit: '10kb' });

// /api/donations
//   GET  /config                      공개 — 결제창을 열 때 필요한 공개 정보(결제 서비스 종류, 토스 클라이언트 키)
//   POST /orders                      회원 — 후원 주문 생성 { targetType, targetId, amount, message }
//   POST /confirm                     후원자 — 결제창 성공 후 승인 확인·확정 { orderId, paymentKey, amount }
//   POST /orders/:orderId/fail        후원자 — 결제창 실패·취소 기록 { code, message }
//   POST /webhook                     결제 서비스 — 상태 변경 통지(PAYMENT_STATUS_CHANGED), 로그인 없음
export function createDonationRouter({ service }) {
  const router = express.Router();

  router.get('/config', (_req, res) => {
    res.json(service.clientConfig());
  });

  router.post('/orders', json, (req, res) => {
    const { targetType, targetId, amount, message } = req.body ?? {};
    res.status(201).json(service.createOrder({ targetType, targetId: Number(targetId), amount, message }, req.member));
  });

  router.post('/confirm', json, async (req, res, next) => {
    try {
      const { orderId, paymentKey, amount } = req.body ?? {};
      res.json(await service.confirm({ orderId, paymentKey, amount }, req.member));
    } catch (err) {
      next(err);
    }
  });

  router.post('/orders/:orderId/fail', json, (req, res) => {
    res.json(service.fail({ orderId: req.params.orderId, code: req.body?.code, message: req.body?.message }, req.member));
  });

  // 결제 서비스는 200 을 받을 때까지 같은 통지를 재전송한다. 처리·중복·무시 모두 200 으로 응답하고,
  // 결제 서비스 조회가 실패한 경우만 500 으로 응답해 재전송을 받는다.
  router.post('/webhook', express.json({ limit: '100kb' }), async (req, res, next) => {
    try {
      res.json(await service.handleWebhook(req.body));
    } catch (err) {
      next(err);
    }
  });

  return router;
}

// 방송별 후원 내역·합계: /api/broadcasts/:id/donations, /api/lives/:id/donations (공개)
export function createTargetDonationRouter({ service, targetType }) {
  const router = express.Router({ mergeParams: true });
  router.get('/', (req, res) => {
    res.json(service.listFor(targetType, Number(req.params.id)));
  });
  return router;
}
