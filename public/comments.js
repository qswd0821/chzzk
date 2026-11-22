// 방송별 댓글 영역. 목록은 누구나 보고, 로그인 회원만 쓰고, 작성자에게만 수정·삭제 버튼이 보인다.
// (버튼을 숨기는 것은 편의일 뿐, 실제 허용·거절은 서버가 401/403으로 정한다.)
import { api, clone, q, showError, session, loginHref, formatDate } from './common.js';

const BASE = { broadcast: '/api/broadcasts', live: '/api/lives' };

// container 에 댓글 영역을 그리고, 실시간 변경을 반영할 apply(action, comment) 를 돌려준다.
export function mountComments(container, { targetType, targetId }) {
  const root = clone('tpl-comments');
  container.replaceChildren(root);

  const list = q(root, 'list');
  const form = q(root, 'form');
  const errorBox = q(root, 'error');
  const items = new Map(); // commentId → li

  if (session.member) {
    form.hidden = false;
  } else {
    q(root, 'login-hint').hidden = false;
    q(root, 'login').href = loginHref();
  }

  const updateCount = () => { q(root, 'count').textContent = `${items.size}개`; };

  function upsert(comment) {
    const existing = items.get(comment.id);
    const li = renderComment(comment);
    if (existing) existing.replaceWith(li);
    else list.append(li);
    items.set(comment.id, li);
    updateCount();
  }

  function removeItem(id) {
    items.get(id)?.remove();
    items.delete(id);
    updateCount();
  }

  function renderComment(comment) {
    const li = clone('tpl-comment');
    q(li, 'author').textContent = comment.author.nickname;
    q(li, 'date').textContent = formatDate(comment.createdAt) + (comment.updatedAt ? ' (수정됨)' : '');
    q(li, 'body').textContent = comment.body;

    if (session.member?.id === comment.authorId) {
      q(li, 'actions').hidden = false;
      const editForm = q(li, 'edit-form');
      q(li, 'edit').addEventListener('click', () => {
        editForm.body.value = comment.body;
        editForm.hidden = false;
        q(li, 'body').hidden = true;
      });
      q(li, 'cancel').addEventListener('click', () => {
        editForm.hidden = true;
        q(li, 'body').hidden = false;
      });
      editForm.addEventListener('submit', async (e) => {
        e.preventDefault();
        try {
          upsert(await api(`/api/comments/${comment.id}`, { method: 'PATCH', json: { body: editForm.body.value } }));
        } catch (err) {
          showError(errorBox, err.message);
        }
      });
      q(li, 'delete').addEventListener('click', async () => {
        if (!confirm('댓글을 삭제할까요?')) return;
        try {
          await api(`/api/comments/${comment.id}`, { method: 'DELETE' });
          removeItem(comment.id);
        } catch (err) {
          showError(errorBox, err.message);
        }
      });
    }
    return li;
  }

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    errorBox.hidden = true;
    const submit = form.querySelector('button[type=submit]');
    submit.disabled = true;
    try {
      upsert(await api(`${BASE[targetType]}/${targetId}/comments`, { method: 'POST', json: { body: form.body.value } }));
      form.reset();
    } catch (err) {
      showError(errorBox, err.message);
    } finally {
      submit.disabled = false;
    }
  });

  api(`${BASE[targetType]}/${targetId}/comments`)
    .then((comments) => comments.forEach(upsert))
    .catch((err) => showError(errorBox, err.message));
  updateCount();

  return {
    // 라이브 WebSocket으로 받은 댓글 변경 반영
    apply(action, comment) {
      if (action === 'deleted') removeItem(comment.id);
      else upsert(comment);
    },
  };
}
