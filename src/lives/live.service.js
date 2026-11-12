import crypto from 'node:crypto';
import { EventEmitter } from 'node:events';
import { HttpError, badRequest, notFound } from '../http/errors.js';

// 방송 상태. 라이브 방송은 송출을 시작하는 순간 '방송 중'으로 생기고, 한 번 '종료'되면 되돌아가지 않는다.
export const LiveStatus = Object.freeze({ LIVE: 'live', ENDED: 'ended' });

const TITLE_MAX = 100;

// 라이브 방송의 시작·종료 규칙과 송출 키 관리. HTTP·WebSocket을 모른다.
// 송출 키는 메모리에만 두므로 서버가 재시작되면 모든 키가 사라지고, 그래서 시작할 때 방송 중이던 것을 모두 종료한다.
//
// events: 'ended' (liveId) — 어떤 이유로든 방송 중 → 종료가 되었을 때
export function createLiveService({ repository, broadcasterConnectTimeoutMs = 30_000 }) {
  const events = new EventEmitter();
  const streamKeys = new Map(); // liveId → 송출 키
  const connectTimers = new Map(); // liveId → 송출자가 접속하지 않으면 종료할 타이머

  repository.markAllEnded();

  function get(id) {
    const live = Number.isInteger(id) && id > 0 ? repository.findById(id) : null;
    if (!live) throw notFound('라이브 방송을 찾을 수 없습니다.');
    return live;
  }

  function endLive(id) {
    clearTimeout(connectTimers.get(id));
    connectTimers.delete(id);
    streamKeys.delete(id);
    if (repository.markEnded(id)) events.emit('ended', id);
  }

  return {
    events,

    list() {
      return repository.findAll();
    },

    get,

    start({ title }) {
      const cleanTitle = String(title ?? '').trim();
      if (!cleanTitle) throw badRequest('방송 제목을 입력해 주세요.');
      if (cleanTitle.length > TITLE_MAX) throw badRequest(`방송 제목은 ${TITLE_MAX}자 이하여야 합니다.`);

      const live = repository.create(cleanTitle);
      const streamKey = crypto.randomBytes(24).toString('base64url');
      streamKeys.set(live.id, streamKey);
      // 시작만 하고 영상을 보내지 않는 라이브가 '방송 중'으로 남지 않게 한다.
      connectTimers.set(live.id, setTimeout(() => endLive(live.id), broadcasterConnectTimeoutMs).unref());
      return { live, streamKey };
    },

    isValidStreamKey(id, streamKey) {
      const expected = streamKeys.get(id);
      if (!expected || typeof streamKey !== 'string') return false;
      const a = Buffer.from(expected);
      const b = Buffer.from(streamKey);
      return a.length === b.length && crypto.timingSafeEqual(a, b);
    },

    broadcasterConnected(id) {
      clearTimeout(connectTimers.get(id));
      connectTimers.delete(id);
    },

    // 송출자가 종료 버튼을 누른 경우
    end(id, streamKey) {
      const live = get(id);
      if (live.status === LiveStatus.ENDED) throw new HttpError(409, '이미 종료된 방송입니다.');
      if (!this.isValidStreamKey(id, streamKey)) throw new HttpError(403, '송출 키가 올바르지 않습니다.');
      endLive(id);
      return repository.findById(id);
    },

    // 송출자 연결이 끊긴 경우 (탭 닫기, 화면 꺼짐, 네트워크 끊김)
    broadcasterDisconnected(id) {
      endLive(id);
    },
  };
}
