// 다운로드 페이지: 서버가 알려 주는 OS별 파일 링크(GitHub Releases 최신 릴리스)를 그리고, 지금 OS 를 추천한다.
const $ = (role) => document.querySelector(`[data-role="${role}"]`);

function detectOs() {
  const ua = navigator.userAgent;
  if (/Windows/i.test(ua)) return 'windows';
  if (/Macintosh|Mac OS X/i.test(ua)) return 'macos';
  return null;
}

const res = await fetch('/api/client/downloads');
const info = await res.json();

for (const os of ['windows', 'macos']) {
  const list = $(`links-${os}`);
  for (const file of info.files.filter((f) => f.os === os)) {
    const li = document.createElement('li');
    const a = Object.assign(document.createElement('a'), {
      href: file.url,
      className: file.kind === 'installer' ? 'button' : 'button secondary',
      textContent: `${file.label} · ${file.arch}`,
    });
    li.append(a, Object.assign(document.createElement('code'), { textContent: file.name }));
    list.append(li);
  }
}

$('releases').href = info.releasesPage;
$('server-url').textContent = info.serverUrl ?? location.origin;

const os = detectOs();
if (os) {
  document.querySelector(`[data-os="${os}"]`)?.classList.add('recommended');
  const rec = $('recommend');
  rec.textContent = os === 'windows' ? '지금 Windows 를 쓰고 계시네요. 아래 Windows 설치 파일을 받으세요.' : '지금 Mac 을 쓰고 계시네요. 칩 종류(Apple Silicon / Intel)에 맞는 파일을 받으세요.';
  rec.hidden = false;
}
