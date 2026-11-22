// 후원 (내장 모의 결제 서비스로 결제창 → 승인 → 확정 흐름 전체)
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startTestServer, videoForm } from './helpers.js';

let t;
let owner;
let fan;
let other;
let vodId;
let orphanId;

before(async () => {
  t = await startTestServer({ env: { PAYMENT_PROVIDER: 'mock' }, liveOptions: { broadcasterConnectTimeoutMs: 60_000 } });
  owner = await t.signup('creator', '크리에이터');
  fan = await t.signup('fan01', '열혈팬');
  other = await t.signup('other01', '지나가는회원');
  vodId = (await t.request('/api/broadcasts', {
    method: 'POST', cookie: owner.cookie, form: videoForm({ title: '후원 받을 방송', videoUrl: 'https://a.com/x.mp4' }),
  })).body.id;
  t.db.prepare(`INSERT INTO broadcasts (title, source_type, video_location) VALUES ('소유자 없는 방송', 'url', 'https://a.com/o.mp4')`).run();
  orphanId = t.db.prepare(`SELECT id FROM broadcasts WHERE owner_id IS NULL`).get().id;
});

after(async () => {
  await t.stop();
});

const order = (cookie, body) => t.request('/api/donations/orders', { method: 'POST', cookie, json: { targetType: 'broadcast', targetId: vodId, amount: 5000, message: '응원해요', ...body } });
const confirm = (cookie, body) => t.request('/api/donations/confirm', { method: 'POST', cookie, json: body });
const totals = async (type = 'broadcasts', id = vodId) => (await t.request(`/api/${type}/${id}/donations`)).body;
// 모의 결제창에서 '성공'을 누른 것과 같다(결제 서비스가 결제를 만들고 paymentKey 를 준다).
const payOnMockWindow = async (orderId, amount) => (await t.request('/mock-pg/payments', { method: 'POST', json: { orderId, amount } })).body.paymentKey;
const settle = () => new Promise((r) => setTimeout(r, 50)); // 모의 결제 서비스의 자동 웹훅이 도착할 시간

test('결제 설정은 공개 정보만 준다', async () => {
  const res = await t.request('/api/donations/config');
  assert.equal(res.body.provider, 'mock');
  assert.equal(res.body.amountMin, 1000);
  assert.equal(res.body.amountMax, 500000);
  assert.equal(res.body.secretKey, undefined);
});

test('후원 주문: 비로그인 401, 소유자 없는 방송·자기 방송·잘못된 금액·긴 메시지는 거절', async () => {
  assert.equal((await order(undefined)).status, 401);
  assert.equal((await order(fan.cookie, { targetId: orphanId })).status, 400);
  assert.equal((await order(owner.cookie)).status, 403, '자기 방송에는 후원할 수 없다');
  for (const amount of [999, 0, -1000, 1500, 501000, '5000원', null]) {
    assert.equal((await order(fan.cookie, { amount })).status, 400, `amount=${amount}`);
  }
  assert.equal((await order(fan.cookie, { message: 'x'.repeat(101) })).status, 400);
  assert.equal((await order(fan.cookie, { targetId: 9999 })).status, 404);
  assert.equal((await totals()).total.count, 0, '주문만으로는 후원이 아니다');
});

test('결제 성공: 서버가 승인을 확인해 확정하고, 방송별 내역과 합계에 반영된다', async () => {
  const created = await order(fan.cookie);
  assert.equal(created.status, 201);
  assert.match(created.body.orderId, /^don-[0-9a-f-]{36}$/);
  assert.equal(created.body.amount, 5000);
  assert.equal(created.body.orderName, '크리에이터님 후원');

  // 결제창 성공 전에는 내역에 없다.
  assert.equal((await totals()).total.count, 0);

  const paymentKey = await payOnMockWindow(created.body.orderId, 5000);
  const res = await confirm(fan.cookie, { orderId: created.body.orderId, paymentKey, amount: 5000 });
  assert.equal(res.status, 200);
  assert.equal(res.body.alreadyConfirmed, false);
  assert.equal(res.body.donation.status, 'done');
  assert.deepEqual(res.body.donation.recipient, { id: owner.member.id, nickname: '크리에이터' });
  assert.equal(res.body.donation.paymentKey, undefined, '결제키는 공개 응답에 넣지 않는다');

  await settle();
  const list = await totals();
  assert.deepEqual(list.total, { amount: 5000, count: 1 });
  assert.equal(list.donations[0].donor.nickname, '열혈팬');
  assert.equal(list.donations[0].message, '응원해요');
});

test('같은 승인 통지가 반복되어도 한 번만 적립된다 (승인 재요청·자동 웹훅·웹훅 재전송·웹훅 직접 반복)', async () => {
  const created = await order(fan.cookie, { amount: 10000, message: '중복 테스트' });
  const paymentKey = await payOnMockWindow(created.body.orderId, 10000);
  const body = { orderId: created.body.orderId, paymentKey, amount: 10000 };

  const first = await confirm(fan.cookie, body);
  assert.equal(first.body.alreadyConfirmed, false);
  await settle(); // 모의 결제 서비스가 승인 직후 보낸 PAYMENT_STATUS_CHANGED 웹훅(= 첫 번째 중복 통지)

  // 성공 페이지 새로고침·뒤로 가기처럼 같은 승인 요청이 다시 와도 확정은 그대로
  for (let i = 0; i < 3; i++) {
    const again = await confirm(fan.cookie, body);
    assert.equal(again.status, 200);
    assert.equal(again.body.alreadyConfirmed, true);
  }

  // 결제 서비스가 같은 웹훅을 5번 재전송
  const resent = await t.request(`/mock-pg/payments/${paymentKey}/webhook-resend?times=5`, { method: 'POST' });
  assert.equal(resent.body.delivered, 5);
  assert.ok(resent.body.results.every((r) => r.result === 'duplicate'));

  // 웹훅 주소로 같은 본문을 직접 3번
  for (let i = 0; i < 3; i++) {
    const hook = await t.request('/api/donations/webhook', {
      method: 'POST', json: { eventType: 'PAYMENT_STATUS_CHANGED', createdAt: new Date().toISOString(), data: { paymentKey, orderId: body.orderId, status: 'DONE' } },
    });
    assert.equal(hook.status, 200);
    assert.equal(hook.body.result, 'duplicate');
  }

  const list = await totals();
  assert.deepEqual(list.total, { amount: 15000, count: 2 });
  assert.equal(list.donations.filter((d) => d.message === '중복 테스트').length, 1);
});

test('웹훅 본문을 위조해도(없는 결제·바뀐 금액) 적립되지 않는다', async () => {
  const forged = await t.request('/api/donations/webhook', {
    method: 'POST', json: { eventType: 'PAYMENT_STATUS_CHANGED', data: { paymentKey: 'mock_forged', orderId: 'don-x', status: 'DONE', totalAmount: 500000 } },
  });
  assert.equal(forged.status, 200);
  assert.equal(forged.body.result, 'ignored');

  // 결제창 인증만 하고 승인되지 않은(READY) 결제의 웹훅을 DONE 이라고 속여도, 서버는 결제 서비스에 다시 조회해 무시한다.
  const created = await order(fan.cookie, { amount: 3000 });
  const paymentKey = await payOnMockWindow(created.body.orderId, 3000);
  const lie = await t.request('/api/donations/webhook', {
    method: 'POST', json: { eventType: 'PAYMENT_STATUS_CHANGED', data: { paymentKey, orderId: created.body.orderId, status: 'DONE' } },
  });
  assert.equal(lie.body.result, 'ignored');
  assert.match(lie.body.reason, /READY/);
  assert.equal((await totals()).total.count, 2);
});

test('금액을 바꾸면 확정하지 않는다 (리다이렉트 금액 변조, 결제창 금액 변조)', async () => {
  // 1) 결제는 5000원인데 성공 주소의 amount 를 1000 으로 바꿔 보냄
  const a = await order(fan.cookie, { amount: 5000 });
  const keyA = await payOnMockWindow(a.body.orderId, 5000);
  const resA = await confirm(fan.cookie, { orderId: a.body.orderId, paymentKey: keyA, amount: 1000 });
  assert.equal(resA.status, 400);
  assert.match(resA.body.error, /금액/);

  // 2) 주문은 50000원인데 결제창에서 1000원만 결제하고, 성공 주소도 50000 으로 맞춰 보냄
  const b = await order(fan.cookie, { amount: 50000 });
  const keyB = await payOnMockWindow(b.body.orderId, 1000);
  const resB = await confirm(fan.cookie, { orderId: b.body.orderId, paymentKey: keyB, amount: 50000 });
  assert.equal(resB.status, 402, '결제 서비스가 금액 불일치로 승인을 거절한다');

  assert.equal((await totals()).total.amount, 15000);
  assert.equal(t.db.prepare('SELECT status FROM donations WHERE order_id = ?').get(a.body.orderId).status, 'failed');
  assert.equal(t.db.prepare('SELECT status FROM donations WHERE order_id = ?').get(b.body.orderId).status, 'failed');
});

test('남의 후원 주문은 확정·실패 처리할 수 없다', async () => {
  const created = await order(fan.cookie, { amount: 2000 });
  const paymentKey = await payOnMockWindow(created.body.orderId, 2000);
  const body = { orderId: created.body.orderId, paymentKey, amount: 2000 };
  assert.equal((await confirm(undefined, body)).status, 401);
  assert.equal((await confirm(other.cookie, body)).status, 403);
  assert.equal((await t.request(`/api/donations/orders/${created.body.orderId}/fail`, { method: 'POST', cookie: other.cookie, json: { code: 'X' } })).status, 403);
  assert.equal((await confirm(fan.cookie, body)).status, 200);
});

test('결제 실패·취소는 적립하지 않고, 그 주문은 나중에 확정할 수도 없다', async () => {
  const failed = await order(fan.cookie, { amount: 7000 });
  const resFail = await t.request(`/api/donations/orders/${failed.body.orderId}/fail`, {
    method: 'POST', cookie: fan.cookie, json: { code: 'REJECT_CARD_COMPANY', message: '결제 승인이 거절되었습니다.' },
  });
  assert.equal(resFail.body.status, 'failed');

  const canceled = await order(fan.cookie, { amount: 8000 });
  const resCancel = await t.request(`/api/donations/orders/${canceled.body.orderId}/fail`, {
    method: 'POST', cookie: fan.cookie, json: { code: 'PAY_PROCESS_CANCELED', message: '사용자에 의해 결제가 취소되었습니다.' },
  });
  assert.equal(resCancel.body.status, 'canceled');

  const key = await payOnMockWindow(canceled.body.orderId, 8000);
  assert.equal((await confirm(fan.cookie, { orderId: canceled.body.orderId, paymentKey: key, amount: 8000 })).status, 409);
  assert.equal((await totals()).total.amount, 17000);
});

test('30분이 지난 결제 대기 주문은 만료되어 확정할 수 없다', async () => {
  const created = await order(fan.cookie, { amount: 4000 });
  t.db.prepare(`UPDATE donations SET created_at = '2000-01-01T00:00:00.000Z' WHERE order_id = ?`).run(created.body.orderId);
  const key = await payOnMockWindow(created.body.orderId, 4000);
  const res = await confirm(fan.cookie, { orderId: created.body.orderId, paymentKey: key, amount: 4000 });
  assert.equal(res.status, 409);
  assert.match(res.body.error, /만료/);
  assert.equal(t.db.prepare('SELECT status FROM donations WHERE order_id = ?').get(created.body.orderId).status, 'expired');
});

test('주문 뒤 방송이 삭제되면 받는 대상을 확인할 수 없어 확정하지 않는다', async () => {
  const temp = (await t.request('/api/broadcasts', {
    method: 'POST', cookie: owner.cookie, form: videoForm({ title: '곧 지울 방송', videoUrl: 'https://a.com/t.mp4' }),
  })).body.id;
  const created = await order(fan.cookie, { targetId: temp, amount: 1000 });
  await t.request(`/api/broadcasts/${temp}`, { method: 'DELETE', cookie: owner.cookie });
  const key = await payOnMockWindow(created.body.orderId, 1000);
  const res = await confirm(fan.cookie, { orderId: created.body.orderId, paymentKey: key, amount: 1000 });
  assert.equal(res.status, 409);
  assert.equal(t.db.prepare('SELECT status FROM donations WHERE order_id = ?').get(created.body.orderId).status, 'failed');
});

test('한 결제키는 한 후원에만 쓰인다 (저장 구조의 UNIQUE)', () => {
  const columns = t.db.prepare(`SELECT name, "unique" AS u FROM pragma_index_list('donations')`).all();
  const uniqueCols = columns.filter((c) => c.u).flatMap((c) => t.db.prepare(`SELECT name FROM pragma_index_info(?)`).all(c.name).map((r) => r.name));
  assert.ok(uniqueCols.includes('order_id'));
  assert.ok(uniqueCols.includes('payment_key'));
});

test('라이브 후원은 시청자·송출자에게 실시간으로 한 번만 알려진다', async () => {
  const live = (await t.request('/api/lives', { method: 'POST', cookie: owner.cookie, json: { title: '후원 라이브' } })).body;
  const viewer = t.connect();
  await viewer.opened;
  viewer.send({ type: 'join', role: 'viewer', liveId: live.id });
  await viewer.next('joined');
  const alerts = [];
  viewer.socket.on('message', (raw) => { const m = JSON.parse(raw); if (m.type === 'donation') alerts.push(m); });

  const created = await t.request('/api/donations/orders', {
    method: 'POST', cookie: fan.cookie, json: { targetType: 'live', targetId: live.id, amount: 20000, message: '라이브 응원!' },
  });
  const paymentKey = await payOnMockWindow(created.body.orderId, 20000);
  await confirm(fan.cookie, { orderId: created.body.orderId, paymentKey, amount: 20000 });
  await t.request(`/mock-pg/payments/${paymentKey}/webhook-resend?times=3`, { method: 'POST' });
  await settle();

  assert.equal(alerts.length, 1);
  assert.equal(alerts[0].donation.amount, 20000);
  assert.equal(alerts[0].donation.message, '라이브 응원!');
  assert.equal(alerts[0].donation.donor.nickname, '열혈팬');
  assert.deepEqual((await totals('lives', live.id)).total, { amount: 20000, count: 1 });
  viewer.socket.close();
});

test('후원 내역은 비로그인도 볼 수 있고, 서버를 재시작해도 남아 있다', async () => {
  await t.restart();
  const list = await totals();
  assert.equal(list.total.amount, 17000);
  assert.equal(list.total.count, 3);
  assert.ok(list.donations.every((d) => d.status === 'done'));
  assert.equal((await t.request('/api/broadcasts/9999/donations')).status, 404);
});
