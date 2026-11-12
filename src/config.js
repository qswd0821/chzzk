import path from 'node:path';
import { fileURLToPath } from 'node:url';

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

export function loadConfig(env = process.env) {
  const dataDir = path.resolve(projectRoot, env.DATA_DIR || './data');
  return {
    port: Number(env.PORT) || 3000,
    dataDir,
    dbPath: path.join(dataDir, 'replay.db'),
    uploadDir: path.join(dataDir, 'uploads'),
    maxUploadBytes: (Number(env.MAX_UPLOAD_MB) || 500) * 1024 * 1024,
    publicDir: path.join(projectRoot, 'public'),
    // 휴대폰 브라우저는 HTTPS에서만 카메라·마이크를 허용한다.
    https: {
      enabled: env.HTTPS === 'true',
      keyPath: env.HTTPS_KEY ? path.resolve(projectRoot, env.HTTPS_KEY) : null,
      certPath: env.HTTPS_CERT ? path.resolve(projectRoot, env.HTTPS_CERT) : null,
      generatedDir: path.join(dataDir, 'tls'),
    },
    iceServers: buildIceServers(env),
  };
}

// 브라우저 RTCPeerConnection 에 그대로 넘기는 ICE 서버 목록
function buildIceServers(env) {
  const stunUrls = (env.STUN_URLS ?? 'stun:stun.l.google.com:19302')
    .split(',').map((url) => url.trim()).filter(Boolean);
  const servers = stunUrls.length ? [{ urls: stunUrls }] : [];
  if (env.TURN_URL) {
    servers.push({
      urls: env.TURN_URL.split(',').map((url) => url.trim()),
      username: env.TURN_USERNAME || undefined,
      credential: env.TURN_CREDENTIAL || undefined,
    });
  }
  return servers;
}
