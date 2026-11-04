// 해시 라우팅 SPA: #/ (목록), #/new (등록), #/broadcasts/:id (상세)
const view = document.getElementById('view');

const routes = [
  [/^#?\/?$/, renderList],
  [/^#\/new$/, renderNew],
  [/^#\/broadcasts\/(\d+)$/, (id) => renderDetail(id)],
];

function route() {
  const hash = location.hash || '#/';
  for (const [pattern, render] of routes) {
    const match = hash.match(pattern);
    if (match) return render(...match.slice(1));
  }
  view.replaceChildren(textBlock('페이지를 찾을 수 없습니다.'));
}

window.addEventListener('hashchange', route);
route();

async function renderList() {
  const root = mount('tpl-list');
  const status = q(root, 'status');
  const list = q(root, 'list');

  try {
    const broadcasts = await api('/api/broadcasts');
    if (broadcasts.length === 0) {
      status.innerHTML = '';
      status.append('아직 등록된 방송이 없습니다. ');
      const link = Object.assign(document.createElement('a'), { href: '#/new', textContent: '첫 방송 등록하기' });
      status.append(link);
      return;
    }
    status.textContent = `총 ${broadcasts.length}개`;
    for (const b of broadcasts) {
      const card = document.getElementById('tpl-card').content.cloneNode(true);
      q(card, 'link').href = `#/broadcasts/${b.id}`;
      q(card, 'title').textContent = b.title;
      q(card, 'date').textContent = formatDate(b.createdAt);
      q(card, 'badge').textContent = b.sourceType === 'upload' ? '업로드' : 'URL';
      list.append(card);
    }
  } catch (err) {
    status.textContent = err.message;
    status.className = 'error';
  }
}

async function renderDetail(id) {
  const root = mount('tpl-detail');
  const status = q(root, 'status');

  try {
    const b = await api(`/api/broadcasts/${id}`);
    document.title = `${b.title} - Replay VOD`;
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
    if (problem) return showError(problem);

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
      showError(err.message);
    } finally {
      submit.disabled = false;
      progress.hidden = true;
    }
  });

  function showError(message) {
    errorBox.textContent = message;
    errorBox.hidden = false;
  }
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

async function api(url) {
  const res = await fetch(url);
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `요청 실패 (HTTP ${res.status})`);
  return data;
}

function mount(templateId) {
  document.title = 'Replay VOD';
  const fragment = document.getElementById(templateId).content.cloneNode(true);
  const wrapper = document.createElement('div');
  wrapper.append(fragment);
  view.replaceChildren(wrapper);
  return wrapper;
}

function q(root, role) {
  return root.querySelector(`[data-role="${role}"]`);
}

function textBlock(text) {
  return Object.assign(document.createElement('p'), { textContent: text, className: 'muted' });
}

function formatDate(iso) {
  return new Date(iso).toLocaleString('ko-KR', { dateStyle: 'medium', timeStyle: 'short' });
}

function formatSize(bytes) {
  if (!bytes) return '-';
  const mb = bytes / 1024 / 1024;
  return mb >= 1 ? `${mb.toFixed(1)}MB` : `${Math.ceil(bytes / 1024)}KB`;
}
