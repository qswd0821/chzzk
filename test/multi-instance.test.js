// 여러 인스턴스: 서버 두 개가 같은 SQLite 파일(공유 볼륨 대신 같은 디렉터리)과 같은 버스(Redis 대신 공유 메모리 버스)를 쓴다.
// 한 인스턴스에서 만든 상태가 다른 인스턴스에서도 그대로 보이고, 라이브 시그널링·댓글·후원 알림이 인스턴스를 넘나드는지 확인한다.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createMemoryBus } from '../src/realtime/bus.js';
import { startTestServer, videoForm } from './helpers.js';

let dataDir;
let a;
let b;
let owner;
let fan;

before(async () => {
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'chzzk-multi-'));
  const bus = createMemoryBus();
  a = await startTestServer({ dataDir, bus, instanceId: 'pod-a', env: { PAYMENT_PROVIDER: 'mock' } });
  b = await startTestServer({ dataDir, bus, instanceId: 'pod-b', env: { PAYMENT_PROVIDER: 'mock' } });
  owner = await a.signup('multiowner', '멀티소유자'); // 인스턴스 A 에서 가입
  fan = await b.signup('multifan', '멀티팬'); // 인스턴스 B 에서 가입
});

after(async () => {
  await a.stop({ keepData: true });
  await b.stop({ keepData: true });
  fs.rmSync(dataDir, { recursive: true, force: true });
});

test('응답에 어느 인스턴스가 처리했는지 표시하고, /healthz 가 준비 상태를 알려준다', async () => {
  const fromA = await a.request('/healthz');
  const fromB = await b.request('/healthz');
  assert.equal(fromA.body.status, 'ok');
  assert.equal(fromA.body.instance, 'pod-a');
  assert.equal(fromB.body.instance, 'pod-b');
  assert.equal(fromA.headers.get('x-instance'), 'pod-a');
  assert.equal((await b.request('/api/broadcasts')).headers.get('x-instance'), 'pod-b');
});

test('A 에서 로그인한 세션으로 B 에서도 로그인 상태다(세션이 공유 DB 에 있다)', async () => {
  const me = await b.request('/api/auth/me', { cookie: owner.cookie });
  assert.equal(me.body.member.nickname, '멀티소유자');
  const logoutOnB = await b.request('/api/auth/logout', { method: 'POST', cookie: (await a.request('/api/auth/login', { method: 'POST', json: { username: 'multiowner', password: 'password123' } })).headers.get('set-cookie').split(';')[0] });
  assert.equal(logoutOnB.status, 204);
});

test('A 에서 등록한 방송·업로드 영상·댓글·후원이 B 에서 그대로 보인다', async () => {
  const created = await a.request('/api/broadcasts', {
    method: 'POST', cookie: owner.cookie,
    form: videoForm({ title: '공유 볼륨 방송' }, { bytes: Buffer.from('shared-video'), type: 'video/mp4', name: 's.mp4' }),
  });
  assert.equal(created.status, 201);
  const id = created.body.id;

  const onB = await b.request(`/api/broadcasts/${id}`);
  assert.equal(onB.body.title, '공유 볼륨 방송');
  assert.equal(await (await fetch(`${b.baseUrl}${onB.body.videoSrc}`)).text(), 'shared-video', '업로드 영상도 공유 볼륨에 있다');

  await b.request(`/api/broadcasts/${id}/comments`, { method: 'POST', cookie: fan.cookie, json: { body: 'B 에서 쓴 댓글' } });
  assert.deepEqual((await a.request(`/api/broadcasts/${id}/comments`)).body.map((c) => c.body), ['B 에서 쓴 댓글']);

  // 후원: 주문은 B, 결제창 성공·승인 확인은 A 에서 해도 한 번만 확정된다.
  const order = await b.request('/api/donations/orders', { method: 'POST', cookie: fan.cookie, json: { targetType: 'broadcast', targetId: id, amount: 3000 } });
  const paymentKey = (await a.request('/mock-pg/payments', { method: 'POST', json: { orderId: order.body.orderId, amount: 3000 } })).body.paymentKey;
  const body = { orderId: order.body.orderId, paymentKey, amount: 3000 };
  const [first, second] = await Promise.all([
    a.request('/api/donations/confirm', { method: 'POST', cookie: fan.cookie, json: body }),
    b.request('/api/donations/confirm', { method: 'POST', cookie: fan.cookie, json: body }),
  ]);
  assert.deepEqual([first.status, second.status], [200, 200]);
  assert.equal([first.body.alreadyConfirmed, second.body.alreadyConfirmed].filter((x) => x === false).length, 1, '두 인스턴스에서 동시에 와도 한 번만 새로 확정');
  assert.deepEqual((await b.request(`/api/broadcasts/${id}/donations`)).body.total, { amount: 3000, count: 1 });
});

test('송출자는 A, 시청자는 B 에 붙어도 시그널링·댓글·후원 알림·종료가 인스턴스를 넘어 전달된다', async () => {
  const live = (await a.request('/api/lives', { method: 'POST', cookie: owner.cookie, json: { title: '인스턴스 넘나드는 라이브' } })).body;

  const broadcaster = a.connect(owner.cookie);
  await broadcaster.opened;
  broadcaster.send({ type: 'join', role: 'broadcaster', liveId: live.id });
  assert.equal((await broadcaster.next('joined')).instanceId, 'pod-a');

  const viewer = b.connect();
  await viewer.opened;
  viewer.send({ type: 'join', role: 'viewer', liveId: live.id });
  const joined = await viewer.next('joined');
  assert.equal(joined.instanceId, 'pod-b');

  const { viewerId } = await broadcaster.next('viewer-joined');
  assert.equal(viewerId, joined.viewerId);

  broadcaster.send({ type: 'offer', to: viewerId, sdp: { type: 'offer', sdp: 'OFFER-A' } });
  assert.equal((await viewer.next('offer')).sdp.sdp, 'OFFER-A');
  viewer.send({ type: 'answer', sdp: { type: 'answer', sdp: 'ANSWER-B' } });
  assert.equal((await broadcaster.next('answer')).sdp.sdp, 'ANSWER-B');

  // 댓글은 A 로 요청해도 B 에 붙은 시청자에게 간다.
  await a.request(`/api/lives/${live.id}/comments`, { method: 'POST', cookie: fan.cookie, json: { body: '넘어가는 댓글' } });
  assert.equal((await viewer.next('comment')).comment.body, '넘어가는 댓글');

  // 후원은 B 로 확정해도 A 에 붙은 송출자에게 간다.
  const order = await b.request('/api/donations/orders', { method: 'POST', cookie: fan.cookie, json: { targetType: 'live', targetId: live.id, amount: 5000, message: '인스턴스 넘어 후원' } });
  const paymentKey = (await b.request('/mock-pg/payments', { method: 'POST', json: { orderId: order.body.orderId, amount: 5000 } })).body.paymentKey;
  await b.request('/api/donations/confirm', { method: 'POST', cookie: fan.cookie, json: { orderId: order.body.orderId, paymentKey, amount: 5000 } });
  assert.equal((await broadcaster.next('donation')).donation.message, '인스턴스 넘어 후원');

  // 종료는 B 로 요청해도 A·B 양쪽 연결에 알려진다.
  await b.request(`/api/lives/${live.id}/end`, { method: 'POST', cookie: owner.cookie });
  await Promise.all([broadcaster.next('ended'), viewer.next('ended')]);
});

test('송출자가 붙은 인스턴스가 내려가도(1012) 다른 인스턴스로 다시 붙으면 라이브가 이어진다', async () => {
  const live = (await a.request('/api/lives', { method: 'POST', cookie: owner.cookie, json: { title: '스케일 인 견디는 라이브' } })).body;
  const onA = a.connect(owner.cookie);
  await onA.opened;
  onA.send({ type: 'join', role: 'broadcaster', liveId: live.id });
  await onA.next('joined');

  // A 가 내려가는 것처럼 연결을 1012 로 닫는다(server.js 의 SIGTERM 처리와 같은 동작).
  onA.socket.close(1012);
  await onA.closed;

  const onB = b.connect(owner.cookie);
  await onB.opened;
  onB.send({ type: 'join', role: 'broadcaster', liveId: live.id });
  assert.equal((await onB.next('joined')).instanceId, 'pod-b');

  await new Promise((r) => setTimeout(r, 700)); // 유예(300ms)를 넘겨도
  assert.equal((await a.request(`/api/lives/${live.id}`)).body.status, 'live');
  await b.request(`/api/lives/${live.id}/end`, { method: 'POST', cookie: owner.cookie });
});

test('두 인스턴스가 함께 떠 있어도 서로의 라이브를 시작 시점에 끝내지 않는다', async () => {
  const live = (await a.request('/api/lives', { method: 'POST', cookie: owner.cookie, json: { title: '새 인스턴스가 떠도 유지' } })).body;
  const ws = a.connect(owner.cookie);
  await ws.opened;
  ws.send({ type: 'join', role: 'broadcaster', liveId: live.id });
  await ws.next('joined');

  // 세 번째 인스턴스가 스케일 아웃으로 뜬다.
  const c = await startTestServer({ dataDir, bus: a.bus, instanceId: 'pod-c' });
  await new Promise((r) => setTimeout(r, 300));
  assert.equal((await c.request(`/api/lives/${live.id}`)).body.status, 'live');
  await c.stop({ keepData: true });
  await a.request(`/api/lives/${live.id}/end`, { method: 'POST', cookie: owner.cookie });
});
