// 치지직 데스크톱 클라이언트 (Electron 메인 프로세스)
// 화면(renderer/)은 app://chzzk 출처로 띄우고, 배포된 백엔드의 공개 API(방송 목록·상세·댓글·후원 내역)와
// 시청자 WebSocket 으로 방송을 보여준다. 서버는 이 출처에 조회만 허용한다(src/http/cors.js).
//
// 실행 인자:
//   --server=<url>      접속할 백엔드 주소(설정·기본값보다 우선)
//   --smoke             자동 확인 모드: 방송 목록을 받고 녹화방송 하나의 재생 준비까지 확인한 뒤 결과를 출력하고 종료(성공 0, 실패 1)
//   --screenshot=<png>  --smoke 와 함께: 목록 화면을 PNG 로 저장
const { app, BrowserWindow, ipcMain, net, protocol, shell } = require('electron');
const fs = require('node:fs');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

const APP_ORIGIN = 'app://chzzk';
const RENDERER_DIR = path.join(__dirname, 'renderer');

protocol.registerSchemesAsPrivileged([
  { scheme: 'app', privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true, stream: true } },
]);

function flag(name) {
  const arg = process.argv.find((a) => a === `--${name}` || a.startsWith(`--${name}=`));
  if (!arg) return null;
  return arg.includes('=') ? arg.slice(arg.indexOf('=') + 1) : true;
}

const SMOKE = Boolean(flag('smoke'));
const SCREENSHOT = typeof flag('screenshot') === 'string' ? flag('screenshot') : null;

const settingsPath = () => path.join(app.getPath('userData'), 'settings.json');

function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return {};
  }
}

// 우선순위: --server 인자 > 환경변수 > 사용자가 설정에서 바꾼 값 > 빌드 때 넣은 기본값(app-config.json)
function serverUrl() {
  const fromFlag = typeof flag('server') === 'string' ? flag('server') : null;
  const url = fromFlag
    || process.env.CHZZK_SERVER_URL
    || readJson(settingsPath()).serverUrl
    || readJson(path.join(__dirname, 'app-config.json')).defaultServerUrl
    || 'http://localhost:3000';
  return url.replace(/\/$/, '');
}

function isHttpUrl(value) {
  try {
    const u = new URL(value);
    return u.protocol === 'http:' || u.protocol === 'https:';
  } catch {
    return false;
  }
}

let mainWindow;

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1200,
    height: 800,
    minWidth: 720,
    minHeight: 520,
    title: '치지직',
    backgroundColor: '#111317',
    show: !SMOKE || Boolean(SCREENSHOT),
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  mainWindow.removeMenu();

  // 앱 안에서 다른 사이트로 이동하지 않고, 바깥 링크(웹에서 열기 등)는 기본 브라우저로 연다.
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (isHttpUrl(url)) shell.openExternal(url);
    return { action: 'deny' };
  });
  mainWindow.webContents.on('will-navigate', (event, url) => {
    if (!url.startsWith(APP_ORIGIN)) {
      event.preventDefault();
      if (isHttpUrl(url)) shell.openExternal(url);
    }
  });

  mainWindow.loadURL(`${APP_ORIGIN}/index.html`);
}

function registerIpc() {
  ipcMain.handle('config:get', () => ({
    serverUrl: serverUrl(),
    version: app.getVersion(),
    platform: `${process.platform}-${process.arch}`,
    smoke: SMOKE,
  }));

  ipcMain.handle('config:set-server', (_event, url) => {
    if (!isHttpUrl(url)) throw new Error('http:// 또는 https:// 주소를 입력하세요.');
    const settings = readJson(settingsPath());
    settings.serverUrl = url.replace(/\/$/, '');
    fs.mkdirSync(path.dirname(settingsPath()), { recursive: true });
    fs.writeFileSync(settingsPath(), JSON.stringify(settings, null, 2));
    return settings.serverUrl;
  });

  ipcMain.handle('open-external', (_event, url) => {
    if (isHttpUrl(url)) shell.openExternal(url);
  });

  // 자동 확인 결과(renderer → main). 한 줄 JSON 으로 출력하고 종료한다.
  ipcMain.handle('smoke:result', async (_event, result) => {
    if (!SMOKE) return;
    if (SCREENSHOT) {
      const image = await mainWindow.webContents.capturePage();
      fs.writeFileSync(SCREENSHOT, image.toPNG());
    }
    const line = { smoke: result.ok ? 'pass' : 'fail', platform: `${process.platform}-${process.arch}`, version: app.getVersion(), server: serverUrl(), ...result };
    process.stdout.write(`${JSON.stringify(line)}\n`);
    app.exit(result.ok ? 0 : 1);
  });
}

app.whenReady().then(() => {
  // app://chzzk/... → renderer/ 폴더의 파일. 폴더 밖 경로는 거절한다.
  protocol.handle('app', (request) => {
    const { pathname } = new URL(request.url);
    const file = path.normalize(path.join(RENDERER_DIR, decodeURIComponent(pathname === '/' ? '/index.html' : pathname)));
    if (!file.startsWith(RENDERER_DIR)) return new Response('Not found', { status: 404 });
    return net.fetch(pathToFileURL(file).toString());
  });

  registerIpc();
  createWindow();

  if (SMOKE) {
    setTimeout(() => {
      process.stdout.write(`${JSON.stringify({ smoke: 'fail', error: 'timeout', server: serverUrl() })}\n`);
      app.exit(1);
    }, 60_000).unref();
  }

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin' || SMOKE) app.quit();
});
