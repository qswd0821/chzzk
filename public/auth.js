// 로그인·회원가입 화면. 성공하면 서버가 HttpOnly 세션 쿠키를 심고, next 화면으로 돌아간다.
import { api, mount, q, showError, refreshSession, loginHref, signupHref } from './common.js';

function nextFromHash() {
  const query = (location.hash.split('?')[1] ?? '');
  const next = new URLSearchParams(query).get('next') ?? '#/';
  // 같은 앱 안의 화면으로만 돌아간다(외부 주소로 보내는 오픈 리다이렉트 방지).
  return next.startsWith('#/') ? next : '#/';
}

export function renderLogin() {
  renderAuthForm('tpl-login', '/api/auth/login', signupHref(nextFromHash()));
}

export function renderSignup() {
  renderAuthForm('tpl-signup', '/api/auth/signup', loginHref(nextFromHash()));
}

function renderAuthForm(templateId, endpoint, switchHref) {
  const root = mount(templateId);
  const form = q(root, 'form');
  const errorBox = q(root, 'error');
  const submit = form.querySelector('button[type=submit]');
  q(root, 'switch').href = switchHref;

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    errorBox.hidden = true;
    submit.disabled = true;
    try {
      await api(endpoint, { method: 'POST', json: Object.fromEntries(new FormData(form)) });
      await refreshSession();
      location.hash = nextFromHash();
    } catch (err) {
      showError(errorBox, err.message);
    } finally {
      submit.disabled = false;
    }
  });
}
