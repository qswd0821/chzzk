import express from 'express';
import { setSessionCookie, clearSessionCookie } from './session-cookie.js';

// /api/auth — 회원가입·로그인·로그아웃·현재 회원 조회
export function createAuthRouter({ service }) {
  const router = express.Router();
  router.use(express.json({ limit: '10kb' }));

  // { username, password, nickname } → 201 { member } + 세션 쿠키
  router.post('/signup', async (req, res, next) => {
    try {
      const { member, token } = await service.signup(req.body ?? {});
      setSessionCookie(req, res, token);
      res.status(201).json({ member });
    } catch (err) {
      next(err);
    }
  });

  // { username, password } → 200 { member } + 세션 쿠키
  router.post('/login', async (req, res, next) => {
    try {
      const { member, token } = await service.login(req.body ?? {});
      setSessionCookie(req, res, token);
      res.json({ member });
    } catch (err) {
      next(err);
    }
  });

  // 서버의 세션을 지우므로 같은 토큰은 즉시 쓸 수 없게 된다.
  router.post('/logout', (req, res) => {
    service.logout(req.sessionToken);
    clearSessionCookie(req, res);
    res.status(204).end();
  });

  // 로그인 상태 확인. 비로그인이면 { member: null }
  router.get('/me', (req, res) => {
    res.json({ member: req.member });
  });

  return router;
}
