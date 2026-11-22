import os from 'node:os';
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
    // 여러 인스턴스로 돌 때(docs/adr/0003). REDIS_URL 이 없으면 단일 인스턴스용 메모리 버스를 쓴다.
    redisUrl: env.REDIS_URL?.trim() || null,
    // 배포 주소(6단계). 다운로드 페이지·README 안내에 쓴다. 예: https://chzzk.example.com
    // 리버스 프록시(Caddy·Traefik) 뒤에서 X-Forwarded-Proto 를 믿을 대상. HTTPS 판단(세션 쿠키 Secure)에 쓴다.
    //   loopback(기본) | uniquelocal(도커·k8s 사설망) | true 등 Express trust proxy 값
    trustProxy: env.TRUST_PROXY?.trim() || 'loopback',
    publicUrl: env.PUBLIC_URL?.trim().replace(/\/$/, '') || null,
    // 공개 조회 API·시청자 WebSocket 을 허용할 다른 출처(데스크톱 클라이언트). 쉼표로 여러 개.
    allowedOrigins: (env.ALLOWED_ORIGINS ?? 'app://chzzk').split(',').map((o) => o.trim()).filter(Boolean),
    // 데스크톱 클라이언트 설치 파일이 있는 곳(GitHub Releases 의 최신 릴리스)
    downloadBaseUrl: (env.DOWNLOAD_BASE_URL?.trim() || 'https://github.com/qswd0821/chzzk/releases/latest/download').replace(/\/$/, ''),
    // k8s 에서는 파드 이름(HOSTNAME)이 인스턴스 이름이 된다.
    instanceId: env.INSTANCE_ID?.trim() || env.HOSTNAME?.trim() || os.hostname(),
    live: {
      // 송출자 연결이 끊긴 뒤 다시 붙기를 기다리는 시간. 지나면 라이브를 종료한다.
      reconnectGraceMs: (Number(env.LIVE_RECONNECT_GRACE_SECONDS) || 20) * 1000,
    },
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
