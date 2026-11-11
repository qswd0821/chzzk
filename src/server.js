import fs from 'node:fs';
import { loadConfig } from './config.js';
import { openDatabase } from './database.js';
import { createApp } from './app.js';

const config = loadConfig();
fs.mkdirSync(config.dataDir, { recursive: true });

const db = openDatabase(config.dbPath);
const app = createApp({ db, config });

app.listen(config.port, () => {
  console.log(`Replay VOD 서버 실행 중: http://localhost:${config.port}`);
  console.log(`데이터 디렉터리: ${config.dataDir}`);
});
