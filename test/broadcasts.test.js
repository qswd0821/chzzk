// 녹화방송 (1단계 기능 유지 + 3단계 소유자 권한)
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { openDatabase } from '../src/database.js';
import { startTestServer, videoForm } from './helpers.js';

let t;
let owner;
let other;

before(async () => {
  t = await startTestServer({ env: { MAX_UPLOAD_MB: '1' } });
  owner = await t.signup('owner');
  other = await t.signup('other');
});

after(async () => {
  await t.stop();
});

const post = (form, cookie) => t.request('/api/broadcasts', { method: 'POST', form, cookie });

test('로그인한 회원은 파일을 업로드해 방송을 등록하고, 업로드 영상을 Range 요청으로 받을 수 있다', async () => {
  const bytes = Buffer.from('fake-mp4-bytes-0123456789');
  const res = await post(videoForm({ title: '업로드 방송', description: '설명' }, { bytes, type: 'video/mp4', name: 'rec.mp4' }), owner.cookie);
  assert.equal(res.status, 201);
  assert.equal(res.body.title, '업로드 방송');
  assert.equal(res.body.sourceType, 'upload');
  assert.equal(res.body.fileSize, bytes.length);
  assert.deepEqual(res.body.owner, { id: owner.member.id, nickname: owner.member.nickname });
  assert.match(res.body.videoSrc, /^\/media\/.+\.mp4$/);

  const media = await fetch(`${t.baseUrl}${res.body.videoSrc}`, { headers: { Range: 'bytes=0-3' } });
  assert.equal(media.status, 206);
  assert.equal(await media.text(), 'fake');
});

test('외부 영상 URL로 방송을 등록할 수 있다', async () => {
  const res = await post(videoForm({ title: 'URL 방송', videoUrl: 'https://cdn.example.com/vod/1.mp4' }), owner.cookie);
  assert.equal(res.status, 201);
  assert.equal(res.body.sourceType, 'url');
  assert.equal(res.body.videoSrc, 'https://cdn.example.com/vod/1.mp4');
});

test('비로그인 등록은 401이고 업로드 파일이 디스크에 남지 않는다', async () => {
  const before = fs.readdirSync(t.config.uploadDir).length;
  const res = await post(videoForm({ title: '몰래' }, { bytes: Buffer.from('v'), type: 'video/mp4', name: 'a.mp4' }));
  assert.equal(res.status, 401);
  assert.equal(fs.readdirSync(t.config.uploadDir).length, before);

  const fake = await post(videoForm({ title: '가짜 쿠키', videoUrl: 'https://a.com/x.mp4' }), 'chzzk_session=forged');
  assert.equal(fake.status, 401);
});

test('목록·상세는 비로그인도 볼 수 있고 최신순이다', async () => {
  const list = await t.request('/api/broadcasts');
  assert.equal(list.status, 200);
  assert.deepEqual(list.body.map((b) => b.title), ['URL 방송', '업로드 방송']);

  const detail = await t.request(`/api/broadcasts/${list.body[1].id}`);
  assert.equal(detail.status, 200);
  assert.equal(detail.body.description, '설명');

  assert.equal((await t.request('/api/broadcasts/9999')).status, 404);
  assert.equal((await t.request('/api/broadcasts/abc')).status, 404);
});

test('잘못된 등록 요청은 400이고 업로드된 파일을 남기지 않는다', async () => {
  const before = fs.readdirSync(t.config.uploadDir).length;
  const cases = [
    [videoForm({ title: '', videoUrl: 'https://a.com/x.mp4' }), '제목'],
    [videoForm({ title: '영상 없음' }), '영상'],
    [videoForm({ title: 'x', videoUrl: 'javascript:alert(1)' }), 'http'],
    [videoForm({ title: 'x', videoUrl: 'not a url' }), '형식'],
    [videoForm({ title: 'x'.repeat(101), videoUrl: 'https://a.com/x.mp4' }), '100자'],
    [videoForm({ title: '' }, { bytes: Buffer.from('v'), type: 'video/mp4', name: 'a.mp4' }), '제목'],
    [videoForm({ title: '둘 다', videoUrl: 'https://a.com/x.mp4' }, { bytes: Buffer.from('v'), type: 'video/mp4', name: 'a.mp4' }), '하나만'],
    [videoForm({ title: '문서' }, { bytes: Buffer.from('v'), type: 'text/plain', name: 'a.txt' }), 'video'],
    [videoForm({ title: '큰 파일' }, { bytes: Buffer.alloc(1024 * 1024 + 1), type: 'video/mp4', name: 'big.mp4' }), '너무 큽니다'],
  ];
  for (const [form, expected] of cases) {
    const res = await post(form, owner.cookie);
    assert.equal(res.status, 400, expected);
    assert.match(res.body.error, new RegExp(expected));
  }
  // multer 가 실패한 업로드 파일을 정리할 시간을 준다
  await new Promise((r) => setTimeout(r, 100));
  assert.equal(fs.readdirSync(t.config.uploadDir).length, before);
  assert.equal((await t.request('/api/broadcasts')).body.length, 2);
});

test('수정은 소유자만: 비로그인 401, 다른 회원 403, 소유자 200', async () => {
  const [, upload] = (await t.request('/api/broadcasts')).body;
  const patch = (cookie) => t.request(`/api/broadcasts/${upload.id}`, { method: 'PATCH', cookie, json: { title: '바뀐 제목', description: '바뀐 설명' } });

  assert.equal((await patch()).status, 401);
  assert.equal((await patch(other.cookie)).status, 403);
  const ok = await patch(owner.cookie);
  assert.equal(ok.status, 200);
  assert.equal(ok.body.title, '바뀐 제목');
  assert.equal(ok.body.description, '바뀐 설명');

  const empty = await t.request(`/api/broadcasts/${upload.id}`, { method: 'PATCH', cookie: owner.cookie, json: { title: ' ' } });
  assert.equal(empty.status, 400);
});

test('삭제는 소유자만 할 수 있고, 업로드 파일과 댓글이 함께 지워진다', async () => {
  const created = await post(videoForm({ title: '지울 방송' }, { bytes: Buffer.from('bye'), type: 'video/mp4', name: 'bye.mp4' }), owner.cookie);
  const id = created.body.id;
  const file = path.join(t.config.uploadDir, created.body.videoLocation);
  await t.request(`/api/broadcasts/${id}/comments`, { method: 'POST', cookie: other.cookie, json: { body: '곧 지워질 댓글' } });

  assert.equal((await t.request(`/api/broadcasts/${id}`, { method: 'DELETE' })).status, 401);
  assert.equal((await t.request(`/api/broadcasts/${id}`, { method: 'DELETE', cookie: other.cookie })).status, 403);
  assert.ok(fs.existsSync(file));

  assert.equal((await t.request(`/api/broadcasts/${id}`, { method: 'DELETE', cookie: owner.cookie })).status, 204);
  assert.equal((await t.request(`/api/broadcasts/${id}`)).status, 404);
  assert.equal((await t.request(`/api/broadcasts/${id}/comments`)).status, 404);
  assert.equal(t.db.prepare('SELECT COUNT(*) AS n FROM comments WHERE target_type = ? AND target_id = ?').get('broadcast', id).n, 0);
  await new Promise((r) => setTimeout(r, 50));
  assert.ok(!fs.existsSync(file));
});

test('다른 사이트(Origin)에서 보낸 변경 요청은 로그인 쿠키가 있어도 거절한다', async () => {
  const res = await t.request('/api/broadcasts', {
    method: 'POST',
    cookie: owner.cookie,
    headers: { Origin: 'https://evil.example.com' },
    form: videoForm({ title: 'CSRF', videoUrl: 'https://a.com/x.mp4' }),
  });
  assert.equal(res.status, 403);
});

test('서버를 재시작해도 등록한 방송과 로그인 세션이 그대로다', async () => {
  await t.restart();
  const list = await t.request('/api/broadcasts');
  assert.equal(list.body.length, 2);
  assert.equal((await fetch(`${t.baseUrl}${list.body[1].videoSrc}`)).status, 200);
  assert.equal((await t.request('/api/auth/me', { cookie: owner.cookie })).body.member.id, owner.member.id);
});

test('이전 단계에서 만든 DB도 데이터를 유지한 채 열리고, 그 방송은 소유자가 없어 아무도 관리할 수 없다', async () => {
  const legacyPath = path.join(t.tmpDir, 'legacy.db');
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
  assert.equal(reopened.prepare('PRAGMA user_version').get().user_version, 3);
  const row = reopened.prepare('SELECT title, owner_id FROM broadcasts').get();
  assert.equal(row.title, '예전 방송');
  assert.equal(row.owner_id, null);
  reopened.close();

  // 같은 상황을 실행 중인 서버에서: 소유자 없는 방송은 누구도 수정할 수 없다
  t.db.prepare(`INSERT INTO broadcasts (title, source_type, video_location) VALUES ('주인 없는 방송', 'url', 'https://a.com/y.mp4')`).run();
  const orphan = (await t.request('/api/broadcasts')).body.find((b) => b.title === '주인 없는 방송');
  assert.equal(orphan.owner, null);
  assert.equal((await t.request(`/api/broadcasts/${orphan.id}`, { method: 'DELETE', cookie: owner.cookie })).status, 403);
});

test('화면과 목록은 로그인 없이 열린다', async () => {
  const page = await fetch(`${t.baseUrl}/`);
  assert.equal(page.status, 200);
  assert.match(await page.text(), /치지직/);
});
