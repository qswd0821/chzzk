// 해시 라우팅 SPA
//   #/                  방송 목록 (라이브 방송 + 녹화방송)
//   #/new               녹화방송 등록
//   #/broadcasts/:id    녹화방송 상세·재생
//   #/live/new          라이브 송출 (휴대폰)
//   #/lives/:id         라이브 시청
import { api, mount, q, showError, formatDate, formatSize } from './common.js';
import { renderGoLive, renderWatchLive } from './live.js';

const routes = [
  [/^#?\/?$/, renderList],
  [/^#\/new$/, renderNew],
  [/^#\/broadcasts\/(\d+)$/, (id) => renderDetail(id)],
  [/^#\/live\/new$/, renderGoLive],
  [/^#\/lives\/(\d+)$/, (id, onLeave) => renderWatchLive(id, onLeave)],
];

// 화면을 떠날 때 정리할 일(카메라 끄기, 연결 닫기, 타이머 해제)
let leaveCurrent = null;

function route() {
  leaveCurrent?.();
  leaveCurrent = null;
  const onLeave = (fn) => { leaveCurrent = fn; };

  const hash = location.hash || '#/';
  for (const [pattern, render] of routes) {
    const match = hash.match(pattern);
    if (match) return render(...match.slice(1), onLeave);
  }
  mount('tpl-list').replaceChildren(
    Object.assign(document.createElement('p'), { textContent: '페이지를 찾을 수 없습니다.', className: 'muted' }),
  );
}

window.addEventListener('hashchange', route);
route();

function renderList(onLeave) {
  const root = mount('tpl-list');
  loadLives(root);
  loadBroadcasts(root);
  // 다른 화면에서 시작·종료된 라이브 방송 상태를 반영한다.
  const timer = setInterval(() => loadLives(root), 10_000);
  onLeave(() => clearInterval(timer));
}

async function loadLives(root) {
  const status = q(root, 'live-status');
  const list = q(root, 'live-list');
  try {
    const lives = await api('/api/lives');
    const onAir = lives.filter((l) => l.status === 'live').length;
    status.className = 'muted';
    status.textContent = lives.length === 0
      ? '아직 라이브 방송이 없습니다. 휴대폰에서 "● 라이브 시작"을 눌러 보세요.'
      : `방송 중 ${onAir}개 · 종료 ${lives.length - onAir}개`;
    list.replaceChildren(...lives.map((live) => card({
      href: `#/lives/${live.id}`,
      title: live.title,
      date: live.status === 'live'
        ? `${formatDate(live.startedAt)} 시작`
        : `${formatDate(live.endedAt ?? live.startedAt)} 종료`,
      badge: live.status === 'live' ? '● 방송 중' : '종료',
      variant: live.status === 'live' ? 'on-air' : 'ended',
    })));
  } catch (err) {
    status.textContent = err.message;
    status.className = 'error';
  }
}

async function loadBroadcasts(root) {
  const status = q(root, 'status');
  const list = q(root, 'list');
  try {
    const broadcasts = await api('/api/broadcasts');
    if (broadcasts.length === 0) {
      status.replaceChildren('아직 등록된 녹화방송이 없습니다. ');
      status.append(Object.assign(document.createElement('a'), { href: '#/new', textContent: '첫 녹화방송 등록하기' }));
      return;
    }
    status.textContent = `총 ${broadcasts.length}개`;
    list.replaceChildren(...broadcasts.map((b) => card({
      href: `#/broadcasts/${b.id}`,
      title: b.title,
      date: formatDate(b.createdAt),
      badge: b.sourceType === 'upload' ? '업로드' : 'URL',
    })));
  } catch (err) {
    status.textContent = err.message;
    status.className = 'error';
  }
}

function card({ href, title, date, badge, variant }) {
  const fragment = document.getElementById('tpl-card').content.cloneNode(true);
  q(fragment, 'link').href = href;
  q(fragment, 'title').textContent = title;
  q(fragment, 'date').textContent = date;
  q(fragment, 'badge').textContent = badge;
  if (variant) fragment.querySelector('.card').classList.add(variant);
  return fragment;
}

async function renderDetail(id) {
  const root = mount('tpl-detail');
  const status = q(root, 'status');

  try {
    const b = await api(`/api/broadcasts/${id}`);
    document.title = `${b.title} - 치지직`;
    q(root, 'title').textContent = b.title;
    q(root, 'meta').textContent = [
      formatDate(b.createdAt),
      b.sourceType === 'upload' ? `업로드 파일 · ${formatSize(b.fileSize)}` : '외부 영상 URL',
    ].join(' · ');
    q(root, 'description').textContent = b.description;
    q(root, 'location').textContent = b.sourceType === 'upload' ? `uploads/${b.videoLocation}` : b.videoLocation;

    const player = q(root, 'player');
    player.addEventListener('error', () => { q(root, 'player-error').hidden = false; });
    player.src = b.videoSrc;

    status.hidden = true;
    q(root, 'article').hidden = false;
  } catch (err) {
    status.textContent = err.message;
    status.className = 'error';
  }
}

function renderNew() {
  const root = mount('tpl-new');
  const form = q(root, 'form');
  const errorBox = q(root, 'error');
  const progress = q(root, 'progress');
  const submit = form.querySelector('button[type=submit]');

  const syncSource = () => {
    const source = form.source.value;
    for (const el of form.querySelectorAll('[data-source]')) el.hidden = el.dataset.source !== source;
  };
  form.addEventListener('change', (e) => { if (e.target.name === 'source') syncSource(); });

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    errorBox.hidden = true;

    const source = form.source.value;
    const title = form.title.value.trim();
    const file = form.videoFile.files[0];
    const videoUrl = form.videoUrl.value.trim();

    const problem = !title ? '제목을 입력해 주세요.'
      : source === 'upload' && !file ? '업로드할 영상 파일을 선택해 주세요.'
      : source === 'url' && !videoUrl ? '영상 URL을 입력해 주세요.'
      : null;
    if (problem) return showError(errorBox, problem);

    // 선택한 방식의 값만 보낸다 (서버는 둘 중 하나만 허용)
    const body = new FormData();
    body.append('title', title);
    body.append('description', form.description.value.trim());
    if (source === 'upload') body.append('videoFile', file);
    else body.append('videoUrl', videoUrl);

    submit.disabled = true;
    progress.hidden = source !== 'upload';
    try {
      const created = await uploadWithProgress(body, (pct) => { progress.value = pct; });
      location.hash = `#/broadcasts/${created.id}`;
    } catch (err) {
      showError(errorBox, err.message);
    } finally {
      submit.disabled = false;
      progress.hidden = true;
    }
  });
}

// fetch 는 업로드 진행률을 주지 않으므로 XHR 사용
function uploadWithProgress(body, onProgress) {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open('POST', '/api/broadcasts');
    xhr.responseType = 'json';
    xhr.upload.addEventListener('progress', (e) => {
      if (e.lengthComputable) onProgress(Math.round((e.loaded / e.total) * 100));
    });
    xhr.addEventListener('load', () => {
      if (xhr.status === 201) resolve(xhr.response);
      else reject(new Error(xhr.response?.error || `등록 실패 (HTTP ${xhr.status})`));
    });
    xhr.addEventListener('error', () => reject(new Error('네트워크 오류로 등록하지 못했습니다.')));
    xhr.send(body);
  });
}
