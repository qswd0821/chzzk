import { badRequest, conflict, notFound } from '../http/errors.js';
import { isOwner, requireMember, requireOwner } from '../auth/access.js';

// 방송 상태. 라이브 방송은 송출을 시작하는 순간 '방송 중'으로 생기고, 한 번 '종료'되면 되돌아가지 않는다.
export const LiveStatus = Object.freeze({ LIVE: 'live', ENDED: 'ended' });

const TITLE_MAX = 100;

// 송출자가 지금 어느 인스턴스엔가 붙어 있다는 표시(TTL 키). 값은 송출자 연결 ID.
export const broadcasterPresenceKey = (liveId) => `live:${liveId}:broadcaster`;

// 라이브 방송의 시작·종료·수정·삭제 규칙. HTTP·WebSocket을 모른다.
// actor 는 요청한 회원(비로그인이면 null). 시작은 회원만, 나머지 제어는 소유자만 할 수 있다.
//
// 여러 인스턴스가 함께 돌기 때문에(docs/adr/0003) "송출자 연결이 끊기면 종료"를 타이머로 하지 않는다.
// 송출자의 인스턴스가 접속 표시를 계속 갱신하고, 어느 인스턴스든 sweep() 으로
// 표시가 사라진(= 재접속 유예 시간 안에 돌아오지 않은) 라이브를 종료한다.
//
// 종료되면 버스의 'live-ended' 채널로 { liveId } 를 모든 인스턴스에 알린다.
export function createLiveService({
  repository,
  comments,
  bus,
  connectWindowMs = 30_000, // 시작 후 송출자가 처음 접속하기까지 기다리는 시간
  sweepIntervalMs = 5_000,
}) {
  function find(id) {
    const live = Number.isInteger(id) && id > 0 ? repository.findById(id) : null;
    if (!live) throw notFound('라이브 방송을 찾을 수 없습니다.');
    return live;
  }

  async function endLive(id) {
    if (!repository.markEnded(id)) return false;
    await bus.deletePresence(broadcasterPresenceKey(id));
    await bus.publish('live-ended', { liveId: id });
    return true;
  }

  async function sweep() {
    let ended = 0;
    for (const id of repository.findOnAirIds()) {
      if (!(await bus.getPresence(broadcasterPresenceKey(id))) && (await endLive(id))) ended++;
    }
    return ended;
  }

  return {
    list() {
      return repository.findAll();
    },

    get: find,

    async start({ title }, actor) {
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
      // 송출자가 접속할 때까지 기다리는 표시. 시간 안에 접속하지 않으면 sweep 이 종료한다.
      await bus.setPresence(broadcasterPresenceKey(live.id), 'waiting', connectWindowMs);
      return live;
    },

    // 송출자로 참여할 수 있는지: 방송 중이고, 요청한 회원이 소유자여야 한다.
    canBroadcast(id, actor) {
      const live = repository.findById(id);
      return !!live && live.status === LiveStatus.LIVE && isOwner(actor, live);
    },

    // 소유자가 종료 버튼을 누른 경우: 유예 없이 바로 종료
    async end(id, actor) {
      const live = find(id);
      requireOwner(actor, live);
      if (live.status === LiveStatus.ENDED) throw conflict('이미 종료된 방송입니다.');
      await endLive(id);
      return repository.findById(id);
    },

    rename(id, title, actor) {
      const live = find(id);
      requireOwner(actor, live);
      return repository.rename(id, validateTitle(title));
    },

    // 방송 중이면 먼저 종료해 시청자에게 알린 뒤, 라이브와 댓글을 지운다.
    async remove(id, actor) {
      const live = find(id);
      requireOwner(actor, live);
      await endLive(id);
      comments.deleteAllFor('live', id);
      repository.delete(id);
    },

    sweep,

    // 주기적으로 sweep 한다. 여러 인스턴스가 동시에 돌아도 종료는 조건부 UPDATE 라 한 번만 일어난다.
    startSweeper() {
      const timer = setInterval(() => { sweep().catch((err) => console.error('[live sweep]', err)); }, sweepIntervalMs);
      timer.unref();
      return () => clearInterval(timer);
    },
  };
}

function validateTitle(title) {
  const cleanTitle = String(title ?? '').trim();
  if (!cleanTitle) throw badRequest('방송 제목을 입력해 주세요.');
  if (cleanTitle.length > TITLE_MAX) throw badRequest(`방송 제목은 ${TITLE_MAX}자 이하여야 합니다.`);
  return cleanTitle;
}
