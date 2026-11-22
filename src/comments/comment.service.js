import { EventEmitter } from 'node:events';
import { badRequest, notFound } from '../http/errors.js';
import { requireAuthor, requireMember } from '../auth/access.js';

// 댓글을 달 수 있는 방송 종류
export const CommentTarget = Object.freeze({ BROADCAST: 'broadcast', LIVE: 'live' });

const BODY_MAX = 500;

// 댓글 조회·작성·수정·삭제 규칙. 조회는 누구나, 작성은 로그인 회원, 수정·삭제는 작성자만.
// findTarget[type](id) 는 대상 방송이 없으면 404를 던진다.
//
// events: 'changed' ({ action: 'created' | 'updated' | 'deleted', comment }) — 라이브 댓글 실시간 전달용
export function createCommentService({ repository, findTarget }) {
  const events = new EventEmitter();

  function ensureTarget(targetType, targetId) {
    if (!Object.values(CommentTarget).includes(targetType)) throw notFound('댓글 대상을 찾을 수 없습니다.');
    findTarget[targetType](targetId);
  }

  function find(id) {
    const comment = Number.isInteger(id) && id > 0 ? repository.findById(id) : null;
    if (!comment) throw notFound('댓글을 찾을 수 없습니다.');
    return comment;
  }

  return {
    events,

    list(targetType, targetId) {
      ensureTarget(targetType, targetId);
      return repository.listFor(targetType, targetId);
    },

    create(targetType, targetId, body, actor) {
      requireMember(actor);
      ensureTarget(targetType, targetId);
      const comment = repository.create({ targetType, targetId, authorId: actor.id, body: validateBody(body) });
      events.emit('changed', { action: 'created', comment });
      return comment;
    },

    update(id, body, actor) {
      const comment = find(id);
      requireAuthor(actor, comment);
      const updated = repository.update(id, validateBody(body));
      events.emit('changed', { action: 'updated', comment: updated });
      return updated;
    },

    remove(id, actor) {
      const comment = find(id);
      requireAuthor(actor, comment);
      repository.delete(id);
      events.emit('changed', { action: 'deleted', comment });
    },

    // 방송 삭제 시 호출된다(권한 검사는 방송 서비스가 이미 했다).
    deleteAllFor(targetType, targetId) {
      repository.deleteAllFor(targetType, targetId);
    },
  };
}

function validateBody(body) {
  const clean = String(body ?? '').trim();
  if (!clean) throw badRequest('댓글 내용을 입력해 주세요.');
  if (clean.length > BODY_MAX) throw badRequest(`댓글은 ${BODY_MAX}자 이하여야 합니다.`);
  return clean;
}
