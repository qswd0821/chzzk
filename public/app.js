// 해시 라우팅 SPA
//   #/                  방송 목록 (라이브 방송 + 녹화방송)          공개
//   #/login, #/signup   로그인·회원가입 (?next=돌아갈 화면)
//   #/new               녹화방송 등록                               로그인 필요
//   #/broadcasts/:id    녹화방송 상세·재생·댓글                      공개 (관리는 소유자)
//   #/live/new          라이브 송출 (휴대폰)                         로그인 필요
//   #/lives/:id         라이브 시청·댓글·후원                        공개 (관리는 소유자, 후원은 회원)
//   /donation/success, /donation/fail   결제창에서 돌아온 화면(경로 기반: 결제 서비스가 쿼리를 붙인다)
import {
  api, mount, q, showError, formatDate, formatSize, refreshSession, renderAuthArea, showLoginRequired, ownerName,
} from './common.js';
import { renderLogin, renderSignup } from './auth.js';
import { renderGoLive, renderWatchLive } from './live.js';
import { mountComments } from './comments.js';
import { mountOwnerTools } from './owner-tools.js';
import { mountDonations, renderDonationResult } from './donations.js';

const routes = [
  [/^#?\/?$/, renderList],
  [/^#\/login$/, renderLogin],
  [/^#\/signup$/, renderSignup],
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
  renderAuthArea(); // 헤더의 로그인 링크가 지금 화면으로 돌아오도록

  const path = (location.hash || '#/').split('?')[0];
  for (const [pattern, render] of routes) {
    const match = path.match(pattern);
    if (match) return render(...match.slice(1), onLeave);
  }
  mount('tpl-list').replaceChildren(
    Object.assign(document.createElement('p'), { textContent: '페이지를 찾을 수 없습니다.', className: 'muted' }),
  );
}

await refreshSession();
const donationResult = location.pathname.match(/^\/donation\/(success|fail)$/);
if (donationResult) {
  // 결과 화면에서 다른 화면으로 가면 앱의 기본 경로(/)로 돌아간다.
  window.addEventListener('hashchange', () => { location.href = `/${location.hash}`; });
  renderDonationResult(donationResult[1]);
} else {
  window.addEventListener('hashchange', route);
  route();
}

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
      ? '아직 라이브 방송이 없습니다. 로그인한 뒤 휴대폰에서 "● 라이브 시작"을 눌러 보세요.'
      : `방송 중 ${onAir}개 · 종료 ${lives.length - onAir}개`;
    list.replaceChildren(...lives.map((live) => card({
      href: `#/lives/${live.id}`,
      title: live.title,
      date: `${ownerName(live)} · ${live.status === 'live'
        ? `${formatDate(live.startedAt)} 시작`
        : `${formatDate(live.endedAt ?? live.startedAt)} 종료`}`,
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
      date: `${ownerName(b)} · ${formatDate(b.createdAt)}`,
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

  let b;
  try {
    b = await api(`/api/broadcasts/${id}`);
  } catch (err) {
    status.textContent = err.message;
    status.className = 'error';
    return;
  }

  const showInfo = () => {
    document.title = `${b.title} - 치지직`;
    q(root, 'title').textContent = b.title;
    q(root, 'description').textContent = b.description;
  };
  showInfo();
  q(root, 'meta').textContent = [
    ownerName(b),
    formatDate(b.createdAt),
    b.sourceType === 'upload' ? `업로드 파일 · ${formatSize(b.fileSize)}` : '외부 영상 URL',
  ].join(' · ');
  q(root, 'location').textContent = b.sourceType === 'upload' ? `uploads/${b.videoLocation}` : b.videoLocation;

  const player = q(root, 'player');
  player.addEventListener('error', () => { q(root, 'player-error').hidden = false; });
  player.src = b.videoSrc;

  mountOwnerTools(q(root, 'owner-tools'), {
    resource: b,
    withDescription: true,
    deleteConfirm: '이 녹화방송을 삭제할까요? 영상 파일과 댓글도 함께 지워지며 되돌릴 수 없습니다.',
    onSave: async ({ title, description }) => {
      b = await api(`/api/broadcasts/${b.id}`, { method: 'PATCH', json: { title, description } });
      showInfo();
    },
    onDelete: async () => {
      await api(`/api/broadcasts/${b.id}`, { method: 'DELETE' });
      location.hash = '#/';
    },
  });
  mountDonations(q(root, 'donations'), { targetType: 'broadcast', targetId: b.id, resource: b });
  mountComments(q(root, 'comments'), { targetType: 'broadcast', targetId: b.id });

  status.hidden = true;
  q(root, 'article').hidden = false;
}

function renderNew() {
  if (showLoginRequired('녹화방송 등록')) return;

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

// fetch 는 업로드 진행률을 주지 않으므로 XHR 사용 (세션 쿠키는 같은 출처라 자동으로 실린다)
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
