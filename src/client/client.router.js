import express from 'express';

// 데스크톱 클라이언트 설치 파일 목록. 파일은 GitHub Actions 가 GitHub Releases 에 올리고(.github/workflows/client.yml),
// 이름에 버전을 넣지 않아 "최신 릴리스" 주소가 항상 같은 파일을 가리킨다.
export const CLIENT_FILES = [
  { os: 'windows', arch: 'x64', kind: 'installer', name: 'Chzzk-Setup-win-x64.exe', label: 'Windows 설치 파일 (.exe)' },
  { os: 'windows', arch: 'x64', kind: 'portable', name: 'Chzzk-win-x64.zip', label: 'Windows 무설치 (.zip)' },
  { os: 'macos', arch: 'arm64', kind: 'installer', name: 'Chzzk-mac-arm64.dmg', label: 'macOS Apple Silicon (.dmg)' },
  { os: 'macos', arch: 'arm64', kind: 'portable', name: 'Chzzk-mac-arm64.zip', label: 'macOS Apple Silicon (.zip)' },
  { os: 'macos', arch: 'x64', kind: 'installer', name: 'Chzzk-mac-x64.dmg', label: 'macOS Intel (.dmg)' },
  { os: 'macos', arch: 'x64', kind: 'portable', name: 'Chzzk-mac-x64.zip', label: 'macOS Intel (.zip)' },
];

// /api/client — 다운로드 페이지와 클라이언트가 쓰는 공개 정보
export function createClientRouter({ config }) {
  const router = express.Router();

  router.get('/downloads', (_req, res) => {
    res.json({
      serverUrl: config.publicUrl,
      releasesPage: config.downloadBaseUrl.replace(/\/latest\/download$/, ''),
      files: CLIENT_FILES.map((f) => ({ ...f, url: `${config.downloadBaseUrl}/${f.name}` })),
    });
  });

  return router;
}
