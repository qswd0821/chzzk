// 6단계: 데스크톱 클라이언트(app://chzzk)에 공개 조회만 허용, 다운로드 정보·페이지
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import WebSocket from 'ws';
import { startTestServer, videoForm } from './helpers.js';

let t;
let owner;
let liveId;

before(async () => {
  t = await startTestServer({ env: { PUBLIC_URL: 'https://chzzk.example.com/' }, liveOptions: { connectWindowMs: 60_000 } });
  owner = await t.signup('deskowner');
  await t.request('/api/broadcasts', { method: 'POST', cookie: owner.cookie, form: videoForm({ title: '앱에서 볼 방송', videoUrl: 'https://a.com/x.mp4' }) });
  liveId = (await t.request('/api/lives', { method: 'POST', cookie: owner.cookie, json: { title: '앱에서 볼 라이브' } })).body.id;
});

after(async () => {
  await t.stop();
});

const APP = { Origin: 'app://chzzk' };

test('클라이언트 출처의 공개 조회(GET)에는 CORS 허용 헤더가 붙고, 다른 사이트에는 붙지 않는다', async () => {
  for (const path of ['/api/broadcasts', '/api/lives', `/api/lives/${liveId}`, '/api/lives/rtc-config', `/api/lives/${liveId}/comments`, `/api/lives/${liveId}/donations`]) {
    const res = await t.request(path, { headers: APP });
    assert.equal(res.status, 200, path);
    assert.equal(res.headers.get('access-control-allow-origin'), 'app://chzzk', path);
    assert.equal(res.headers.get('access-control-allow-credentials'), null, '쿠키는 허용하지 않는다');
  }
  const evil = await t.request('/api/broadcasts', { headers: { Origin: 'https://evil.example.com' } });
  assert.equal(evil.headers.get('access-control-allow-origin'), null);

  const preflight = await t.request('/api/broadcasts', { method: 'OPTIONS', headers: APP });
  assert.equal(preflight.status, 204);
  assert.equal(preflight.headers.get('access-control-allow-methods'), 'GET, HEAD');
});

test('클라이언트 출처에서 온 쓰기 요청은 로그인 쿠키가 있어도 거절한다', async () => {
  const res = await t.request('/api/lives', { method: 'POST', cookie: owner.cookie, headers: APP, json: { title: '앱에서 시작?' } });
  assert.equal(res.status, 403);
  const del = await t.request(`/api/lives/${liveId}`, { method: 'DELETE', cookie: owner.cookie, headers: APP });
  assert.equal(del.status, 403);
});

test('클라이언트 출처의 WebSocket 은 시청자로만 참여할 수 있다', async () => {
  const connect = (headers) => {
    const ws = new WebSocket(t.wsUrl, { headers });
    const inbox = [];
    const opened = new Promise((resolve, reject) => { ws.on('open', resolve); ws.on('unexpected-response', (_q, r) => reject(new Error(`HTTP ${r.statusCode}`))); });
    ws.on('message', (raw) => inbox.push(JSON.parse(raw)));
    const next = async (type) => {
      for (let i = 0; i < 100; i++) {
        const idx = inbox.findIndex((m) => m.type === type);
        if (idx >= 0) return inbox.splice(idx, 1)[0];
        await new Promise((r) => setTimeout(r, 20));
      }
      throw new Error(`no ${type}`);
    };
    return { ws, opened, next, send: (m) => ws.send(JSON.stringify(m)) };
  };

  const viewer = connect(APP);
  await viewer.opened;
  viewer.send({ type: 'join', role: 'viewer', liveId });
  assert.equal((await viewer.next('joined')).role, 'viewer');

  // 소유자 쿠키를 실어도 클라이언트 출처에서는 회원으로 보지 않아 송출자로 참여할 수 없다.
  const fake = connect({ ...APP, cookie: owner.cookie });
  await fake.opened;
  fake.send({ type: 'join', role: 'broadcaster', liveId });
  assert.match((await fake.next('error')).error, /로그인/);

  const evil = connect({ Origin: 'https://evil.example.com' });
  await assert.rejects(evil.opened, /HTTP 401|HTTP 403|HTTP 400/);
  viewer.ws.close();
});

test('다운로드 정보: OS·아키텍처별 파일이 GitHub Releases 최신 릴리스 주소로 연결된다', async () => {
  const { body } = await t.request('/api/client/downloads');
  assert.equal(body.serverUrl, 'https://chzzk.example.com');
  const names = body.files.map((f) => `${f.os}-${f.arch}-${f.kind}`);
  assert.deepEqual(names.sort(), [
    'macos-arm64-installer', 'macos-arm64-portable', 'macos-x64-installer', 'macos-x64-portable',
    'windows-x64-installer', 'windows-x64-portable',
  ]);
  for (const f of body.files) assert.match(f.url, /^https:\/\/github\.com\/qswd0821\/chzzk\/releases\/latest\/download\/Chzzk-/);
});

test('다운로드 페이지(/download)와 상태 확인 경로(/healthz)가 열린다', async () => {
  const page = await fetch(`${t.baseUrl}/download`);
  assert.equal(page.status, 200);
  assert.match(await page.text(), /치지직 데스크톱 앱/);
  assert.equal((await t.request('/healthz')).body.status, 'ok');
});
