import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { loadConfig } from '../src/config.js';
import { openDatabase } from '../src/database.js';
import { createApplication } from '../src/app.js';

let tmpDir;
let config;
let db;
let server;
let baseUrl;

function start() {
  db = openDatabase(config.dbPath);
  const { app, attachTo } = createApplication({ db, config });
  server = attachTo(app.listen(0));
  baseUrl = `http://127.0.0.1:${server.address().port}`;
}

function stop() {
  server.close();
  db.close();
}

before(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'replay-vod-'));
  config = loadConfig({ DATA_DIR: tmpDir, MAX_UPLOAD_MB: '1' });
  start();
});

after(() => {
  stop();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

function videoForm(fields, file) {
  const form = new FormData();
  for (const [k, v] of Object.entries(fields)) form.append(k, v);
  if (file) form.append('videoFile', new Blob([file.bytes], { type: file.type }), file.name);
  return form;
}

test('파일 업로드로 방송을 등록하고 업로드 영상을 Range 요청으로 받을 수 있다', async () => {
  const bytes = Buffer.from('fake-mp4-bytes-0123456789');
  const res = await fetch(`${baseUrl}/api/broadcasts`, {
    method: 'POST',
    body: videoForm({ title: '업로드 방송', description: '설명' }, { bytes, type: 'video/mp4', name: 'rec.mp4' }),
  });
  assert.equal(res.status, 201);
  const created = await res.json();
  assert.equal(created.title, '업로드 방송');
  assert.equal(created.sourceType, 'upload');
  assert.equal(created.fileSize, bytes.length);
  assert.match(created.videoSrc, /^\/media\/.+\.mp4$/);

  const media = await fetch(`${baseUrl}${created.videoSrc}`, { headers: { Range: 'bytes=0-3' } });
  assert.equal(media.status, 206);
  assert.equal(await media.text(), 'fake');
});

test('외부 영상 URL로 방송을 등록할 수 있다', async () => {
  const res = await fetch(`${baseUrl}/api/broadcasts`, {
    method: 'POST',
    body: videoForm({ title: 'URL 방송', videoUrl: 'https://cdn.example.com/vod/1.mp4' }),
  });
  assert.equal(res.status, 201);
  const created = await res.json();
  assert.equal(created.sourceType, 'url');
  assert.equal(created.videoSrc, 'https://cdn.example.com/vod/1.mp4');
});

test('목록은 최신순이고 상세 조회가 된다', async () => {
  const list = await (await fetch(`${baseUrl}/api/broadcasts`)).json();
  assert.deepEqual(list.map((b) => b.title), ['URL 방송', '업로드 방송']);

  const detail = await fetch(`${baseUrl}/api/broadcasts/${list[1].id}`);
  assert.equal(detail.status, 200);
  assert.equal((await detail.json()).description, '설명');

  assert.equal((await fetch(`${baseUrl}/api/broadcasts/9999`)).status, 404);
  assert.equal((await fetch(`${baseUrl}/api/broadcasts/abc`)).status, 404);
});

test('잘못된 등록 요청은 400이고 업로드된 파일을 남기지 않는다', async () => {
  const before = fs.readdirSync(config.uploadDir).length;
  const cases = [
    [videoForm({ title: '', videoUrl: 'https://a.com/x.mp4' }), '제목'],
    [videoForm({ title: '영상 없음' }), '영상'],
    [videoForm({ title: 'x', videoUrl: 'javascript:alert(1)' }), 'http'],
    [videoForm({ title: 'x', videoUrl: 'not a url' }), '형식'],
    [videoForm({ title: 'x'.repeat(101), videoUrl: 'https://a.com/x.mp4' }), '100자'],
    [videoForm({ title: '', }, { bytes: Buffer.from('v'), type: 'video/mp4', name: 'a.mp4' }), '제목'],
    [videoForm({ title: '둘 다', videoUrl: 'https://a.com/x.mp4' }, { bytes: Buffer.from('v'), type: 'video/mp4', name: 'a.mp4' }), '하나만'],
    [videoForm({ title: '문서' }, { bytes: Buffer.from('v'), type: 'text/plain', name: 'a.txt' }), 'video'],
    [videoForm({ title: '큰 파일' }, { bytes: Buffer.alloc(1024 * 1024 + 1), type: 'video/mp4', name: 'big.mp4' }), '너무 큽니다'],
  ];
  for (const [body, expected] of cases) {
    const res = await fetch(`${baseUrl}/api/broadcasts`, { method: 'POST', body });
    assert.equal(res.status, 400, expected);
    assert.match((await res.json()).error, new RegExp(expected));
  }
  // multer 가 실패한 업로드 파일을 정리할 시간을 준다
  await new Promise((r) => setTimeout(r, 100));
  assert.equal(fs.readdirSync(config.uploadDir).length, before);
  assert.equal((await (await fetch(`${baseUrl}/api/broadcasts`)).json()).length, 2);
});

test('서버를 재시작해도 등록한 방송이 그대로 조회된다', async () => {
  stop();
  start();
  const list = await (await fetch(`${baseUrl}/api/broadcasts`)).json();
  assert.equal(list.length, 2);
  const media = await fetch(`${baseUrl}${list[1].videoSrc}`);
  assert.equal(media.status, 200);
});

test('마이그레이션 이전에 만든 DB도 데이터를 유지한 채 열린다', () => {
  const legacyPath = path.join(tmpDir, 'legacy.db');
  const legacy = new DatabaseSync(legacyPath);
  legacy.exec(`
    CREATE TABLE broadcasts (
      id INTEGER PRIMARY KEY AUTOINCREMENT, title TEXT NOT NULL, description TEXT NOT NULL DEFAULT '',
      source_type TEXT NOT NULL, video_location TEXT NOT NULL, mime_type TEXT, file_size INTEGER,
      created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')));
    INSERT INTO broadcasts (title, source_type, video_location) VALUES ('예전 방송', 'url', 'https://a.com/x.mp4');
  `);
  legacy.close();

  const reopened = openDatabase(legacyPath);
  assert.equal(reopened.prepare('PRAGMA user_version').get().user_version, 2);
  assert.equal(reopened.prepare('SELECT title FROM broadcasts').get().title, '예전 방송');
  reopened.close();
});

test('인증 없이 화면과 API에 접근할 수 있다', async () => {
  const page = await fetch(`${baseUrl}/`);
  assert.equal(page.status, 200);
  assert.match(await page.text(), /치지직/);
});
