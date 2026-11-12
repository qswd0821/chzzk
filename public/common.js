// 화면들이 같이 쓰는 도우미

const view = document.getElementById('view');

export async function api(url, options) {
  const res = await fetch(url, options);
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `요청 실패 (HTTP ${res.status})`);
  return data;
}

export function mount(templateId) {
  document.title = '치지직';
  const fragment = document.getElementById(templateId).content.cloneNode(true);
  const wrapper = document.createElement('div');
  wrapper.append(fragment);
  view.replaceChildren(wrapper);
  return wrapper;
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
