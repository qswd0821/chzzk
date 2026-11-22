// 토스페이먼츠 어댑터: 토스 API 를 흉내 내는 가짜 서버로 승인·조회·중복·웹훅 선도착을 확인한다.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { once } from 'node:events';
import { loadConfig } from '../src/config.js';
import { startTestServer, videoForm } from './helpers.js';

const CLIENT_KEY = 'test_ck_dummyClientKeyForTests';
const SECRET_KEY = 'test_sk_dummySecretKeyForTests';

// paymentKey → { orderId, amount, status }. 결제창 인증을 마친 결제는 READY 로 넣어 둔다.
const payments = new Map();
const calls = [];
let fakeToss;
let t;
let owner;
let fan;
let vodId;

before(async () => {
  fakeToss = http.createServer(async (req, res) => {
    let raw = '';
    for await (const chunk of req) raw += chunk;
    calls.push({ method: req.method, url: req.url, authorization: req.headers.authorization, body: raw ? JSON.parse(raw) : null });
    const reply = (status, body) => { res.writeHead(status, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(body)); };

    if (req.headers.authorization !== `Basic ${Buffer.from(`${SECRET_KEY}:`).toString('base64')}`) {
      return reply(401, { code: 'UNAUTHORIZED_KEY', message: '인증되지 않은 시크릿 키 혹은 클라이언트 키 입니다.' });
    }
    if (req.method === 'POST' && req.url === '/v1/payments/confirm') {
      const { paymentKey, orderId, amount } = JSON.parse(raw);
      const p = payments.get(paymentKey);
      if (!p) return reply(404, { code: 'NOT_FOUND_PAYMENT_SESSION', message: '결제 시간이 만료되어 결제 진행 데이터가 존재하지 않습니다.' });
      if (p.reject) return reply(403, { code: 'REJECT_CARD_COMPANY', message: '결제 승인이 거절되었습니다.' });
      if (p.orderId !== orderId || p.amount !== amount) return reply(400, { code: 'INVALID_REQUEST', message: '잘못된 요청입니다.' });
      if (p.status === 'DONE') return reply(400, { code: 'ALREADY_PROCESSED_PAYMENT', message: '이미 처리된 결제 입니다.' });
      p.status = 'DONE';
      return reply(200, { paymentKey, orderId, status: 'DONE', totalAmount: p.amount, approvedAt: new Date().toISOString(), method: '카드' });
    }
    const lookup = req.url.match(/^\/v1\/payments\/([^/]+)$/);
    if (req.method === 'GET' && lookup) {
      const key = decodeURIComponent(lookup[1]);
      const p = payments.get(key);
      if (!p) return reply(404, { code: 'NOT_FOUND_PAYMENT', message: '존재하지 않는 결제 정보 입니다.' });
      return reply(200, { paymentKey: key, orderId: p.orderId, status: p.status, totalAmount: p.amount });
    }
    reply(404, { code: 'NOT_FOUND', message: 'not found' });
  });
  fakeToss.listen(0);
  await once(fakeToss, 'listening');

  t = await startTestServer({
    env: {
      PAYMENT_PROVIDER: 'auto',
      TOSS_CLIENT_KEY: CLIENT_KEY,
      TOSS_SECRET_KEY: SECRET_KEY,
      TOSS_API_BASE: `http://127.0.0.1:${fakeToss.address().port}`,
    },
  });
  owner = await t.signup('tossowner');
  fan = await t.signup('tossfan');
  vodId = (await t.request('/api/broadcasts', {
    method: 'POST', cookie: owner.cookie, form: videoForm({ title: '토스 후원 방송', videoUrl: 'https://a.com/x.mp4' }),
  })).body.id;
});

after(async () => {
  await t.stop();
  fakeToss.close();
});

const newOrder = async (amount) => (await t.request('/api/donations/orders', {
  method: 'POST', cookie: fan.cookie, json: { targetType: 'broadcast', targetId: vodId, amount },
})).body;
const confirm = (body) => t.request('/api/donations/confirm', { method: 'POST', cookie: fan.cookie, json: body });
const total = async () => (await t.request(`/api/broadcasts/${vodId}/donations`)).body.total;

test('토스 키가 있으면 토스를 쓰고, 브라우저에는 클라이언트 키만 내려준다', async () => {
  const config = (await t.request('/api/donations/config')).body;
  assert.equal(config.provider, 'toss');
  assert.equal(config.clientKey, CLIENT_KEY);
  assert.equal(JSON.stringify(config).includes(SECRET_KEY), false);
  assert.equal((await t.request('/mock-pg/payments', { method: 'POST', json: {} })).status, 404, '토스 모드에서는 모의 결제 서비스가 닫힌다');
});

test('승인: 시크릿 키 Basic 인증으로 /v1/payments/confirm 을 호출하고, 서버에 저장된 주문 금액을 보낸다', async () => {
  const order = await newOrder(5000);
  payments.set('tpk_success', { orderId: order.orderId, amount: 5000, status: 'READY' });
  const res = await confirm({ orderId: order.orderId, paymentKey: 'tpk_success', amount: 5000 });
  assert.equal(res.status, 200);
  assert.equal(res.body.donation.status, 'done');

  const call = calls.find((c) => c.url === '/v1/payments/confirm' && c.body.paymentKey === 'tpk_success');
  assert.equal(call.authorization, `Basic ${Buffer.from(`${SECRET_KEY}:`).toString('base64')}`);
  assert.deepEqual(call.body, { paymentKey: 'tpk_success', orderId: order.orderId, amount: 5000 });
  assert.deepEqual(await total(), { amount: 5000, count: 1 });
});

test('웹훅이 먼저 도착해 확정한 뒤 리다이렉트 승인이 와도(ALREADY_PROCESSED_PAYMENT) 한 번만 적립된다', async () => {
  const order = await newOrder(3000);
  // 토스 쪽에서는 이미 승인 완료(DONE)된 상태 — 예: 다른 탭에서 승인됨
  payments.set('tpk_webhook_first', { orderId: order.orderId, amount: 3000, status: 'DONE' });

  for (let i = 0; i < 3; i++) {
    const hook = await t.request('/api/donations/webhook', {
      method: 'POST', json: { eventType: 'PAYMENT_STATUS_CHANGED', createdAt: '2026-11-22T10:00:00.000000', data: { paymentKey: 'tpk_webhook_first', orderId: order.orderId, status: 'DONE' } },
    });
    assert.equal(hook.status, 200);
    assert.equal(hook.body.result, i === 0 ? 'confirmed' : 'duplicate');
  }

  const res = await confirm({ orderId: order.orderId, paymentKey: 'tpk_webhook_first', amount: 3000 });
  assert.equal(res.status, 200);
  assert.equal(res.body.alreadyConfirmed, true);
  assert.deepEqual(await total(), { amount: 8000, count: 2 });
});

test('토스가 승인을 거절하면 실패로 기록하고 적립하지 않는다', async () => {
  const order = await newOrder(9000);
  payments.set('tpk_reject', { orderId: order.orderId, amount: 9000, status: 'READY', reject: true });
  const res = await confirm({ orderId: order.orderId, paymentKey: 'tpk_reject', amount: 9000 });
  assert.equal(res.status, 402);
  assert.match(res.body.error, /거절/);
  assert.equal(t.db.prepare('SELECT failure_code FROM donations WHERE order_id = ?').get(order.orderId).failure_code, 'REJECT_CARD_COMPANY');
  assert.deepEqual(await total(), { amount: 8000, count: 2 });
});

test('토스 키 설정 검증: live 키 거부, 키 없이 toss 강제 거부', () => {
  assert.throws(() => loadConfig({ PAYMENT_PROVIDER: 'toss' }), /TOSS_CLIENT_KEY/);
  assert.throws(() => loadConfig({ TOSS_CLIENT_KEY: 'live_ck_x', TOSS_SECRET_KEY: 'live_sk_x' }), /테스트 키/);
  assert.equal(loadConfig({}).payment.provider, 'mock');
  assert.equal(loadConfig({ TOSS_CLIENT_KEY: CLIENT_KEY, TOSS_SECRET_KEY: SECRET_KEY }).payment.provider, 'toss');
});
