import { forbidden, unauthorized } from '../http/errors.js';

// 서버 쪽 권한 규칙. 서비스는 행동하기 전에 반드시 이 함수들로 검사한다.
// (화면의 버튼 숨김은 편의일 뿐이고, 실제 허용·거절은 여기서 정해진다.)

// 비로그인 → 401
export function requireMember(actor) {
  if (!actor) throw unauthorized();
  return actor;
}

// 비로그인 → 401, 소유자가 아니거나 소유자 없는 방송 → 403
export function requireOwner(actor, resource) {
  requireMember(actor);
  if (resource.ownerId == null || resource.ownerId !== actor.id) {
    throw forbidden('방송 소유자만 할 수 있습니다.');
  }
}

// 비로그인 → 401, 작성자가 아니면 → 403
export function requireAuthor(actor, comment) {
  requireMember(actor);
  if (comment.authorId !== actor.id) throw forbidden('댓글 작성자만 할 수 있습니다.');
}

export const isOwner = (actor, resource) => !!actor && resource.ownerId != null && resource.ownerId === actor.id;
