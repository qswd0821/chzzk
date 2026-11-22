// 라이브 방송 (2단계 기능 유지 + 3단계 소유자 권한)
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startTestServer } from './helpers.js';

let t;
let owner;
let other;
let third;

before(async () => {
  t = await startTestServer({
    env: { STUN_URLS: 'stun:stun.example.org:3478', TURN_URL: 'turn:turn.example.org:3478', TURN_USERNAME: 'u', TURN_CREDENTIAL: 'c' },
  });
  owner = await t.signup('streamer');
  other = await t.signup('stranger');
  third = await t.signup('third');
});

after(async () => {
  await t.stop();
});

const start = (title, cookie) => t.request('/api/lives', { method: 'POST', cookie, json: { title } });
const end = (id, cookie) => t.request(`/api/lives/${id}/end`, { method: 'POST', cookie });
const getLive = async (id) => (await t.request(`/api/lives/${id}`)).body;

test('라이브 시작은 로그인 회원만: 비로그인 401, 회원은 방송 중으로 생기고 소유자가 기록된다', async () => {
  assert.equal((await start('익명 라이브')).status, 401);

  const res = await start('퇴근길 라이브', owner.cookie);
  assert.equal(res.status, 201);
  assert.equal(res.body.status, 'live');
  assert.deepEqual(res.body.owner, { id: owner.member.id, nickname: owner.member.nickname });
  assert.equal(res.body.streamKey, undefined, '송출 키는 더 이상 없다');

  assert.equal((await start('  ', other.cookie)).status, 400);
  await end(res.body.id, owner.cookie);
});

test('한 회원은 동시에 하나의 라이브만 방송 중일 수 있다', async () => {
  const first = await start('첫 번째', owner.cookie);
  const second = await start('두 번째', owner.cookie);
  assert.equal(second.status, 409);
  await end(first.body.id, owner.cookie);
  const third = await start('세 번째', owner.cookie);
  assert.equal(third.status, 201);
  await end(third.body.id, owner.cookie);
});

test('종료는 소유자만: 비로그인 401, 다른 회원 403, 소유자 200, 다시 종료 409', async () => {
  const { body: live } = await start('종료 테스트', owner.cookie);
  assert.equal((await end(live.id)).status, 401);
  assert.equal((await end(live.id, other.cookie)).status, 403);
  assert.equal((await getLive(live.id)).status, 'live', '거절된 요청은 상태를 바꾸지 않는다');

  const ok = await end(live.id, owner.cookie);
  assert.equal(ok.status, 200);
  assert.equal(ok.body.status, 'ended');
  assert.ok(ok.body.endedAt);
  assert.equal((await end(live.id, owner.cookie)).status, 409);
  assert.equal((await end(9999, owner.cookie)).status, 404);
});

test('제목 수정과 삭제는 소유자만 할 수 있다', async () => {
  const { body: live } = await start('이름 바꿀 라이브', owner.cookie);
  const rename = (cookie) => t.request(`/api/lives/${live.id}`, { method: 'PATCH', cookie, json: { title: '새 제목' } });
  assert.equal((await rename()).status, 401);
  assert.equal((await rename(other.cookie)).status, 403);
  assert.equal((await rename(owner.cookie)).body.title, '새 제목');

  const del = (cookie) => t.request(`/api/lives/${live.id}`, { method: 'DELETE', cookie });
  assert.equal((await del()).status, 401);
  assert.equal((await del(other.cookie)).status, 403);
  assert.equal((await del(owner.cookie)).status, 204);
  assert.equal((await t.request(`/api/lives/${live.id}`)).status, 404);
});

test('목록은 공개이고 방송 중을 먼저 보여준다', async () => {
  const { body: onAir } = await start('지금 방송 중', other.cookie);
  const lives = (await t.request('/api/lives')).body;
  assert.equal(lives[0].id, onAir.id);
  const firstEnded = lives.findIndex((l) => l.status === 'ended');
  assert.ok(lives.slice(firstEnded).every((l) => l.status === 'ended'));
  await end(onAir.id, other.cookie);
});

test('ICE 서버 설정을 환경변수에서 내려준다', async () => {
  const { iceServers } = (await t.request('/api/lives/rtc-config')).body;
  assert.deepEqual(iceServers, [
    { urls: ['stun:stun.example.org:3478'] },
    { urls: ['turn:turn.example.org:3478'], username: 'u', credential: 'c' },
  ]);
});

test('송출자가 접속하지 않으면 잠시 뒤 종료된다', async () => {
  const { body: live } = await start('접속 안 함', owner.cookie);
  await new Promise((r) => setTimeout(r, 500));
  assert.equal((await getLive(live.id)).status, 'ended');
});

test('시그널링: 비로그인·다른 회원은 송출자로 참여할 수 없고, 소유자와 시청자 사이를 중계한다', async () => {
  const { body: live } = await start('시그널링', owner.cookie);

  // 시청자는 로그인 없이 먼저 들어와 기다린다.
  const viewer = t.connect();
  await viewer.opened;
  viewer.send({ type: 'join', role: 'viewer', liveId: live.id });
  const viewerJoined = await viewer.next('joined');

  const anonymous = t.connect();
  await anonymous.opened;
  anonymous.send({ type: 'join', role: 'broadcaster', liveId: live.id });
  assert.match((await anonymous.next('error')).error, /로그인/);

  const intruder = t.connect(other.cookie);
  await intruder.opened;
  intruder.send({ type: 'join', role: 'broadcaster', liveId: live.id });
  assert.match((await intruder.next('error')).error, /소유자/);

  const broadcaster = t.connect(owner.cookie);
  await broadcaster.opened;
  broadcaster.send({ type: 'join', role: 'broadcaster', liveId: live.id });
  await broadcaster.next('joined');
  const { viewerId } = await broadcaster.next('viewer-joined');
  assert.equal(viewerId, viewerJoined.viewerId);

  broadcaster.send({ type: 'offer', to: viewerId, sdp: { type: 'offer', sdp: 'OFFER' } });
  assert.equal((await viewer.next('offer')).sdp.sdp, 'OFFER');
  viewer.send({ type: 'answer', sdp: { type: 'answer', sdp: 'ANSWER' } });
  const answer = await broadcaster.next('answer');
  assert.equal(answer.from, viewerId);
  viewer.send({ type: 'ice', candidate: { candidate: 'cand-v' } });
  assert.equal((await broadcaster.next('ice')).candidate.candidate, 'cand-v');
  broadcaster.send({ type: 'ice', to: viewerId, candidate: { candidate: 'cand-b' } });
  assert.equal((await viewer.next('ice')).candidate.candidate, 'cand-b');

  // 송출자 연결이 끊기면 시청자에게 종료를 알리고 상태가 종료로 바뀐다.
  broadcaster.socket.close();
  await viewer.next('ended');
  assert.equal((await getLive(live.id)).status, 'ended');

  const late = t.connect();
  await late.opened;
  late.send({ type: 'join', role: 'viewer', liveId: live.id });
  await late.next('ended');
});

test('라이브 댓글은 연결된 시청자·송출자에게 실시간으로 전달된다', async () => {
  const { body: live } = await start('댓글 라이브', third.cookie);
  const broadcaster = t.connect(third.cookie);
  await broadcaster.opened;
  broadcaster.send({ type: 'join', role: 'broadcaster', liveId: live.id });
  await broadcaster.next('joined');

  const viewer = t.connect();
  await viewer.opened;
  viewer.send({ type: 'join', role: 'viewer', liveId: live.id });
  await viewer.next('joined');

  const created = await t.request(`/api/lives/${live.id}/comments`, { method: 'POST', cookie: other.cookie, json: { body: '안녕하세요!' } });
  assert.equal(created.status, 201);
  const [toViewer, toBroadcaster] = await Promise.all([viewer.next('comment'), broadcaster.next('comment')]);
  assert.equal(toViewer.action, 'created');
  assert.equal(toViewer.comment.body, '안녕하세요!');
  assert.equal(toViewer.comment.author.nickname, other.member.nickname);
  assert.equal(toBroadcaster.comment.id, created.body.id);

  await t.request(`/api/comments/${created.body.id}`, { method: 'DELETE', cookie: other.cookie });
  const deleted = await viewer.next('comment');
  assert.equal(deleted.action, 'deleted');
  assert.equal(deleted.comment.id, created.body.id);

  // 소유자가 종료하면 연결된 시청자에게도 종료가 전달된다.
  await end(live.id, third.cookie);
  await Promise.all([viewer.next('ended'), broadcaster.next('ended')]);
});

test('다른 사이트의 페이지는 WebSocket을 열 수 없다', async () => {
  const { default: WebSocket } = await import('ws');
  const socket = new WebSocket(t.wsUrl, { headers: { Origin: 'https://evil.example.com', cookie: owner.cookie } });
  const outcome = await new Promise((resolve) => {
    socket.on('open', () => resolve('open'));
    socket.on('unexpected-response', (_req, res) => resolve(res.statusCode));
    socket.on('error', () => resolve('error'));
  });
  assert.notEqual(outcome, 'open');
});

const wait = (ms) => new Promise((r) => setTimeout(r, ms));

test('송출자 연결이 잠깐 끊겨도 재접속 유예 안에 다시 붙으면 방송이 이어진다', async () => {
  const { body: live } = await start('끊겼다 붙는 라이브', owner.cookie);
  const first = t.connect(owner.cookie);
  await first.opened;
  first.send({ type: 'join', role: 'broadcaster', liveId: live.id });
  await first.next('joined');

  const viewer = t.connect();
  await viewer.opened;
  viewer.send({ type: 'join', role: 'viewer', liveId: live.id });
  await viewer.next('joined');
  await first.next('viewer-joined');

  // 서버 인스턴스가 바뀌는 상황처럼 송출자 연결이 끊긴다(유예 300ms 보다 짧게 비운다).
  first.socket.terminate();
  await wait(150);
  assert.equal((await getLive(live.id)).status, 'live');

  const again = t.connect(owner.cookie);
  await again.opened;
  again.send({ type: 'join', role: 'broadcaster', liveId: live.id });
  await again.next('joined');
  // 다시 붙은 송출자는 기다리던 시청자와 연결을 새로 맺도록 viewer-joined 를 받는다.
  await again.next('viewer-joined');

  await wait(600); // 유예 시간의 두 배가 지나도
  assert.equal((await getLive(live.id)).status, 'live', '송출자가 살아 있는 동안은 종료되지 않는다');

  // 이번에는 돌아오지 않는다 → 유예 뒤 종료, 시청자에게 알림
  again.socket.terminate();
  await viewer.next('ended');
  assert.equal((await getLive(live.id)).status, 'ended');
});

test('소유자가 새 화면으로 송출에 참여하면 그 화면이 송출자가 되고 이전 연결은 닫힌다', async () => {
  const { body: live } = await start('이어받기 라이브', owner.cookie);
  const oldTab = t.connect(owner.cookie);
  await oldTab.opened;
  oldTab.send({ type: 'join', role: 'broadcaster', liveId: live.id });
  await oldTab.next('joined');

  const newTab = t.connect(owner.cookie);
  await newTab.opened;
  newTab.send({ type: 'join', role: 'broadcaster', liveId: live.id });
  await newTab.next('joined');

  const kicked = await oldTab.next('error');
  assert.match(kicked.error, /이어받았습니다/);
  assert.equal(kicked.code, 4001);
  await end(live.id, owner.cookie);
});

test('서버를 재시작하면, 송출자가 돌아오지 않은 라이브는 주기 점검으로 종료된다', async () => {
  const { body: live } = await start('재시작 전 방송', owner.cookie);
  await t.restart();
  // 새 인스턴스가 뜨는 것만으로 남의 라이브를 끝내지는 않는다. 접속 표시가 없는 것을 점검이 찾아 종료한다.
  await wait(200);
  assert.equal((await getLive(live.id)).status, 'ended');
  // 종료됐으므로 같은 회원이 새로 시작할 수 있다.
  const again = await start('재시작 후 방송', owner.cookie);
  assert.equal(again.status, 201);
});
