// 데스크톱 클라이언트(6단계)처럼 출처가 다른 앱에 공개 조회만 허용한다.
//   - 허용 출처(ALLOWED_ORIGINS, 기본 app://chzzk)의 GET/HEAD 요청에만 Access-Control-Allow-Origin 을 붙인다.
//   - 쿠키는 보내지 않는다(Allow-Credentials 없음) → 로그인이 필요한 쓰기·관리 기능은 웹에서만 된다.
//   - 쓰기 요청(POST/PATCH/DELETE)은 rejectCrossOrigin 이 그대로 403 으로 막는다.
export function allowClientOrigins(allowedOrigins) {
  const allowed = new Set(allowedOrigins);
  return (req, res, next) => {
    const origin = req.headers.origin;
    if (!origin || !allowed.has(origin)) return next();
    res.vary('Origin');
    if (req.method === 'OPTIONS') {
      res.set({
        'Access-Control-Allow-Origin': origin,
        'Access-Control-Allow-Methods': 'GET, HEAD',
        'Access-Control-Max-Age': '600',
      });
      return res.status(204).end();
    }
    if (req.method === 'GET' || req.method === 'HEAD') res.set('Access-Control-Allow-Origin', origin);
    next();
  };
}

export const isAllowedClientOrigin = (allowedOrigins, req) => allowedOrigins.includes(req.headers.origin);
