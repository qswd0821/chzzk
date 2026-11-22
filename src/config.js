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
    payment: buildPaymentConfig(env),
  };
}

// 후원 결제 서비스. PAYMENT_PROVIDER=auto(기본)이면 토스 테스트 키가 있을 때 토스, 없으면 내장 모의 결제를 쓴다.
// (docs/adr/0002-payment-provider-port-with-mock.md)
function buildPaymentConfig(env) {
  const toss = {
    clientKey: env.TOSS_CLIENT_KEY?.trim() || null,
    secretKey: env.TOSS_SECRET_KEY?.trim() || null,
    apiBase: (env.TOSS_API_BASE?.trim() || 'https://api.tosspayments.com').replace(/\/$/, ''),
  };
  const requested = (env.PAYMENT_PROVIDER ?? 'auto').trim().toLowerCase();
  const provider = requested === 'auto' ? (toss.clientKey && toss.secretKey ? 'toss' : 'mock') : requested;
  if (!['toss', 'mock'].includes(provider)) throw new Error(`PAYMENT_PROVIDER 는 auto, toss, mock 중 하나여야 합니다: ${requested}`);
  if (provider === 'toss' && (!toss.clientKey || !toss.secretKey)) {
    throw new Error('PAYMENT_PROVIDER=toss 이면 TOSS_CLIENT_KEY 와 TOSS_SECRET_KEY 가 필요합니다.');
  }
  if (provider === 'toss' && (!toss.clientKey.startsWith('test_') || !toss.secretKey.startsWith('test_'))) {
    // 이 과제는 테스트 결제만 다룬다. live_ 키로 실제 돈이 오가지 않게 막는다.
    throw new Error('토스 키는 테스트 키(test_ck_…, test_sk_…)만 사용할 수 있습니다.');
  }
  return { provider, toss };
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
