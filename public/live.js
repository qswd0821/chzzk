// 라이브 방송: 송출(휴대폰 카메라·마이크 → WebRTC)과 시청.
// 영상은 송출자 브라우저가 시청자마다 RTCPeerConnection 을 맺어 직접 보내고,
// 서버(/ws/lives)는 연결 협상 메시지와 라이브 댓글 변경만 전달한다. (docs/adr/0001-webrtc-p2p-live-broadcast.md)
// 송출은 로그인한 소유자만 할 수 있고, 서버가 세션 쿠키로 확인한다.
import { api, mount, q, showError, formatDate, showLoginRequired, ownerName, isMine } from './common.js';
import { mountComments } from './comments.js';
import { mountOwnerTools } from './owner-tools.js';
import { mountDonations, showDonationToast } from './donations.js';

const signalingUrl = () => `${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/ws/lives`;

// 서버 인스턴스가 바뀌거나(스케일 인·재배포) 네트워크가 잠깐 끊기면 다시 접속한다.
// 1000(정상 종료·방송 종료), 1008(권한 없음 등), 4001(다른 화면이 송출을 이어받음)은 다시 접속하지 않는다.
const NO_RECONNECT = new Set([1000, 1008, 4001]);
const reconnectDelay = (attempt) => Math.min(500 * 2 ** attempt, 5000);

// ───────────────────────── 송출 ─────────────────────────

export function renderGoLive(onLeave) {
  if (showLoginRequired('라이브 송출')) return;
  const root = mount('tpl-go-live');
  const preview = q(root, 'preview');
  const cameraBtn = q(root, 'camera');
  const flipBtn = q(root, 'flip');
  const form = q(root, 'form');
  const startBtn = q(root, 'start');
  const endBtn = q(root, 'end');
  const errorBox = q(root, 'error');
  const message = q(root, 'message');

  // 카메라·마이크는 보안 출처(HTTPS 또는 localhost)에서만 쓸 수 있다.
  if (!window.isSecureContext || !navigator.mediaDevices?.getUserMedia) {
    q(root, 'unsupported').hidden = false;
    cameraBtn.disabled = true;
    return;
  }

  let stream = null;
  let facingMode = 'user';
  let session = null; // 송출 중일 때의 { live, socket, peers }
  let liveComments = null;
  let liveDonations = null;

  async function openCamera() {
    errorBox.hidden = true;
    try {
      const next = await navigator.mediaDevices.getUserMedia({
        video: { facingMode, width: { ideal: 1280 }, height: { ideal: 720 } },
        audio: { echoCancellation: true, noiseSuppression: true },
      });
      stream?.getTracks().forEach((track) => track.stop());
      stream = next;
      preview.srcObject = stream;
      // 송출 중에 카메라를 바꾸면 연결을 다시 맺지 않고 영상 트랙만 갈아 끼운다.
      if (session) {
        const [videoTrack] = stream.getVideoTracks();
        const [audioTrack] = stream.getAudioTracks();
        for (const pc of session.peers.values()) {
          for (const sender of pc.getSenders()) {
            const track = sender.track?.kind === 'video' ? videoTrack : audioTrack;
            if (track) sender.replaceTrack(track);
          }
        }
      }
      cameraBtn.hidden = true;
      flipBtn.hidden = false;
      startBtn.disabled = !!session;
      message.textContent = session ? '' : '카메라·마이크가 켜졌습니다. 제목을 입력하고 송출을 시작하세요.';
    } catch (err) {
      showError(errorBox, cameraErrorMessage(err));
    }
  }

  cameraBtn.addEventListener('click', openCamera);
  flipBtn.addEventListener('click', () => {
    facingMode = facingMode === 'user' ? 'environment' : 'user';
    openCamera();
  });

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    errorBox.hidden = true;
    const title = form.title.value.trim();
    if (!stream) return showError(errorBox, '먼저 카메라·마이크를 켜 주세요.');
    if (!title) return showError(errorBox, '방송 제목을 입력해 주세요.');

    startBtn.disabled = true;
    try {
      const [live, rtcConfig] = await Promise.all([
        api('/api/lives', { method: 'POST', json: { title } }),
        api('/api/lives/rtc-config'),
      ]);
      session = startBroadcast({ live, rtcConfig });
      liveDonations = mountDonations(q(root, 'donations'), { targetType: 'live', targetId: live.id, resource: live });
      liveComments = mountComments(q(root, 'comments'), { targetType: 'live', targetId: live.id });
      form.hidden = true;
      q(root, 'controls').hidden = false;
      q(root, 'on-air').hidden = false;
      q(root, 'watch-link').href = `#/lives/${live.id}`;
      message.textContent = '송출 중입니다. 다른 화면에서 방송 목록 → 이 방송을 열면 시청할 수 있습니다.';
    } catch (err) {
      startBtn.disabled = false;
      showError(errorBox, err.message);
    }
  });

  endBtn.addEventListener('click', async () => {
    if (!session) return;
    endBtn.disabled = true;
    const { live } = session;
    try {
      await api(`/api/lives/${live.id}/end`, { method: 'POST' });
    } catch {
      // 이미 종료되었더라도 화면은 정리한다.
    }
    finish('송출을 종료했습니다. 방송 목록에 "종료"로 표시됩니다.');
  });

  function startBroadcast({ live, rtcConfig }) {
    const current = { live, socket: null, peers: new Map(), attempt: 0 };
    const { peers } = current; // viewerId → RTCPeerConnection
    const pending = new Map(); // viewerId → answer 전에 도착한 ICE 후보
    const updateViewers = () => { q(root, 'viewers').textContent = `시청자 ${peers.size}명`; };
    const send = (msg) => { if (current.socket?.readyState === WebSocket.OPEN) current.socket.send(JSON.stringify(msg)); };

    function connect() {
      const socket = new WebSocket(signalingUrl());
      current.socket = socket;
      socket.addEventListener('open', () => {
        socket.send(JSON.stringify({ type: 'join', role: 'broadcaster', liveId: live.id }));
      });
      socket.addEventListener('message', (event) => onMessage(JSON.parse(event.data)));
      socket.addEventListener('close', (event) => {
        if (session !== current || current.socket !== socket) return;
        if (NO_RECONNECT.has(event.code)) {
          if (event.code !== 1000) finish(event.reason === 'rejected' ? '송출이 거절되었습니다.' : '송출 연결이 닫혔습니다.');
          return;
        }
        // 서버 인스턴스가 바뀌는 중일 수 있다. 영상 연결은 다시 붙은 뒤 시청자마다 새로 맺는다.
        message.textContent = '서버와 다시 연결하는 중… (방송은 잠시 유지됩니다)';
        setTimeout(() => { if (session === current) connect(); }, reconnectDelay(current.attempt++));
      });
    }

    async function onMessage(msg) {
      if (msg.type === 'joined') {
        current.attempt = 0;
        // 다시 접속했다면 이전 영상 연결은 버리고, 서버가 알려 주는 시청자마다 새로 맺는다.
        for (const pc of peers.values()) pc.close();
        peers.clear();
        pending.clear();
        updateViewers();
        message.textContent = '송출 중입니다. 다른 화면에서 방송 목록 → 이 방송을 열면 시청할 수 있습니다.';
      } else if (msg.type === 'viewer-joined') {
        peers.get(msg.viewerId)?.close();
        const pc = new RTCPeerConnection(rtcConfig);
        peers.set(msg.viewerId, pc);
        updateViewers();
        stream.getTracks().forEach((track) => pc.addTrack(track, stream));
        pc.addEventListener('icecandidate', ({ candidate }) => {
          if (candidate) send({ type: 'ice', to: msg.viewerId, candidate });
        });
        const offer = await pc.createOffer();
        await pc.setLocalDescription(offer);
        send({ type: 'offer', to: msg.viewerId, sdp: pc.localDescription });
      } else if (msg.type === 'answer') {
        const pc = peers.get(msg.from);
        if (!pc) return;
        await pc.setRemoteDescription(msg.sdp);
        for (const candidate of pending.get(msg.from) ?? []) await pc.addIceCandidate(candidate);
        pending.delete(msg.from);
      } else if (msg.type === 'ice') {
        const pc = peers.get(msg.from);
        if (!pc) return;
        if (pc.remoteDescription) await pc.addIceCandidate(msg.candidate);
        else pending.set(msg.from, [...(pending.get(msg.from) ?? []), msg.candidate]);
      } else if (msg.type === 'viewer-left') {
        peers.get(msg.viewerId)?.close();
        peers.delete(msg.viewerId);
        pending.delete(msg.viewerId);
        updateViewers();
      } else if (msg.type === 'comment') {
        liveComments?.apply(msg.action, msg.comment);
      } else if (msg.type === 'donation') {
        liveDonations?.apply(msg.donation);
        showDonationToast(msg.donation);
      } else if (msg.type === 'ended') {
        finish('방송이 종료되었습니다.');
      } else if (msg.type === 'error') {
        showError(errorBox, msg.error);
      }
    }

    connect();
    return current;
  }

  function finish(text) {
    if (session) {
      const { socket, peers } = session;
      session = null;
      for (const pc of peers.values()) pc.close();
      socket?.close(1000);
    }
    stream?.getTracks().forEach((track) => track.stop());
    stream = null;
    preview.srcObject = null;
    q(root, 'on-air').hidden = true;
    q(root, 'controls').hidden = true;
    flipBtn.hidden = true;
    message.textContent = text;
  }

  const warnBeforeUnload = (e) => {
    if (!session) return;
    e.preventDefault();
    e.returnValue = '';
  };
  window.addEventListener('beforeunload', warnBeforeUnload);

  // 탭을 닫거나 다른 화면으로 이동하면 재접속 유예를 기다리지 않고 바로 종료한다.
  const endNow = () => {
    if (session) fetch(`/api/lives/${session.live.id}/end`, { method: 'POST', keepalive: true }).catch(() => {});
  };
  window.addEventListener('pagehide', endNow);

  onLeave(() => {
    window.removeEventListener('beforeunload', warnBeforeUnload);
    window.removeEventListener('pagehide', endNow);
    endNow();
    finish('');
  });
}

function cameraErrorMessage(err) {
  switch (err?.name) {
    case 'NotAllowedError':
      return '카메라·마이크 권한이 거부되었습니다. 브라우저 주소창의 사이트 설정에서 카메라·마이크를 "허용"으로 바꾼 뒤 다시 시도하세요.';
    case 'NotFoundError':
      return '사용할 수 있는 카메라나 마이크를 찾지 못했습니다.';
    case 'NotReadableError':
      return '다른 앱이 카메라·마이크를 쓰고 있습니다. 다른 앱을 닫고 다시 시도하세요.';
    default:
      return `카메라·마이크를 켜지 못했습니다: ${err?.message ?? err}`;
  }
}

// ───────────────────────── 시청 ─────────────────────────

export async function renderWatchLive(id, onLeave) {
  const root = mount('tpl-watch-live');
  const status = q(root, 'status');
  const player = q(root, 'player');
  const badge = q(root, 'badge');
  const message = q(root, 'message');

  let socket = null;
  let pc = null;
  let left = false;
  onLeave(() => {
    left = true;
    socket?.close(1000);
    pc?.close();
  });

  const showEnded = (text = '종료된 방송입니다.') => {
    q(root, 'end').hidden = true;
    badge.textContent = '종료';
    badge.className = 'live-badge ended';
    message.textContent = text;
    player.srcObject = null;
    player.hidden = true;
  };

  let live;
  try {
    live = await api(`/api/lives/${id}`);
  } catch (err) {
    status.textContent = err.message;
    status.className = 'error';
    return;
  }

  const showInfo = () => {
    document.title = `${live.title} - 치지직`;
    q(root, 'title').textContent = live.title;
    q(root, 'meta').textContent = live.status === 'live'
      ? `${ownerName(live)} · ${formatDate(live.startedAt)} 시작`
      : `${ownerName(live)} · ${formatDate(live.startedAt)} 시작 · ${formatDate(live.endedAt ?? live.startedAt)} 종료`;
  };
  showInfo();
  status.hidden = true;
  q(root, 'article').hidden = false;

  // 소유자에게만 제목 수정·삭제·종료 버튼을 보여준다(서버도 소유자인지 다시 검사한다).
  mountOwnerTools(q(root, 'owner-tools'), {
    resource: live,
    withDescription: false,
    deleteConfirm: '이 라이브 방송을 삭제할까요? 방송 중이면 종료되고, 댓글도 함께 지워집니다.',
    onSave: async ({ title }) => {
      live = await api(`/api/lives/${live.id}`, { method: 'PATCH', json: { title } });
      showInfo();
    },
    onDelete: async () => {
      await api(`/api/lives/${live.id}`, { method: 'DELETE' });
      location.hash = '#/';
    },
  });
  const endBtn = q(root, 'end');
  if (isMine(live) && live.status === 'live') {
    endBtn.hidden = false;
    endBtn.addEventListener('click', async () => {
      endBtn.disabled = true;
      try {
        await api(`/api/lives/${live.id}/end`, { method: 'POST' });
      } catch (err) {
        endBtn.disabled = false;
        message.textContent = err.message;
      }
    });
  }
  const liveDonations = mountDonations(q(root, 'donations'), { targetType: 'live', targetId: live.id, resource: live });
  const liveComments = mountComments(q(root, 'comments'), { targetType: 'live', targetId: live.id });

  const unmute = q(root, 'unmute');
  unmute.addEventListener('click', () => {
    player.muted = false;
    player.play();
    unmute.hidden = true;
  });

  if (live.status !== 'live') {
    unmute.hidden = true;
    return showEnded();
  }

  badge.textContent = '● 방송 중';
  badge.className = 'live-badge';
  message.textContent = '송출자와 연결하는 중…';

  const rtcConfig = await api('/api/lives/rtc-config');
  if (left) return;

  const pendingCandidates = [];
  let attempt = 0;
  const send = (msg) => { if (socket?.readyState === WebSocket.OPEN) socket.send(JSON.stringify(msg)); };

  function connect() {
    const ws = new WebSocket(signalingUrl());
    socket = ws;
    ws.addEventListener('open', () => {
      ws.send(JSON.stringify({ type: 'join', role: 'viewer', liveId: live.id }));
    });
    ws.addEventListener('message', (event) => onMessage(JSON.parse(event.data)));
    ws.addEventListener('close', async (event) => {
      if (left || socket !== ws || badge.classList.contains('ended')) return;
      if (NO_RECONNECT.has(event.code) && event.code !== 1000) return;
      // 서버 인스턴스가 바뀌었거나 네트워크가 끊긴 경우: 방송이 아직 진행 중이면 다시 접속한다.
      try {
        const latest = await api(`/api/lives/${live.id}`);
        if (latest.status !== 'live') return showEnded('방송이 종료되었습니다.');
      } catch {
        // 상태 확인도 실패하면 잠시 뒤 다시 시도한다.
      }
      message.textContent = '서버와 다시 연결하는 중…';
      setTimeout(() => { if (!left) connect(); }, reconnectDelay(attempt++));
    });
  }

  async function onMessage(msg) {
    if (msg.type === 'joined') {
      attempt = 0;
      if (!player.srcObject) message.textContent = '송출자와 연결하는 중…';
    } else if (msg.type === 'offer') {
      // 송출자가 카메라를 바꾸거나 다시 연결하면 새 offer 가 온다.
      pc?.close();
      pc = new RTCPeerConnection(rtcConfig);
      pc.addEventListener('track', ({ streams }) => {
        player.srcObject = streams[0];
        message.textContent = '';
      });
      pc.addEventListener('icecandidate', ({ candidate }) => {
        if (candidate) send({ type: 'ice', candidate });
      });
      pc.addEventListener('connectionstatechange', () => {
        if (pc.connectionState === 'failed') {
          message.textContent = '영상 연결에 실패했습니다. 서로 다른 네트워크라면 README의 TURN 설정을 확인하세요.';
        }
      });
      await pc.setRemoteDescription(msg.sdp);
      for (const candidate of pendingCandidates.splice(0)) await pc.addIceCandidate(candidate);
      const answer = await pc.createAnswer();
      await pc.setLocalDescription(answer);
      send({ type: 'answer', sdp: pc.localDescription });
    } else if (msg.type === 'ice') {
      if (pc?.remoteDescription) await pc.addIceCandidate(msg.candidate);
      else pendingCandidates.push(msg.candidate);
    } else if (msg.type === 'comment') {
      liveComments.apply(msg.action, msg.comment);
    } else if (msg.type === 'donation') {
      liveDonations.apply(msg.donation);
      showDonationToast(msg.donation);
    } else if (msg.type === 'ended') {
      unmute.hidden = true;
      showEnded('방송이 종료되었습니다.');
    } else if (msg.type === 'error') {
      message.textContent = msg.error;
    }
  }

  connect();
}
