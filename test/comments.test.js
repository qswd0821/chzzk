// 방송별 댓글: 조회는 공개, 작성은 로그인 회원, 수정·삭제는 작성자만
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startTestServer, videoForm } from './helpers.js';

let t;
let owner;
let writer;
let other;
let broadcastId;
let liveId;

before(async () => {
  t = await startTestServer({ liveOptions: { broadcasterConnectTimeoutMs: 60_000 } });
  owner = await t.signup('vodowner');
  writer = await t.signup('writer');
  other = await t.signup('another');
  broadcastId = (await t.request('/api/broadcasts', {
    method: 'POST', cookie: owner.cookie, form: videoForm({ title: '댓글 달 방송', videoUrl: 'https://a.com/x.mp4' }),
  })).body.id;
  liveId = (await t.request('/api/lives', { method: 'POST', cookie: owner.cookie, json: { title: '댓글 달 라이브' } })).body.id;
});

after(async () => {
  await t.stop();
});

const write = (path, body, cookie) => t.request(path, { method: 'POST', cookie, json: { body } });

test('비로그인 댓글 작성은 401이고 저장되지 않는다', async () => {
  const res = await write(`/api/broadcasts/${broadcastId}/comments`, '익명 댓글');
  assert.equal(res.status, 401);
  assert.equal((await t.request(`/api/broadcasts/${broadcastId}/comments`)).body.length, 0);
});

test('로그인 회원은 녹화방송과 라이브 방송에 댓글을 쓰고, 작성자가 연결된다', async () => {
  const onVod = await write(`/api/broadcasts/${broadcastId}/comments`, '  첫 댓글  ', writer.cookie);
  assert.equal(onVod.status, 201);
  assert.equal(onVod.body.body, '첫 댓글');
  assert.deepEqual(onVod.body.author, { id: writer.member.id, nickname: writer.member.nickname });
  assert.equal(onVod.body.targetType, 'broadcast');

  const onLive = await write(`/api/lives/${liveId}/comments`, '라이브 댓글', other.cookie);
  assert.equal(onLive.status, 201);
  assert.equal(onLive.body.targetType, 'live');

  // 두 번째 댓글
  await write(`/api/broadcasts/${broadcastId}/comments`, '두 번째', other.cookie);
});

test('방송별 댓글 목록은 비로그인도 볼 수 있고, 오래된 순이며 다른 방송의 댓글이 섞이지 않는다', async () => {
  const vod = await t.request(`/api/broadcasts/${broadcastId}/comments`);
  assert.equal(vod.status, 200);
  assert.deepEqual(vod.body.map((c) => c.body), ['첫 댓글', '두 번째']);

  const live = await t.request(`/api/lives/${liveId}/comments`);
  assert.deepEqual(live.body.map((c) => c.body), ['라이브 댓글']);

  assert.equal((await t.request('/api/broadcasts/9999/comments')).status, 404);
  assert.equal((await write('/api/lives/9999/comments', '없는 방송', writer.cookie)).status, 404);
});

test('댓글 내용 검증', async () => {
  assert.equal((await write(`/api/broadcasts/${broadcastId}/comments`, '   ', writer.cookie)).status, 400);
  assert.equal((await write(`/api/broadcasts/${broadcastId}/comments`, 'x'.repeat(501), writer.cookie)).status, 400);
});

test('댓글 수정은 작성자만: 비로그인 401, 다른 회원 403(방송 소유자도), 작성자 200', async () => {
  const [mine] = (await t.request(`/api/broadcasts/${broadcastId}/comments`)).body;
  const edit = (cookie) => t.request(`/api/comments/${mine.id}`, { method: 'PATCH', cookie, json: { body: '고친 댓글' } });

  assert.equal((await edit()).status, 401);
  assert.equal((await edit(other.cookie)).status, 403);
  assert.equal((await edit(owner.cookie)).status, 403, '방송 소유자라도 남의 댓글은 고칠 수 없다');

  const ok = await edit(writer.cookie);
  assert.equal(ok.status, 200);
  assert.equal(ok.body.body, '고친 댓글');
  assert.ok(ok.body.updatedAt);
});

test('댓글 삭제는 작성자만 할 수 있다', async () => {
  const [mine] = (await t.request(`/api/broadcasts/${broadcastId}/comments`)).body;
  const del = (cookie) => t.request(`/api/comments/${mine.id}`, { method: 'DELETE', cookie });

  assert.equal((await del()).status, 401);
  assert.equal((await del(other.cookie)).status, 403);
  assert.equal((await del(owner.cookie)).status, 403);
  assert.equal((await del(writer.cookie)).status, 204);
  assert.equal((await del(writer.cookie)).status, 404);
  assert.deepEqual((await t.request(`/api/broadcasts/${broadcastId}/comments`)).body.map((c) => c.body), ['두 번째']);
});

test('종료된 라이브에도 댓글을 조회·작성할 수 있다', async () => {
  await t.request(`/api/lives/${liveId}/end`, { method: 'POST', cookie: owner.cookie });
  assert.equal((await write(`/api/lives/${liveId}/comments`, '다시보기 감상', writer.cookie)).status, 201);
  assert.equal((await t.request(`/api/lives/${liveId}/comments`)).body.length, 2);
});

test('댓글은 서버를 재시작해도 남아 있다', async () => {
  await t.restart();
  assert.equal((await t.request(`/api/broadcasts/${broadcastId}/comments`)).body.length, 1);
  assert.equal((await t.request(`/api/lives/${liveId}/comments`)).body.length, 2);
});
