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
  };
}
