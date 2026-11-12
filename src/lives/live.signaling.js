import { WebSocketServer } from 'ws';
import { LiveStatus } from './live.service.js';

export const SIGNALING_PATH = '/ws/lives';

// WebRTC 시그널링 중계. 영상은 송출자 ↔ 시청자 브라우저가 P2P로 직접 주고받고(docs/adr/0001),
// 서버는 연결 협상 메시지(offer/answer/ice)만 전달한다.
//
// 첫 메시지로 참여한다:
//   송출자 → { type: 'join', role: 'broadcaster', liveId, streamKey }
//   시청자 → { type: 'join', role: 'viewer', liveId }
// 이후:
//   송출자 → { type: 'offer' | 'ice', to: viewerId, sdp | candidate }   → 해당 시청자에게 전달
//   시청자 → { type: 'answer' | 'ice', sdp | candidate }                → 송출자에게 { from: viewerId, ... }
//   서버 → 송출자 { type: 'viewer-joined' | 'viewer-left', viewerId }
//   서버 → 모두   { type: 'ended' }  라이브 방송이 종료되면 보내고 연결을 닫는다.
export function attachLiveSignaling({ server, service, heartbeatMs = 15_000 }) {
  const wss = new WebSocketServer({ server, path: SIGNALING_PATH, maxPayload: 64 * 1024 });
  const rooms = new Map(); // liveId → { broadcaster, viewers: Map<viewerId, socket> }
  let nextViewerId = 1;

  const roomOf = (liveId) => {
    if (!rooms.has(liveId)) rooms.set(liveId, { broadcaster: null, viewers: new Map() });
    return rooms.get(liveId);
  };

  service.events.on('ended', (liveId) => {
    const room = rooms.get(liveId);
    if (!room) return;
    rooms.delete(liveId);
    for (const socket of [room.broadcaster, ...room.viewers.values()]) {
      if (!socket) continue;
      send(socket, { type: 'ended' });
      socket.close(1000, 'ended');
    }
  });

  wss.on('connection', (socket) => {
    socket.isAlive = true;
    socket.on('pong', () => { socket.isAlive = true; });

    let session = null; // { role, liveId, viewerId? }

    socket.on('message', (raw) => {
      const message = parseMessage(raw);
      if (!message) return reject(socket, '잘못된 메시지 형식입니다.');

      if (!session) {
        if (message.type !== 'join') return reject(socket, '먼저 방송에 참여해야 합니다.');
        session = join(socket, message);
        return;
      }

      const room = rooms.get(session.liveId);
      if (!room) return;

      if (session.role === 'broadcaster' && (message.type === 'offer' || message.type === 'ice')) {
        const viewer = room.viewers.get(message.to);
        if (viewer) send(viewer, { type: message.type, sdp: message.sdp, candidate: message.candidate });
      } else if (session.role === 'viewer' && (message.type === 'answer' || message.type === 'ice')) {
        if (room.broadcaster) {
          send(room.broadcaster, {
            type: message.type, from: session.viewerId, sdp: message.sdp, candidate: message.candidate,
          });
        }
      }
    });

    socket.on('close', () => {
      if (!session) return;
      const room = rooms.get(session.liveId);
      if (session.role === 'broadcaster') {
        if (room?.broadcaster === socket) room.broadcaster = null;
        service.broadcasterDisconnected(session.liveId);
      } else if (room) {
        room.viewers.delete(session.viewerId);
        if (room.broadcaster) send(room.broadcaster, { type: 'viewer-left', viewerId: session.viewerId });
        if (!room.broadcaster && room.viewers.size === 0) rooms.delete(session.liveId);
      }
    });
  });

  function join(socket, { role, liveId, streamKey }) {
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

    const room = roomOf(id);

    if (role === 'broadcaster') {
      if (!service.isValidStreamKey(id, streamKey)) {
        reject(socket, '송출 키가 올바르지 않습니다.');
        return null;
      }
      if (room.broadcaster) {
        reject(socket, '이미 다른 화면에서 송출 중입니다.');
        return null;
      }
      room.broadcaster = socket;
      service.broadcasterConnected(id);
      send(socket, { type: 'joined', role });
      // 송출자보다 먼저 들어와 기다리던 시청자들과 연결을 시작하게 한다.
      for (const viewerId of room.viewers.keys()) send(socket, { type: 'viewer-joined', viewerId });
      return { role, liveId: id };
    }

    if (role === 'viewer') {
      const viewerId = nextViewerId++;
      room.viewers.set(viewerId, socket);
      send(socket, { type: 'joined', role, viewerId });
      if (room.broadcaster) send(room.broadcaster, { type: 'viewer-joined', viewerId });
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
  return wss;
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

function reject(socket, error) {
  send(socket, { type: 'error', error });
  socket.close(1008, 'rejected');
}
