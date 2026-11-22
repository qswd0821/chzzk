import crypto from 'node:crypto';
import express from 'express';
import { ProviderError, toPayment } from './provider-error.js';

// 내장 모의 결제 서비스. 토스 테스트 키가 없을 때 같은 흐름을 재현한다(docs/adr/0002).
//   1) 결제창: /mock-pay.html 에서 성공·실패·취소를 고른다.
//      성공 → POST /mock-pg/payments 로 결제(READY)를 만들고 successUrl?paymentKey&orderId&amount 로 이동
//      실패 → failUrl?code=REJECT_CARD_COMPANY&message&orderId,  취소 → failUrl?code=PAY_PROCESS_CANCELED&message (orderId 없음)
//   2) 승인: confirm() — 금액·주문번호가 결제창에서 만든 결제와 다르면 거절, 이미 승인된 결제면 ALREADY_PROCESSED_PAYMENT
//   3) 상태 변경 통지: 승인되면 토스처럼 PAYMENT_STATUS_CHANGED 웹훅을 한 번 보낸다(→ 리다이렉트 확정과 겹치는 중복 통지).
//      /mock-pg/payments/:paymentKey/webhook-resend 로 같은 통지를 여러 번 다시 보낼 수 있다.
// 실제 돈은 오가지 않는다.
export function createMockPaymentGateway(db) {
  const insertStmt = db.prepare(`INSERT INTO mock_payments (payment_key, order_id, amount, status) VALUES (?, ?, ?, 'READY')`);
  const byKeyStmt = db.prepare('SELECT * FROM mock_payments WHERE payment_key = ?');
  const byOrderStmt = db.prepare('SELECT * FROM mock_payments WHERE order_id = ?');
  const approveStmt = db.prepare(`
    UPDATE mock_payments SET status = 'DONE', approved_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
    WHERE payment_key = ? AND status = 'READY'
  `);

  let deliverWebhook = async () => {};

  const toRaw = (row) => ({
    paymentKey: row.payment_key, orderId: row.order_id, status: row.status, totalAmount: row.amount, approvedAt: row.approved_at,
  });

  function find(paymentKey) {
    const row = byKeyStmt.get(String(paymentKey ?? ''));
    if (!row) throw new ProviderError('NOT_FOUND_PAYMENT', '존재하지 않는 결제 정보 입니다.', 404);
    return row;
  }

  function webhookBody(row) {
    return { eventType: 'PAYMENT_STATUS_CHANGED', createdAt: new Date().toISOString(), data: toRaw(row) };
  }

  const provider = {
    name: 'mock',

    clientConfig() {
      return { provider: 'mock', payUrl: '/mock-pay.html' };
    },

    async confirm({ paymentKey, orderId, amount }) {
      const row = find(paymentKey);
      if (row.order_id !== orderId) throw new ProviderError('FORBIDDEN_REQUEST', '주문번호가 결제 정보와 다릅니다.', 403);
      if (row.amount !== Number(amount)) throw new ProviderError('INVALID_REQUEST', '결제 금액이 결제창에서 요청한 금액과 다릅니다.', 400);
      if (approveStmt.run(row.payment_key).changes === 0) {
        throw new ProviderError('ALREADY_PROCESSED_PAYMENT', '이미 처리된 결제 입니다.', 400);
      }
      const approved = byKeyStmt.get(row.payment_key);
      // 토스처럼 상태 변경 웹훅을 보낸다. 승인 응답보다 늦게 도착하도록 다음 틱에 보낸다.
      setImmediate(() => { deliverWebhook(webhookBody(approved)).catch(() => {}); });
      return toPayment(toRaw(approved));
    },

    async getPayment(paymentKey) {
      return toPayment(toRaw(find(paymentKey)));
    },
  };

  // 모의 결제창과 "승인 통지 다시 보내기"가 쓰는 결제 서비스 쪽 API
  function router() {
    const r = express.Router();
    r.use(express.json({ limit: '10kb' }));

    // 결제창에서 '성공'을 눌렀을 때: 결제(READY)를 만든다. 같은 주문으로 이미 만들었으면 그 결제를 돌려준다.
    r.post('/payments', (req, res) => {
      const orderId = String(req.body?.orderId ?? '');
      const amount = Number(req.body?.amount);
      if (!/^[A-Za-z0-9_=-]{6,64}$/.test(orderId) || !Number.isInteger(amount) || amount <= 0) {
        return res.status(400).json({ code: 'INVALID_REQUEST', message: '주문번호 또는 금액이 올바르지 않습니다.' });
      }
      const existing = byOrderStmt.get(orderId);
      if (existing) return res.json(toRaw(existing));
      const paymentKey = `mock_${crypto.randomBytes(16).toString('hex')}`;
      insertStmt.run(paymentKey, orderId, amount);
      res.status(201).json(toRaw(byKeyStmt.get(paymentKey)));
    });

    // 같은 승인 통지(웹훅)를 times 번 다시 보낸다. 중복 통지에도 후원이 한 번만 적립되는지 확인용.
    r.post('/payments/:paymentKey/webhook-resend', async (req, res, next) => {
      try {
        const row = find(req.params.paymentKey);
        const times = Math.min(Math.max(Number(req.query.times) || 3, 1), 10);
        const results = [];
        for (let i = 0; i < times; i++) results.push(await deliverWebhook(webhookBody(row)));
        res.json({ delivered: times, results });
      } catch (err) {
        next(err instanceof ProviderError ? Object.assign(err, { status: err.providerStatus }) : err);
      }
    });

    return r;
  }

  return {
    provider,
    router,
    // 웹훅을 받을 곳(후원 서비스의 handleWebhook)을 연결한다.
    onWebhook(handler) { deliverWebhook = handler; },
  };
}
