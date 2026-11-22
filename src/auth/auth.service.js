import crypto from 'node:crypto';
import { badRequest, conflict, unauthorized } from '../http/errors.js';
import { hashPassword, verifyPassword, DUMMY_HASH } from './password.js';

export const SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000;

const USERNAME = /^[a-z0-9_]{3,20}$/;
const PASSWORD_MIN = 8;
const PASSWORD_MAX = 100;

// 회원가입·로그인·로그아웃과 "이 세션 토큰은 누구인가". HTTP 쿠키는 모른다.
export function createAuthService({ repository }) {
  repository.deleteExpiredSessions();

  async function openSession(member) {
    const token = crypto.randomBytes(32).toString('base64url');
    const expiresAt = new Date(Date.now() + SESSION_TTL_MS);
    repository.createSession(hashToken(token), member.id, expiresAt.toISOString());
    return { member, token, expiresAt };
  }

  return {
    // 가입하면 바로 로그인된다.
    async signup({ username, password, nickname }) {
      const cleanUsername = String(username ?? '').trim().toLowerCase();
      const cleanNickname = String(nickname ?? '').trim();
      const rawPassword = String(password ?? '');

      if (!USERNAME.test(cleanUsername)) throw badRequest('아이디는 영문 소문자·숫자·_ 3~20자여야 합니다.');
      if (rawPassword.length < PASSWORD_MIN) throw badRequest(`비밀번호는 ${PASSWORD_MIN}자 이상이어야 합니다.`);
      if (rawPassword.length > PASSWORD_MAX) throw badRequest(`비밀번호는 ${PASSWORD_MAX}자 이하여야 합니다.`);
      if (cleanNickname.length < 2 || cleanNickname.length > 20) throw badRequest('닉네임은 2~20자여야 합니다.');
      if (repository.usernameTaken(cleanUsername)) throw conflict('이미 사용 중인 아이디입니다.');
      if (repository.nicknameTaken(cleanNickname)) throw conflict('이미 사용 중인 닉네임입니다.');

      const passwordHash = await hashPassword(rawPassword);
      let member;
      try {
        member = repository.create({ username: cleanUsername, nickname: cleanNickname, passwordHash });
      } catch (err) {
        // 위 검사와 저장 사이에 같은 아이디·닉네임으로 동시에 가입한 경우
        if (/UNIQUE constraint failed: members\.username/.test(err.message)) throw conflict('이미 사용 중인 아이디입니다.');
        if (/UNIQUE constraint failed: members\.nickname/.test(err.message)) throw conflict('이미 사용 중인 닉네임입니다.');
        throw err;
      }
      return openSession(member);
    },

    async login({ username, password }) {
      const credentials = repository.findCredentialsByUsername(String(username ?? '').trim().toLowerCase());
      // 아이디가 없어도 같은 시간을 쓰도록 가짜 해시와 비교한다(아이디 존재 여부 추측 방지).
      const ok = await verifyPassword(String(password ?? ''), credentials?.passwordHash ?? DUMMY_HASH);
      if (!credentials || !ok) throw unauthorized('아이디 또는 비밀번호가 올바르지 않습니다.');
      return openSession(credentials.member);
    },

    logout(token) {
      if (token) repository.deleteSession(hashToken(token));
    },

    // 유효한 세션 토큰이면 회원, 아니면 null
    authenticate(token) {
      return token ? repository.findMemberBySession(hashToken(token)) : null;
    },
  };
}

function hashToken(token) {
  return crypto.createHash('sha256').update(token).digest('hex');
}
