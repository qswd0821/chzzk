import { EventEmitter } from 'node:events';
import { badRequest, conflict, notFound } from '../http/errors.js';
import { isOwner, requireMember, requireOwner } from '../auth/access.js';

// 방송 상태. 라이브 방송은 송출을 시작하는 순간 '방송 중'으로 생기고, 한 번 '종료'되면 되돌아가지 않는다.
export const LiveStatus = Object.freeze({ LIVE: 'live', ENDED: 'ended' });

const TITLE_MAX = 100;

// 라이브 방송의 시작·종료·수정·삭제 규칙. HTTP·WebSocket을 모른다.
// actor 는 요청한 회원(비로그인이면 null). 시작은 회원만, 나머지 제어는 소유자만 할 수 있다.
// 서버가 재시작되면 송출자 연결이 모두 사라지므로, 시작할 때 방송 중이던 것을 모두 종료한다.
//
// events: 'ended' (liveId) — 어떤 이유로든 방송 중 → 종료가 되었을 때
export function createLiveService({ repository, comments, broadcasterConnectTimeoutMs = 30_000 }) {
  const events = new EventEmitter();
  const connectTimers = new Map(); // liveId → 송출자가 접속하지 않으면 종료할 타이머

  repository.markAllEnded();

  function find(id) {
    const live = Number.isInteger(id) && id > 0 ? repository.findById(id) : null;
    if (!live) throw notFound('라이브 방송을 찾을 수 없습니다.');
    return live;
  }

  function endLive(id) {
    clearTimeout(connectTimers.get(id));
    connectTimers.delete(id);
    if (repository.markEnded(id)) events.emit('ended', id);
  }

  return {
    events,

    list() {
      return repository.findAll();
    },

    get: find,

    start({ title }, actor) {
      requireMember(actor);
      const cleanTitle = validateTitle(title);
      if (repository.findOnAirByOwner(actor.id)) throw conflict('이미 방송 중인 라이브가 있습니다. 먼저 종료해 주세요.');

      let live;
      try {
        live = repository.create(cleanTitle, actor.id);
      } catch (err) {
        // 같은 회원이 동시에 두 번 시작한 경우 (one_live_per_owner 인덱스)
        if (/UNIQUE constraint failed/.test(err.message)) throw conflict('이미 방송 중인 라이브가 있습니다. 먼저 종료해 주세요.');
        throw err;
      }
      // 시작만 하고 영상을 보내지 않는 라이브가 '방송 중'으로 남지 않게 한다.
      connectTimers.set(live.id, setTimeout(() => endLive(live.id), broadcasterConnectTimeoutMs).unref());
      return live;
    },

    // 송출자로 참여할 수 있는지: 방송 중이고, 요청한 회원이 소유자여야 한다.
    canBroadcast(id, actor) {
      const live = repository.findById(id);
      return !!live && live.status === LiveStatus.LIVE && isOwner(actor, live);
    },

    broadcasterConnected(id) {
      clearTimeout(connectTimers.get(id));
      connectTimers.delete(id);
    },

    // 소유자가 종료 버튼을 누른 경우
    end(id, actor) {
      const live = find(id);
      requireOwner(actor, live);
      if (live.status === LiveStatus.ENDED) throw conflict('이미 종료된 방송입니다.');
      endLive(id);
      return repository.findById(id);
    },

    rename(id, title, actor) {
      const live = find(id);
      requireOwner(actor, live);
      return repository.rename(id, validateTitle(title));
    },

    // 방송 중이면 먼저 종료해 시청자에게 알린 뒤, 라이브와 댓글을 지운다.
    remove(id, actor) {
      const live = find(id);
      requireOwner(actor, live);
      endLive(id);
      comments.deleteAllFor('live', id);
      repository.delete(id);
    },

    // 송출자 연결이 끊긴 경우 (탭 닫기, 화면 꺼짐, 네트워크 끊김)
    broadcasterDisconnected(id) {
      endLive(id);
    },
  };
}

function validateTitle(title) {
  const cleanTitle = String(title ?? '').trim();
  if (!cleanTitle) throw badRequest('방송 제목을 입력해 주세요.');
  if (cleanTitle.length > TITLE_MAX) throw badRequest(`방송 제목은 ${TITLE_MAX}자 이하여야 합니다.`);
  return cleanTitle;
}
