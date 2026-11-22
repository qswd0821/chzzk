import { forbidden, unauthorized } from '../http/errors.js';
import { SESSION_TTL_MS } from './auth.service.js';

export const SESSION_COOKIE = 'chzzk_session';

// 요청 쿠키에서 세션 토큰을 꺼낸다. Express 요청과 WebSocket 업그레이드 요청 모두에 쓴다.
export function readSessionToken(req) {
  for (const part of String(req.headers.cookie ?? '').split(';')) {
    const [name, ...rest] = part.trim().split('=');
    if (name === SESSION_COOKIE) return decodeURIComponent(rest.join('='));
  }
  return null;
}

// HttpOnly: 페이지 스크립트가 토큰을 읽지 못한다(XSS로 탈취 방지).
// SameSite=Lax: 다른 사이트에서 보낸 POST 등에는 쿠키가 실리지 않는다(CSRF 방지).
export function setSessionCookie(req, res, token) {
  res.cookie(SESSION_COOKIE, token, {
    httpOnly: true,
    sameSite: 'lax',
    secure: req.secure,
    path: '/',
    maxAge: SESSION_TTL_MS,
  });
}

export function clearSessionCookie(req, res) {
  res.clearCookie(SESSION_COOKIE, { httpOnly: true, sameSite: 'lax', secure: req.secure, path: '/' });
}

// 모든 요청에서 쿠키를 확인해 req.member(회원 또는 null)를 채운다.
export function loadMember(authService) {
  return (req, _res, next) => {
    req.sessionToken = readSessionToken(req);
    req.member = authService.authenticate(req.sessionToken);
    next();
  };
}

export function requireLogin(req, _res, next) {
  next(req.member ? undefined : unauthorized());
}

// SameSite 를 보조하는 CSRF 방어: 상태를 바꾸는 요청에 다른 출처의 Origin 이 붙어 있으면 거절한다.
export function rejectCrossOrigin(req, _res, next) {
  if (['GET', 'HEAD', 'OPTIONS'].includes(req.method)) return next();
  next(isSameOrigin(req) ? undefined : forbidden('다른 사이트에서 보낸 요청은 처리하지 않습니다.'));
}

export function isSameOrigin(req) {
  const origin = req.headers.origin;
  if (!origin) return true;
  try {
    return new URL(origin).host === req.headers.host;
  } catch {
    return false;
  }
}
