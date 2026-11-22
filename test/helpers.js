import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { once } from 'node:events';
import WebSocket from 'ws';
import { loadConfig } from '../src/config.js';
import { openDatabase } from '../src/database.js';
import { createApplication } from '../src/app.js';
import { createMemoryBus } from '../src/realtime/bus.js';

// 라이브 시간 값은 테스트가 빨리 끝나도록 짧게 둔다.
export const FAST_LIVE = { connectWindowMs: 300, reconnectGraceMs: 300, sweepIntervalMs: 50 };

// 임시 디렉터리에 서버를 띄운다. restart() 는 같은 데이터로 다시 띄운다(영속 저장 확인용).
// dataDir·bus 를 넘기면 다른 인스턴스와 같은 DB 파일·같은 버스를 쓴다(여러 인스턴스 시험용).
export async function startTestServer({ env = {}, liveOptions = {}, dataDir, bus, instanceId } = {}) {
  const tmpDir = dataDir ?? fs.mkdtempSync(path.join(os.tmpdir(), 'chzzk-test-'));
  const config = loadConfig({ DATA_DIR: tmpDir, INSTANCE_ID: instanceId ?? 'test-1', ...env });
  const ctx = { config, tmpDir };

  async function start() {
    ctx.db = openDatabase(config.dbPath);
    ctx.bus = bus ?? createMemoryBus();
    const { app, attachTo } = createApplication({ db: ctx.db, config, bus: ctx.bus, liveOptions: { ...FAST_LIVE, ...liveOptions } });
    const attached = await attachTo(app.listen(0));
    ctx.server = attached.server;
    ctx.shutdown = attached.shutdown;
    const { port } = ctx.server.address();
    ctx.baseUrl = `http://127.0.0.1:${port}`;
    ctx.wsUrl = `ws://127.0.0.1:${port}/ws/lives`;
  }

  async function stopServer() {
    ctx.shutdown();
    ctx.server.closeAllConnections();
    ctx.server.close();
    await once(ctx.server, 'close');
    ctx.db.close();
  }

  await start();
  ctx.restart = async () => { await stopServer(); await start(); };
  ctx.stop = async ({ keepData = !!dataDir } = {}) => {
    await stopServer();
    if (!keepData) fs.rmSync(tmpDir, { recursive: true, force: true });
  };

  // fetch 래퍼: cookie(로그인 회원), json 또는 form 본문
  ctx.request = async (pathname, { method = 'GET', cookie, json, form, headers = {} } = {}) => {
    const res = await fetch(ctx.baseUrl + pathname, {
      method,
      headers: {
        ...(cookie ? { cookie } : {}),
        ...(json !== undefined ? { 'Content-Type': 'application/json' } : {}),
        ...headers,
      },
      body: json !== undefined ? JSON.stringify(json) : form,
    });
    const text = await res.text();
    let body = null;
    try { body = text ? JSON.parse(text) : null; } catch { body = text; }
    return { status: res.status, body, headers: res.headers };
  };

  // 가입하고 세션 쿠키("chzzk_session=...")를 돌려준다.
  ctx.signup = async (username, nickname = `${username}닉`) => {
    const res = await ctx.request('/api/auth/signup', {
      method: 'POST',
      json: { username, password: 'password123', nickname },
    });
    if (res.status !== 201) throw new Error(`signup failed: ${res.status} ${JSON.stringify(res.body)}`);
    return { cookie: res.headers.get('set-cookie').split(';')[0], member: res.body.member };
  };

  // 받은 메시지를 쌓아 두고, 원하는 type 이 올 때까지 기다리는 WebSocket 클라이언트
  ctx.connect = (cookie) => {
    const socket = new WebSocket(ctx.wsUrl, cookie ? { headers: { cookie } } : undefined);
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
      closed: once(socket, 'close'),
      opened: once(socket, 'open'),
      send: (msg) => socket.send(JSON.stringify(msg)),
      next(type) {
        const i = inbox.findIndex((m) => m.type === type);
        if (i >= 0) return Promise.resolve(inbox.splice(i, 1)[0]);
        return new Promise((resolve) => waiters.push({ type, resolve }));
      },
    };
  };

  return ctx;
}

export function videoForm(fields, file) {
  const form = new FormData();
  for (const [k, v] of Object.entries(fields)) form.append(k, v);
  if (file) form.append('videoFile', new Blob([file.bytes], { type: file.type }), file.name);
  return form;
}
