import fs from 'node:fs';
import http from 'node:http';
import https from 'node:https';
import { loadConfig } from './config.js';
import { openDatabase } from './database.js';
import { createApplication } from './app.js';
import { createBus } from './realtime/bus.js';
import { loadTlsOptions, lanAddresses } from './http/tls.js';

const config = loadConfig();
fs.mkdirSync(config.dataDir, { recursive: true });

const db = openDatabase(config.dbPath);
const bus = await createBus({ redisUrl: config.redisUrl });
const { app, attachTo } = createApplication({
  db, config, bus, liveOptions: { reconnectGraceMs: config.live.reconnectGraceMs },
});

const server = config.https.enabled
  ? https.createServer(await loadTlsOptions(config.https), app)
  : http.createServer(app);
const { shutdown } = await attachTo(server);

server.listen(config.port, () => {
  const scheme = config.https.enabled ? 'https' : 'http';
  console.log(`치지직 서버 실행 중: ${scheme}://localhost:${config.port} (인스턴스 ${config.instanceId}, 버스 ${bus.kind})`);
  for (const ip of lanAddresses()) console.log(`  같은 Wi-Fi 휴대폰에서: ${scheme}://${ip}:${config.port}`);
  if (!config.https.enabled) {
    console.log('  ※ 휴대폰에서 라이브 송출을 하려면 HTTPS=true 로 실행하세요 (카메라·마이크는 HTTPS에서만 허용됩니다).');
  }
  console.log(`데이터 디렉터리: ${config.dataDir}`);
});

// 스케일 인·재배포 때 k8s 가 보내는 SIGTERM: 새 요청을 받지 않고, WebSocket 은 1012 로 닫아
// 화면이 다른 인스턴스로 재접속하게 한 뒤 종료한다(라이브는 재접속 유예 덕분에 이어진다).
let stopping = false;
for (const signal of ['SIGTERM', 'SIGINT']) {
  process.on(signal, () => {
    if (stopping) return;
    stopping = true;
    console.log(`${signal} 수신: 연결을 정리하고 종료합니다.`);
    shutdown();
    server.close(async () => {
      await bus.close();
      db.close();
      process.exit(0);
    });
    server.closeIdleConnections?.();
    setTimeout(() => process.exit(0), 10_000).unref();
  });
}
