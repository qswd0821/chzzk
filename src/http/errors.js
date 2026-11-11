// 계층 어디서든 던질 수 있는 HTTP 오류. 라우터가 아니라 에러 핸들러 한 곳에서 응답으로 바꾼다.
export class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

export const badRequest = (message) => new HttpError(400, message);
export const notFound = (message) => new HttpError(404, message);

export function apiNotFoundHandler(_req, res) {
  res.status(404).json({ error: '존재하지 않는 API입니다.' });
}

export function errorHandler(err, _req, res, _next) {
  const status = err.status || err.statusCode || 500;
  if (status >= 500) console.error(err);
  res.status(status).json({ error: status >= 500 ? '서버 오류가 발생했습니다.' : err.message });
}
