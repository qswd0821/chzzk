// 회원가입·로그인·로그아웃과 인증 상태
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startTestServer } from './helpers.js';

let t;

before(async () => {
  t = await startTestServer();
});

after(async () => {
  await t.stop();
});

const signup = (json) => t.request('/api/auth/signup', { method: 'POST', json });
const login = (json) => t.request('/api/auth/login', { method: 'POST', json });
const cookieOf = (res) => res.headers.get('set-cookie')?.split(';')[0];

test('가입하면 바로 로그인되고, 세션 쿠키는 HttpOnly·SameSite=Lax 다', async () => {
  const res = await signup({ username: 'alice', password: 'password123', nickname: '앨리스' });
  assert.equal(res.status, 201);
  assert.deepEqual(Object.keys(res.body.member).sort(), ['createdAt', 'id', 'nickname', 'username']);
  assert.equal(res.body.member.passwordHash, undefined);

  const setCookie = res.headers.get('set-cookie');
  assert.match(setCookie, /chzzk_session=/);
  assert.match(setCookie, /HttpOnly/i);
  assert.match(setCookie, /SameSite=Lax/i);

  const me = await t.request('/api/auth/me', { cookie: cookieOf(res) });
  assert.equal(me.body.member.nickname, '앨리스');
});

test('비밀번호는 평문이 아닌 scrypt 해시로 저장된다', () => {
  const row = t.db.prepare('SELECT password_hash FROM members WHERE username = ?').get('alice');
  assert.match(row.password_hash, /^scrypt\$/);
  assert.ok(!row.password_hash.includes('password123'));
});

test('가입 입력 검증과 중복 검사', async () => {
  const cases = [
    [{ username: 'A!', password: 'password123', nickname: '닉' }, 400, '아이디'],
    [{ username: 'bob', password: 'short', nickname: '밥이' }, 400, '비밀번호'],
    [{ username: 'bob', password: 'password123', nickname: 'x' }, 400, '닉네임'],
    [{ username: 'alice', password: 'password123', nickname: '다른닉' }, 409, '아이디'],
    [{ username: 'alice2', password: 'password123', nickname: '앨리스' }, 409, '닉네임'],
  ];
  for (const [body, status, word] of cases) {
    const res = await signup(body);
    assert.equal(res.status, status, word);
    assert.match(res.body.error, new RegExp(word));
  }
});

test('로그인: 틀린 비밀번호·없는 아이디는 같은 401 메시지', async () => {
  const wrong = await login({ username: 'alice', password: 'wrong-password' });
  const missing = await login({ username: 'nobody', password: 'password123' });
  assert.equal(wrong.status, 401);
  assert.equal(missing.status, 401);
  assert.equal(wrong.body.error, missing.body.error);

  const ok = await login({ username: 'ALICE', password: 'password123' });
  assert.equal(ok.status, 200);
  assert.equal(ok.body.member.username, 'alice');
});

test('로그아웃하면 그 세션은 서버에서 즉시 무효가 된다', async () => {
  const ok = await login({ username: 'alice', password: 'password123' });
  const cookie = cookieOf(ok);
  assert.ok((await t.request('/api/auth/me', { cookie })).body.member);

  const out = await t.request('/api/auth/logout', { method: 'POST', cookie });
  assert.equal(out.status, 204);
  assert.match(out.headers.get('set-cookie'), /chzzk_session=;/);

  // 쿠키를 지우지 않고 예전 토큰을 다시 보내도 로그인 상태가 아니다.
  assert.equal((await t.request('/api/auth/me', { cookie })).body.member, null);
  const write = await t.request('/api/lives', { method: 'POST', cookie, json: { title: '로그아웃 후' } });
  assert.equal(write.status, 401);
});

test('세션 토큰은 DB에 원문으로 저장되지 않는다', async () => {
  const ok = await login({ username: 'alice', password: 'password123' });
  const token = cookieOf(ok).split('=')[1];
  const stored = t.db.prepare('SELECT token_hash FROM sessions').all().map((r) => r.token_hash);
  assert.ok(stored.length > 0);
  assert.ok(!stored.includes(token));
});

test('만료된 세션은 인증되지 않는다', async () => {
  const ok = await login({ username: 'alice', password: 'password123' });
  t.db.prepare(`UPDATE sessions SET expires_at = '2000-01-01T00:00:00.000Z'`).run();
  assert.equal((await t.request('/api/auth/me', { cookie: cookieOf(ok) })).body.member, null);
});
