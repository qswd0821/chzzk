import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { once } from 'node:events';
import WebSocket from 'ws';
import { loadConfig } from '../src/config.js';
import { openDatabase } from '../src/database.js';
import { createApplication } from '../src/app.js';

let tmpDir;
let config;
let db;
let server;
let baseUrl;
let wsUrl;

const liveOptions = { broadcasterConnectTimeoutMs: 300 };

function start() {
  db = openDatabase(config.dbPath);
  const { app, attachTo } = createApplication({ db, config, liveOptions });
  server = attachTo(app.listen(0));
  const { port } = server.address();
  baseUrl = `http://127.0.0.1:${port}`;
  wsUrl = `ws://127.0.0.1:${port}/ws/lives`;
}

async function stop() {
  server.closeAllConnections();
  server.close();
  await once(server, 'close');
  db.close();
}

before(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'chzzk-live-'));
  config = loadConfig({ DATA_DIR: tmpDir, STUN_URLS: 'stun:stun.example.org:3478', TURN_URL: 'turn:turn.example.org:3478', TURN_USERNAME: 'u', TURN_CREDENTIAL: 'c' });
  start();
});

after(async () => {
  await stop();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

async function startLive(title) {
  const res = await fetch(`${baseUrl}/api/lives`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ title }),
  });
  return { res, body: await res.json() };
}

const getLive = async (id) => (await fetch(`${baseUrl}/api/lives/${id}`)).json();

// 받은 메시지를 순서대로 쌓아 두고, 원하는 type 이 올 때까지 기다린다.
function connect() {
  const socket = new WebSocket(wsUrl);
  const inbox = [];
  const waiters = [];
  socket.on('message', (raw) => {
    const msg = JSON.parse(raw.toString());
    const i = waiters.findIndex((w) => w.type === msg.type);
    if (i >= 0) waiters.splice(i, 1)[0].resolve(msg);
    else inbox.push(msg);
  });
  return {
    socket,
    opened: once(socket, 'open'),
    send: (msg) => socket.send(JSON.stringify(msg)),
    next(type) {
      const i = inbox.findIndex((m) => m.type === type);
      if (i >= 0) return Promise.resolve(inbox.splice(i, 1)[0]);
      return new Promise((resolve) => waiters.push({ type, resolve }));
    },
  };
}

test('라이브 방송을 시작하면 방송 중으로 생기고 송출 키가 한 번 내려온다', async () => {
  const { res, body } = await startLive('퇴근길 라이브');
  assert.equal(res.status, 201);
  assert.equal(body.live.status, 'live');
  assert.equal(body.live.title, '퇴근길 라이브');
  assert.ok(body.streamKey.length >= 32);

  const detail = await getLive(body.live.id);
  assert.equal(detail.status, 'live');
  assert.equal(detail.streamKey, undefined, '조회 응답에는 송출 키가 없다');

  const bad = await startLive('  ');
  assert.equal(bad.res.status, 400);
});

test('송출 키가 맞아야만 종료할 수 있고, 종료는 되돌릴 수 없다', async () => {
  const { body } = await startLive('종료 테스트');
  const end = (key) => fetch(`${baseUrl}/api/lives/${body.live.id}/end`, {
    method: 'POST',
    headers: key ? { 'X-Stream-Key': key } : {},
  });

  assert.equal((await end()).status, 403);
  assert.equal((await end('wrong-key')).status, 403);

  const ok = await end(body.streamKey);
  assert.equal(ok.status, 200);
  const ended = await ok.json();
  assert.equal(ended.status, 'ended');
  assert.ok(ended.endedAt);

  assert.equal((await end(body.streamKey)).status, 409);
  assert.equal((await fetch(`${baseUrl}/api/lives/9999/end`, { method: 'POST' })).status, 404);
});

test('목록은 방송 중을 먼저, 종료를 나중에 보여준다', async () => {
  const { body: onAir } = await startLive('지금 방송 중');
  const lives = await (await fetch(`${baseUrl}/api/lives`)).json();
  assert.equal(lives[0].id, onAir.live.id);
  const firstEnded = lives.findIndex((l) => l.status === 'ended');
  assert.ok(lives.slice(firstEnded).every((l) => l.status === 'ended'));
});

test('ICE 서버 설정을 환경변수에서 내려준다', async () => {
  const { iceServers } = await (await fetch(`${baseUrl}/api/lives/rtc-config`)).json();
  assert.deepEqual(iceServers, [
    { urls: ['stun:stun.example.org:3478'] },
    { urls: ['turn:turn.example.org:3478'], username: 'u', credential: 'c' },
  ]);
});

test('송출자가 접속하지 않으면 잠시 뒤 종료된다', async () => {
  const { body } = await startLive('접속 안 함');
  await new Promise((r) => setTimeout(r, 500));
  assert.equal((await getLive(body.live.id)).status, 'ended');
});

test('시그널링: 송출자와 시청자 사이에 offer/answer/ice 를 중계하고, 송출자가 끊기면 종료된다', async () => {
  const { body } = await startLive('시그널링');
  const liveId = body.live.id;

  // 시청자가 먼저 들어와 기다린다.
  const viewer = connect();
  await viewer.opened;
  viewer.send({ type: 'join', role: 'viewer', liveId });
  const viewerJoined = await viewer.next('joined');

  // 송출 키가 틀린 송출자는 거절된다.
  const intruder = connect();
  await intruder.opened;
  intruder.send({ type: 'join', role: 'broadcaster', liveId, streamKey: 'nope' });
  assert.match((await intruder.next('error')).error, /송출 키/);

  const broadcaster = connect();
  await broadcaster.opened;
  broadcaster.send({ type: 'join', role: 'broadcaster', liveId, streamKey: body.streamKey });
  await broadcaster.next('joined');
  const { viewerId } = await broadcaster.next('viewer-joined');
  assert.equal(viewerId, viewerJoined.viewerId);

  broadcaster.send({ type: 'offer', to: viewerId, sdp: { type: 'offer', sdp: 'OFFER' } });
  assert.equal((await viewer.next('offer')).sdp.sdp, 'OFFER');

  viewer.send({ type: 'answer', sdp: { type: 'answer', sdp: 'ANSWER' } });
  const answer = await broadcaster.next('answer');
  assert.equal(answer.from, viewerId);
  assert.equal(answer.sdp.sdp, 'ANSWER');

  viewer.send({ type: 'ice', candidate: { candidate: 'cand-v' } });
  assert.equal((await broadcaster.next('ice')).candidate.candidate, 'cand-v');
  broadcaster.send({ type: 'ice', to: viewerId, candidate: { candidate: 'cand-b' } });
  assert.equal((await viewer.next('ice')).candidate.candidate, 'cand-b');

  // 송출자 연결이 끊기면 시청자에게 종료를 알리고 상태가 종료로 바뀐다.
  broadcaster.socket.close();
  await viewer.next('ended');
  assert.equal((await getLive(liveId)).status, 'ended');

  // 종료된 방송에 들어오면 바로 종료를 알려준다.
  const late = connect();
  await late.opened;
  late.send({ type: 'join', role: 'viewer', liveId });
  await late.next('ended');
});

test('송출 키로 종료하면 연결된 시청자에게도 종료가 전달된다', async () => {
  const { body } = await startLive('버튼 종료');
  const broadcaster = connect();
  await broadcaster.opened;
  broadcaster.send({ type: 'join', role: 'broadcaster', liveId: body.live.id, streamKey: body.streamKey });
  await broadcaster.next('joined');

  const viewer = connect();
  await viewer.opened;
  viewer.send({ type: 'join', role: 'viewer', liveId: body.live.id });
  await broadcaster.next('viewer-joined');

  await fetch(`${baseUrl}/api/lives/${body.live.id}/end`, { method: 'POST', headers: { 'X-Stream-Key': body.streamKey } });
  await Promise.all([viewer.next('ended'), broadcaster.next('ended')]);
});

test('서버가 재시작되면 방송 중이던 라이브는 종료로 바뀌고 녹화방송 기능은 그대로다', async () => {
  const { body } = await startLive('재시작 전 방송');
  await stop();
  start();
  assert.equal((await getLive(body.live.id)).status, 'ended');
  assert.equal((await fetch(`${baseUrl}/api/broadcasts`)).status, 200);
});
