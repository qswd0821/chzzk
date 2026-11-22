// 데스크톱 클라이언트 화면: 방송 목록 → 녹화방송 재생 / 라이브 시청.
// 백엔드의 공개 조회 API 만 쓴다(로그인 쿠키 없음). 쓰기 기능은 "웹에서 열기"로 브라우저에 넘긴다.
const view = document.getElementById('view');
const $ = (root, role) => root.querySelector(`[data-role="${role}"]`);
const config = await window.chzzk.getConfig();
let server = config.serverUrl;
let leave = null; // 지금 화면을 떠날 때 정리할 일

const won = (n) => `${Number(n).toLocaleString('ko-KR')}원`;
const date = (iso) => (iso ? new Date(iso).toLocaleString('ko-KR', { dateStyle: 'medium', timeStyle: 'short' }) : '');
const ownerName = (r) => r.owner?.nickname ?? '소유자 없음';

async function api(pathname) {
  const res = await fetch(`${server}${pathname}`);
  if (!res.ok) throw new Error(`${pathname} → HTTP ${res.status}`);
  return res.json();
}

function mount(templateId) {
  leave?.();
  leave = null;
  const fragment = document.getElementById(templateId).content.cloneNode(true);
  const wrapper = document.createElement('div');
  wrapper.append(fragment);
  view.replaceChildren(wrapper);
  return wrapper;
}

function text(tag, content, className) {
  return Object.assign(document.createElement(tag), { textContent: content, className: className ?? '' });
}

// ── 상단 ──
function renderHeader() {
  $(document, 'server').textContent = server;
}
$(document, 'home').addEventListener('click', () => renderList());
$(document, 'refresh').addEventListener('click', () => renderList());
$(document, 'open-web').addEventListener('click', () => window.chzzk.openExternal(server));

const dialog = $(document, 'settings-dialog');
$(document, 'settings').addEventListener('click', () => {
  const form = $(document, 'settings-form');
  form.serverUrl.value = server;
  $(document, 'settings-error').hidden = true;
  $(document, 'about').textContent = `치지직 데스크톱 ${config.version} · ${config.platform}`;
  dialog.showModal();
});
$(document, 'settings-form').addEventListener('submit', async (e) => {
  if (e.submitter?.value !== 'save') return;
  e.preventDefault();
  try {
    server = await window.chzzk.setServerUrl(e.target.serverUrl.value.trim());
    dialog.close();
    renderHeader();
    renderList();
  } catch (err) {
    const box = $(document, 'settings-error');
    box.textContent = err.message.replace(/^Error invoking remote method '[^']+': (Error: )?/, '');
    box.hidden = false;
  }
});

// ── 목록 ──
async function renderList() {
  const root = mount('tpl-list');
  const card = ({ title, meta, badge, variant, onOpen }) => {
    const node = document.getElementById('tpl-card').content.cloneNode(true);
    $(node, 'title').textContent = title;
    $(node, 'meta').textContent = meta;
    $(node, 'badge').textContent = badge;
    if (variant) node.querySelector('.card').classList.add(variant);
    $(node, 'open').addEventListener('click', onOpen);
    return node;
  };

  try {
    const [lives, broadcasts] = await Promise.all([api('/api/lives'), api('/api/broadcasts')]);
    const onAir = lives.filter((l) => l.status === 'live').length;
    $(root, 'live-status').textContent = lives.length ? `방송 중 ${onAir}개 · 종료 ${lives.length - onAir}개` : '아직 라이브 방송이 없습니다.';
    $(root, 'live-list').replaceChildren(...lives.map((live) => card({
      title: live.title,
      meta: `${ownerName(live)} · ${date(live.status === 'live' ? live.startedAt : live.endedAt)}`,
      badge: live.status === 'live' ? '● 방송 중' : '종료',
      variant: live.status === 'live' ? 'on-air' : 'ended',
      onOpen: () => renderLive(live.id),
    })));
    $(root, 'status').textContent = broadcasts.length ? `총 ${broadcasts.length}개` : '아직 등록된 녹화방송이 없습니다. "웹에서 열기"로 등록할 수 있습니다.';
    $(root, 'list').replaceChildren(...broadcasts.map((b) => card({
      title: b.title,
      meta: `${ownerName(b)} · ${date(b.createdAt)}`,
      badge: b.sourceType === 'upload' ? '업로드' : 'URL',
      onOpen: () => renderBroadcast(b.id),
    })));
    if (config.smoke) runSmoke({ lives, broadcasts });
  } catch (err) {
    for (const role of ['live-status', 'status']) {
      $(root, role).textContent = `서버에 연결하지 못했습니다(${server}): ${err.message}. 설정에서 서버 주소를 확인하세요.`;
      $(root, role).className = 'error';
    }
    if (config.smoke) window.chzzk.reportSmoke({ ok: false, error: err.message });
  }
}

// ── 공통: 댓글·후원 내역(읽기 전용) ──
async function fillSide(root, type, id) {
  const base = type === 'live' ? `/api/lives/${id}` : `/api/broadcasts/${id}`;
  const [comments, donations] = await Promise.all([
    api(`${base}/comments`).catch(() => []),
    api(`${base}/donations`).catch(() => ({ total: { amount: 0, count: 0 }, donations: [] })),
  ]);
  const commentList = $(root, 'comments');
  const donationList = $(root, 'donations');
  const state = { comments: new Map(), total: donations.total };

  const drawComments = () => {
    $(root, 'comment-count').textContent = `${state.comments.size}개`;
    commentList.replaceChildren(...[...state.comments.values()].map((c) => {
      const li = document.createElement('li');
      li.append(text('strong', c.author.nickname), text('span', ` ${date(c.createdAt)}`, 'muted'), text('p', c.body));
      return li;
    }));
  };
  const addDonation = (d, prepend) => {
    const li = document.createElement('li');
    li.append(text('strong', `${won(d.amount)} `, 'amount'), text('span', d.donor.nickname), d.message ? text('p', d.message) : '');
    if (prepend) donationList.prepend(li); else donationList.append(li);
    $(root, 'donation-total').textContent = `${won(state.total.amount)} · ${state.total.count}건`;
  };

  comments.forEach((c) => state.comments.set(c.id, c));
  drawComments();
  $(root, 'donation-total').textContent = `${won(state.total.amount)} · ${state.total.count}건`;
  donations.donations.forEach((d) => addDonation(d, false));

  return {
    comment(action, c) {
      if (action === 'deleted') state.comments.delete(c.id); else state.comments.set(c.id, c);
      drawComments();
    },
    donation(d) {
      state.total = { amount: state.total.amount + d.amount, count: state.total.count + 1 };
      addDonation(d, true);
      toast(`${d.donor.nickname}님 ${won(d.amount)} 후원!`, d.message);
    },
  };
}

function toast(title, body) {
  const area = $(document, 'toasts');
  const el = text('div', '', 'toast');
  el.append(text('strong', title));
  if (body) el.append(text('p', body));
  area.append(el);
  setTimeout(() => el.remove(), 6000);
}

// ── 녹화방송 재생 ──
async function renderBroadcast(id) {
  const root = mount('tpl-player');
  $(root, 'back').addEventListener('click', () => renderList());
  try {
    const b = await api(`/api/broadcasts/${id}`);
    $(root, 'title').textContent = b.title;
    $(root, 'meta').textContent = `${ownerName(b)} · ${date(b.createdAt)} · ${b.sourceType === 'upload' ? '업로드 영상' : '외부 영상 URL'}`;
    $(root, 'description').textContent = b.description;
    const video = $(root, 'video');
    video.addEventListener('error', () => {
      $(root, 'error').textContent = '영상을 재생할 수 없습니다.';
      $(root, 'error').hidden = false;
    });
    // 업로드 영상은 서버의 /media/… 상대 경로로 온다.
    video.src = new URL(b.videoSrc, `${server}/`).href;
    $(root, 'web').addEventListener('click', () => window.chzzk.openExternal(`${server}/#/broadcasts/${b.id}`));
    await fillSide(root, 'broadcast', b.id);
  } catch (err) {
    $(root, 'error').textContent = err.message;
    $(root, 'error').hidden = false;
  }
}

// ── 라이브 시청 (WebRTC 시청자. 서버 인스턴스가 바뀌면 자동 재접속) ──
async function renderLive(id) {
  const root = mount('tpl-player');
  $(root, 'back').addEventListener('click', () => renderList());
  const video = $(root, 'video');
  const badge = $(root, 'live-badge');
  const errorBox = $(root, 'error');
  const say = (msg) => { errorBox.textContent = msg; errorBox.hidden = !msg; errorBox.className = 'muted'; };
  let socket = null;
  let pc = null;
  let left = false;
  let attempt = 0;
  leave = () => { left = true; socket?.close(1000); pc?.close(); };

  const live = await api(`/api/lives/${id}`);
  $(root, 'title').textContent = live.title;
  $(root, 'meta').textContent = `${ownerName(live)} · ${date(live.startedAt)} 시작`;
  $(root, 'web').addEventListener('click', () => window.chzzk.openExternal(`${server}/#/lives/${live.id}`));
  badge.hidden = false;
  const side = await fillSide(root, 'live', live.id);

  const ended = () => {
    badge.textContent = '종료';
    badge.className = 'live-badge ended';
    video.srcObject = null;
    say('종료된 방송입니다.');
  };
  if (live.status !== 'live') return ended();
  badge.textContent = '● 방송 중';
  video.muted = true;
  const unmute = $(root, 'unmute');
  unmute.hidden = false;
  unmute.addEventListener('click', () => { video.muted = false; video.play(); unmute.hidden = true; });

  const { iceServers } = await api('/api/lives/rtc-config');
  const wsUrl = `${server.replace(/^http/, 'ws')}/ws/lives`;
  const pending = [];
  const send = (m) => { if (socket?.readyState === WebSocket.OPEN) socket.send(JSON.stringify(m)); };

  const connect = () => {
    const ws = new WebSocket(wsUrl);
    socket = ws;
    ws.onopen = () => ws.send(JSON.stringify({ type: 'join', role: 'viewer', liveId: live.id }));
    ws.onmessage = async (event) => {
      const msg = JSON.parse(event.data);
      if (msg.type === 'joined') {
        attempt = 0;
        if (!video.srcObject) say('송출자와 연결하는 중…');
      } else if (msg.type === 'offer') {
        pc?.close();
        pc = new RTCPeerConnection({ iceServers });
        pc.ontrack = ({ streams }) => { video.srcObject = streams[0]; say(''); };
        pc.onicecandidate = ({ candidate }) => { if (candidate) send({ type: 'ice', candidate }); };
        await pc.setRemoteDescription(msg.sdp);
        for (const c of pending.splice(0)) await pc.addIceCandidate(c);
        await pc.setLocalDescription(await pc.createAnswer());
        send({ type: 'answer', sdp: pc.localDescription });
      } else if (msg.type === 'ice') {
        if (pc?.remoteDescription) await pc.addIceCandidate(msg.candidate); else pending.push(msg.candidate);
      } else if (msg.type === 'comment') {
        side.comment(msg.action, msg.comment);
      } else if (msg.type === 'donation') {
        side.donation(msg.donation);
      } else if (msg.type === 'ended') {
        ended();
      } else if (msg.type === 'error') {
        say(msg.error);
      }
    };
    ws.onclose = async (event) => {
      if (left || socket !== ws || badge.classList.contains('ended') || event.code === 1008) return;
      const latest = await api(`/api/lives/${live.id}`).catch(() => null);
      if (latest && latest.status !== 'live') return ended();
      say('서버와 다시 연결하는 중…');
      setTimeout(() => { if (!left) connect(); }, Math.min(500 * 2 ** attempt++, 5000));
    };
  };
  connect();
}

// ── 자동 확인(--smoke): 목록을 받고, 녹화방송이 있으면 첫 번째를 실제로 재생 준비(메타데이터 로드)까지 확인 ──
async function runSmoke({ lives, broadcasts }) {
  const result = { ok: true, lives: lives.length, broadcasts: broadcasts.length };
  if (broadcasts.length) {
    const first = await api(`/api/broadcasts/${broadcasts[0].id}`);
    const video = document.createElement('video');
    video.muted = true;
    video.preload = 'metadata';
    result.playback = await new Promise((resolve) => {
      const timer = setTimeout(() => resolve({ ok: false, reason: 'timeout' }), 20_000);
      video.onloadedmetadata = () => { clearTimeout(timer); resolve({ ok: video.duration > 0, duration: Math.round(video.duration), title: first.title }); };
      video.onerror = () => { clearTimeout(timer); resolve({ ok: false, reason: `media error ${video.error?.code}` }); };
      video.src = new URL(first.videoSrc, `${server}/`).href;
    });
    result.ok = result.playback.ok;
  }
  await new Promise((r) => setTimeout(r, 300)); // 스크린샷에 목록이 그려지도록
  window.chzzk.reportSmoke(result);
}

renderHeader();
renderList();
