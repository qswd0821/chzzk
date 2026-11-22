// 방송 소유자에게만 보이는 수정·삭제 영역. 실제 권한 검사는 서버가 한다(다른 회원이 호출하면 403).
import { clone, q, showError, isMine } from './common.js';

export function mountOwnerTools(container, { resource, withDescription, onSave, onDelete, deleteConfirm }) {
  if (!isMine(resource)) {
    container.replaceChildren();
    return;
  }
  const root = clone('tpl-owner-tools');
  container.replaceChildren(root);
  const form = q(root, 'edit-form');
  const errorBox = q(root, 'error');
  q(root, 'description-field').hidden = !withDescription;

  q(root, 'edit').addEventListener('click', () => {
    form.title.value = resource.title;
    if (withDescription) form.description.value = resource.description ?? '';
    form.hidden = false;
  });
  q(root, 'cancel').addEventListener('click', () => { form.hidden = true; });

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    errorBox.hidden = true;
    try {
      await onSave({ title: form.title.value, description: withDescription ? form.description.value : undefined });
      form.hidden = true;
    } catch (err) {
      showError(errorBox, err.message);
    }
  });

  q(root, 'delete').addEventListener('click', async () => {
    if (!confirm(deleteConfirm)) return;
    try {
      await onDelete();
    } catch (err) {
      showError(errorBox, err.message);
    }
  });
}
