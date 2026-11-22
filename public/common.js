// 화면들이 같이 쓰는 도우미

const view = document.getElementById('view');

// 로그인 상태. 서버(/api/auth/me)가 기준이고, 여기 값은 화면 표시에만 쓴다.
// 권한은 항상 서버가 검사하므로 이 값을 조작해도 남의 방송·댓글을 바꿀 수 없다.
export const session = { member: null };

export async function api(url, { method = 'GET', json, body, headers } = {}) {
  const res = await fetch(url, {
    method,
    headers: json === undefined ? headers : { 'Content-Type': 'application/json', ...headers },
    body: json === undefined ? body : JSON.stringify(json),
  });
  if (res.status === 204) return null;
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    if (res.status === 401) await refreshSession();
    throw new Error(data.error || `요청 실패 (HTTP ${res.status})`);
  }
  return data;
}

export async function refreshSession() {
  try {
    const res = await fetch('/api/auth/me');
    session.member = (await res.json()).member ?? null;
  } catch {
    session.member = null;
  }
  renderAuthArea();
  return session.member;
}

export function renderAuthArea() {
  const area = document.querySelector('[data-role="auth-area"]');
  if (!area) return;
  if (session.member) {
    const name = Object.assign(document.createElement('span'), {
      className: 'me',
      textContent: `${session.member.nickname}님`,
    });
    const logout = Object.assign(document.createElement('button'), {
      type: 'button',
      className: 'link',
      textContent: '로그아웃',
    });
    logout.addEventListener('click', async () => {
      await api('/api/auth/logout', { method: 'POST' }).catch(() => {});
      await refreshSession();
      window.dispatchEvent(new HashChangeEvent('hashchange'));
    });
    area.replaceChildren(name, logout);
  } else {
    area.replaceChildren(
      Object.assign(document.createElement('a'), { href: loginHref(), textContent: '로그인' }),
      Object.assign(document.createElement('a'), { href: signupHref(), textContent: '회원가입' }),
    );
  }
}

// 로그인 후 지금 화면으로 돌아오도록 next 를 붙인다.
export function loginHref(next = currentPath()) {
  return `#/login?next=${encodeURIComponent(next)}`;
}

export function signupHref(next = currentPath()) {
  return `#/signup?next=${encodeURIComponent(next)}`;
}

function currentPath() {
  const path = (location.hash || '#/').split('?')[0];
  return path.startsWith('#/login') || path.startsWith('#/signup') ? '#/' : path;
}

export function mount(templateId) {
  document.title = '치지직';
  const fragment = document.getElementById(templateId).content.cloneNode(true);
  const wrapper = document.createElement('div');
  wrapper.append(fragment);
  view.replaceChildren(wrapper);
  return wrapper;
}

export function clone(templateId) {
  return document.getElementById(templateId).content.firstElementChild.cloneNode(true);
}

// 로그인하지 않았으면 안내 화면을 띄우고 true
export function showLoginRequired(title) {
  if (session.member) return false;
  const root = mount('tpl-login-required');
  q(root, 'title').textContent = title;
  q(root, 'login').href = loginHref();
  q(root, 'signup').href = signupHref();
  return true;
}

export function q(root, role) {
  return root.querySelector(`[data-role="${role}"]`);
}

export function showError(el, message) {
  el.textContent = message;
  el.hidden = false;
}

export function formatDate(iso) {
  return new Date(iso).toLocaleString('ko-KR', { dateStyle: 'medium', timeStyle: 'short' });
}

export function formatSize(bytes) {
  if (!bytes) return '-';
  const mb = bytes / 1024 / 1024;
  return mb >= 1 ? `${mb.toFixed(1)}MB` : `${Math.ceil(bytes / 1024)}KB`;
}

export const ownerName = (resource) => resource.owner?.nickname ?? '소유자 없음';
export const isMine = (resource) => !!session.member && resource.ownerId === session.member.id;
