import fs from 'node:fs';
import http from 'node:http';
import https from 'node:https';
import { loadConfig } from './config.js';
import { openDatabase } from './database.js';
import { createApplication } from './app.js';
import { loadTlsOptions, lanAddresses } from './http/tls.js';

const config = loadConfig();
fs.mkdirSync(config.dataDir, { recursive: true });

const db = openDatabase(config.dbPath);
const { app, attachTo } = createApplication({ db, config });

const server = config.https.enabled
  ? https.createServer(await loadTlsOptions(config.https), app)
  : http.createServer(app);
attachTo(server);

server.listen(config.port, () => {
  const scheme = config.https.enabled ? 'https' : 'http';
  console.log(`치지직 서버 실행 중: ${scheme}://localhost:${config.port}`);
  for (const ip of lanAddresses()) console.log(`  같은 Wi-Fi 휴대폰에서: ${scheme}://${ip}:${config.port}`);
  if (!config.https.enabled) {
    console.log('  ※ 휴대폰에서 라이브 송출을 하려면 HTTPS=true 로 실행하세요 (카메라·마이크는 HTTPS에서만 허용됩니다).');
  }
  console.log(`데이터 디렉터리: ${config.dataDir}`);
});
