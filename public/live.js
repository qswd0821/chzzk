// 라이브 방송: 송출(휴대폰 카메라·마이크 → WebRTC)과 시청.
// 영상은 송출자 브라우저가 시청자마다 RTCPeerConnection 을 맺어 직접 보내고,
// 서버(/ws/lives)는 연결 협상 메시지만 전달한다. (docs/adr/0001-webrtc-p2p-live-broadcast.md)
import { api, mount, q, showError, formatDate } from './common.js';

const signalingUrl = () => `${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/ws/lives`;

// ───────────────────────── 송출 ─────────────────────────

export function renderGoLive(onLeave) {
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
  let session = null; // 송출 중일 때의 { live, streamKey, socket, peers }

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
      const [{ live, streamKey }, rtcConfig] = await Promise.all([
        api('/api/lives', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ title }),
        }),
        api('/api/lives/rtc-config'),
      ]);
      session = startBroadcast({ live, streamKey, rtcConfig });
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
    const { live, streamKey } = session;
    try {
      await api(`/api/lives/${live.id}/end`, { method: 'POST', headers: { 'X-Stream-Key': streamKey } });
    } catch {
      // 이미 종료되었더라도 화면은 정리한다.
    }
    finish('송출을 종료했습니다. 방송 목록에 "종료"로 표시됩니다.');
  });

  function startBroadcast({ live, streamKey, rtcConfig }) {
    const socket = new WebSocket(signalingUrl());
    const peers = new Map(); // viewerId → RTCPeerConnection
    const pending = new Map(); // viewerId → answer 전에 도착한 ICE 후보
    const updateViewers = () => { q(root, 'viewers').textContent = `시청자 ${peers.size}명`; };

    socket.addEventListener('open', () => {
      socket.send(JSON.stringify({ type: 'join', role: 'broadcaster', liveId: live.id, streamKey }));
    });

    socket.addEventListener('message', async (event) => {
      const msg = JSON.parse(event.data);
      if (msg.type === 'viewer-joined') {
        const pc = new RTCPeerConnection(rtcConfig);
        peers.set(msg.viewerId, pc);
        updateViewers();
        stream.getTracks().forEach((track) => pc.addTrack(track, stream));
        pc.addEventListener('icecandidate', ({ candidate }) => {
          if (candidate) socket.send(JSON.stringify({ type: 'ice', to: msg.viewerId, candidate }));
        });
        const offer = await pc.createOffer();
        await pc.setLocalDescription(offer);
        socket.send(JSON.stringify({ type: 'offer', to: msg.viewerId, sdp: pc.localDescription }));
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
      } else if (msg.type === 'ended') {
        finish('방송이 종료되었습니다.');
      } else if (msg.type === 'error') {
        showError(errorBox, msg.error);
      }
    });

    // 서버와 연결이 끊기면 서버는 이 방송을 종료 처리한다.
    socket.addEventListener('close', () => {
      if (session) finish('서버와 연결이 끊겨 방송이 종료되었습니다.');
    });

    return { live, streamKey, socket, peers };
  }

  function finish(text) {
    if (session) {
      const { socket, peers } = session;
      session = null;
      for (const pc of peers.values()) pc.close();
      socket.close();
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

  // 다른 화면으로 이동하면 송출을 끝내고 카메라를 끈다.
  onLeave(() => {
    window.removeEventListener('beforeunload', warnBeforeUnload);
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
    socket?.close();
    pc?.close();
  });

  const showEnded = (text = '종료된 방송입니다.') => {
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

  document.title = `${live.title} - 치지직`;
  q(root, 'title').textContent = live.title;
  q(root, 'meta').textContent = live.status === 'live'
    ? `${formatDate(live.startedAt)} 시작`
    : `${formatDate(live.startedAt)} 시작 · ${formatDate(live.endedAt ?? live.startedAt)} 종료`;
  status.hidden = true;
  q(root, 'article').hidden = false;

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
  socket = new WebSocket(signalingUrl());

  socket.addEventListener('open', () => {
    socket.send(JSON.stringify({ type: 'join', role: 'viewer', liveId: live.id }));
  });

  socket.addEventListener('message', async (event) => {
    const msg = JSON.parse(event.data);
    if (msg.type === 'offer') {
      // 송출자가 카메라를 바꾸거나 다시 연결하면 새 offer 가 온다.
      pc?.close();
      pc = new RTCPeerConnection(rtcConfig);
      pc.addEventListener('track', ({ streams }) => {
        player.srcObject = streams[0];
        message.textContent = '';
      });
      pc.addEventListener('icecandidate', ({ candidate }) => {
        if (candidate) socket.send(JSON.stringify({ type: 'ice', candidate }));
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
      socket.send(JSON.stringify({ type: 'answer', sdp: pc.localDescription }));
    } else if (msg.type === 'ice') {
      if (pc?.remoteDescription) await pc.addIceCandidate(msg.candidate);
      else pendingCandidates.push(msg.candidate);
    } else if (msg.type === 'ended') {
      unmute.hidden = true;
      showEnded('방송이 종료되었습니다.');
    } else if (msg.type === 'error') {
      message.textContent = msg.error;
    }
  });

  socket.addEventListener('close', async () => {
    if (left || badge.classList.contains('ended')) return;
    // 서버가 재시작되었거나 네트워크가 끊긴 경우: 실제 방송 상태를 다시 확인한다.
    try {
      const latest = await api(`/api/lives/${live.id}`);
      if (latest.status !== 'live') showEnded('방송이 종료되었습니다.');
      else message.textContent = '서버와 연결이 끊겼습니다. 새로고침해 주세요.';
    } catch {
      message.textContent = '서버와 연결이 끊겼습니다. 새로고침해 주세요.';
    }
  });
}
