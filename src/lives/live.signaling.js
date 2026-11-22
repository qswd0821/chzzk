import crypto from 'node:crypto';
import { WebSocketServer } from 'ws';
import { LiveStatus, broadcasterPresenceKey } from './live.service.js';
import { isSameOrigin } from '../auth/session-cookie.js';

export const SIGNALING_PATH = '/ws/lives';

// WebRTC 시그널링 중계 + 라이브 댓글·후원 실시간 전달.
// 영상은 송출자 ↔ 시청자 브라우저가 P2P로 직접 주고받고(docs/adr/0001),
// 서버는 연결 협상 메시지(offer/answer/ice)와 알림만 전달한다.
//
// 인스턴스가 여러 개라서(docs/adr/0003) 송출자와 시청자가 서로 다른 인스턴스에 붙을 수 있다.
// 그래서 소켓으로 직접 보내지 않고 버스(Redis pub/sub)의 'signal' 채널로 보내고,
// 각 인스턴스는 자기에게 붙은 소켓에만 전달한다.
//
// 연결할 때 로그인 쿠키로 회원을 확인하고(authenticate), 첫 메시지로 참여한다:
//   송출자 → { type: 'join', role: 'broadcaster', liveId }   로그인한 소유자만. 새 화면이 참여하면 이전 송출자 연결은 닫힌다.
//   시청자 → { type: 'join', role: 'viewer', liveId }        누구나(비로그인 포함)
// 이후:
//   송출자 → { type: 'offer' | 'ice', to: viewerId, sdp | candidate }   → 해당 시청자에게 전달
//   시청자 → { type: 'answer' | 'ice', sdp | candidate }                → 송출자에게 { from: viewerId, ... }
//   서버 → 송출자 { type: 'viewer-joined' | 'viewer-left', viewerId }
//   서버 → 모두   { type: 'comment', action, comment } / { type: 'donation', donation }
//   서버 → 모두   { type: 'ended' }  라이브 방송이 종료되면 보내고 연결을 닫는다.
// 서버가 내려가며 연결을 닫을 때는 코드 1012(Service Restart)를 쓰고, 화면은 다른 인스턴스로 자동 재접속한다.
export async function attachLiveSignaling({
  server,
  service,
  bus,
  authenticate,
  instanceId,
  isAllowedClient = () => false,
  reconnectGraceMs = 20_000,
  heartbeatMs = 15_000,
}) {
  const wss = new WebSocketServer({
    server,
    path: SIGNALING_PATH,
    maxPayload: 64 * 1024,
    // 다른 사이트의 페이지가 로그인한 회원의 브라우저로 송출 연결을 여는 것을 막는다.
    // 데스크톱 클라이언트(허용 출처)는 시청자로만 참여할 수 있다(아래에서 회원으로 인정하지 않음).
    verifyClient: ({ req }) => isSameOrigin(req) || isAllowedClient(req),
  });
  const rooms = new Map(); // liveId → { broadcaster: { socket, connId } | null, viewers: Map<viewerId, socket> }
  let nextViewer = 1;
  const presenceRefreshMs = Math.max(200, Math.floor(reconnectGraceMs / 3));

  const roomOf = (liveId) => {
    if (!rooms.has(liveId)) rooms.set(liveId, { broadcaster: null, viewers: new Map() });
    return rooms.get(liveId);
  };
  const dropRoomIfEmpty = (liveId) => {
    const room = rooms.get(liveId);
    if (room && !room.broadcaster && room.viewers.size === 0) rooms.delete(liveId);
  };
  const everyoneIn = (room) => [room.broadcaster?.socket, ...room.viewers.values()].filter(Boolean);
  const signal = (liveId, to, message) => bus.publish('signal', { liveId, to, message });

  // ── 버스에서 오는 메시지: 이 인스턴스에 붙은 소켓에만 전달 ──
  await bus.subscribe('signal', ({ liveId, to, message }) => {
    const room = rooms.get(liveId);
    if (!room) return;
    if (to === 'broadcaster') {
      if (room.broadcaster) send(room.broadcaster.socket, message);
    } else if (to === 'viewers') {
      // 송출자가 (다시) 참여했다: 이 인스턴스의 시청자들을 송출자에게 알려 연결을 새로 맺게 한다.
      if (message.type === 'broadcaster-joined') {
        for (const viewerId of room.viewers.keys()) signal(liveId, 'broadcaster', { type: 'viewer-joined', viewerId });
      }
    } else {
      const viewer = room.viewers.get(to);
      if (viewer) send(viewer, message);
    }
  });

  await bus.subscribe('broadcaster-takeover', ({ liveId, connId }) => {
    const room = rooms.get(liveId);
    if (room?.broadcaster && room.broadcaster.connId !== connId) {
      reject(room.broadcaster.socket, '다른 화면에서 송출을 이어받았습니다.', 4001);
    }
  });

  await bus.subscribe('live-ended', ({ liveId }) => {
    const room = rooms.get(liveId);
    if (!room) return;
    rooms.delete(liveId);
    for (const socket of everyoneIn(room)) {
      send(socket, { type: 'ended' });
      socket.close(1000, 'ended');
    }
  });

  const deliverToRoom = (liveId, message) => {
    const room = rooms.get(liveId);
    if (room) for (const socket of everyoneIn(room)) send(socket, message);
  };
  await bus.subscribe('comment', ({ action, comment }) => {
    if (comment.targetType === 'live') deliverToRoom(comment.targetId, { type: 'comment', action, comment });
  });
  await bus.subscribe('donation', (donation) => {
    if (donation.targetType === 'live') deliverToRoom(donation.targetId, { type: 'donation', donation });
  });

  // ── 이 인스턴스에 붙는 소켓 ──
  wss.on('connection', (socket, req) => {
    socket.isAlive = true;
    socket.on('pong', () => { socket.isAlive = true; });

    // 다른 출처(데스크톱 클라이언트)에서 온 연결은 쿠키가 있어도 회원으로 보지 않는다 → 송출자 참여 불가
    const member = isSameOrigin(req) ? authenticate(req) : null;
    let session = null; // { role, liveId, viewerId?, connId?, refresh? }

    socket.on('message', async (raw) => {
      const message = parseMessage(raw);
      if (!message) return reject(socket, '잘못된 메시지 형식입니다.');

      if (!session) {
        if (message.type !== 'join') return reject(socket, '먼저 방송에 참여해야 합니다.');
        session = { pending: true };
        session = await join(socket, message, member);
        return;
      }
      if (session.pending) return;

      const { liveId, role } = session;
      if (role === 'broadcaster' && (message.type === 'offer' || message.type === 'ice')) {
        if (rooms.get(liveId)?.broadcaster?.socket !== socket) return; // 이어받기로 밀려난 연결
        signal(liveId, message.to, { type: message.type, sdp: message.sdp, candidate: message.candidate });
      } else if (role === 'viewer' && (message.type === 'answer' || message.type === 'ice')) {
        signal(liveId, 'broadcaster', {
          type: message.type, from: session.viewerId, sdp: message.sdp, candidate: message.candidate,
        });
      }
    });

    socket.on('close', () => {
      if (!session || session.pending) return;
      const room = rooms.get(session.liveId);
      if (session.role === 'broadcaster') {
        clearInterval(session.refresh);
        // 접속 표시는 지우지 않는다. 유예 시간 안에 다시 붙지 않으면 표시가 만료되고 sweep 이 종료한다.
        if (room?.broadcaster?.socket === socket) room.broadcaster = null;
      } else if (room) {
        room.viewers.delete(session.viewerId);
        signal(session.liveId, 'broadcaster', { type: 'viewer-left', viewerId: session.viewerId });
      }
      dropRoomIfEmpty(session.liveId);
    });
  });

  async function join(socket, { role, liveId }, member) {
    const id = Number(liveId);
    let live;
    try {
      live = service.get(id);
    } catch {
      reject(socket, '라이브 방송을 찾을 수 없습니다.');
      return null;
    }
    if (live.status !== LiveStatus.LIVE) {
      send(socket, { type: 'ended' });
      socket.close(1000, 'ended');
      return null;
    }

    if (role === 'broadcaster') {
      if (!member) {
        reject(socket, '로그인이 필요합니다.');
        return null;
      }
      if (!service.canBroadcast(id, member)) {
        reject(socket, '방송 소유자만 송출할 수 있습니다.');
        return null;
      }
      const connId = crypto.randomUUID();
      const room = roomOf(id);
      // 같은 인스턴스의 이전 송출자 연결은 여기서 닫고, 다른 인스턴스의 것은 아래 'broadcaster-takeover' 로 닫는다.
      const previous = room.broadcaster;
      room.broadcaster = { socket, connId };
      if (previous && previous.socket !== socket) reject(previous.socket, '다른 화면에서 송출을 이어받았습니다.', 4001);
      const key = broadcasterPresenceKey(id);
      await bus.setPresence(key, connId, reconnectGraceMs);
      // 이 연결이 살아 있는 동안 접속 표시를 갱신한다.
      const refresh = setInterval(() => {
        if (rooms.get(id)?.broadcaster?.socket === socket) bus.setPresence(key, connId, reconnectGraceMs).catch(() => {});
      }, presenceRefreshMs);
      refresh.unref();
      // 다른 화면(다른 인스턴스 포함)에 남아 있던 이전 송출자 연결을 닫고, 시청자들과 연결을 새로 맺는다.
      await bus.publish('broadcaster-takeover', { liveId: id, connId });
      send(socket, { type: 'joined', role, instanceId });
      await signal(id, 'viewers', { type: 'broadcaster-joined' });
      return { role, liveId: id, connId, refresh };
    }

    if (role === 'viewer') {
      const viewerId = `${instanceId}:${nextViewer++}`;
      roomOf(id).viewers.set(viewerId, socket);
      send(socket, { type: 'joined', role, viewerId, instanceId });
      await signal(id, 'broadcaster', { type: 'viewer-joined', viewerId });
      return { role, liveId: id, viewerId };
    }

    reject(socket, '알 수 없는 역할입니다.');
    return null;
  }

  // 화면이 꺼지거나 네트워크가 끊겨 close 이벤트 없이 사라진 휴대폰을 찾아낸다.
  const heartbeat = setInterval(() => {
    for (const socket of wss.clients) {
      if (!socket.isAlive) {
        socket.terminate();
        continue;
      }
      socket.isAlive = false;
      socket.ping();
    }
  }, heartbeatMs).unref();
  wss.on('close', () => clearInterval(heartbeat));

  return {
    wss,
    // 인스턴스가 내려갈 때(SIGTERM): 화면들이 다른 인스턴스로 재접속하도록 1012 로 닫는다.
    shutdown() {
      for (const socket of wss.clients) socket.close(1012, 'instance shutting down');
      clearInterval(heartbeat);
    },
  };
}

function parseMessage(raw) {
  try {
    const message = JSON.parse(raw.toString());
    return message && typeof message.type === 'string' ? message : null;
  } catch {
    return null;
  }
}

function send(socket, message) {
  if (socket.readyState === socket.OPEN) socket.send(JSON.stringify(message));
}

// 1008: 정책 위반(권한 없음 등) — 화면은 재접속하지 않는다. 4001: 다른 화면이 송출을 이어받음.
function reject(socket, error, code = 1008) {
  send(socket, { type: 'error', error, code });
  socket.close(code, 'rejected');
}
