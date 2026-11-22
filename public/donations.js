// 후원: 방송별 합계·내역(공개), 후원하기(회원), 결제창에서 돌아온 결과 화면.
// 화면은 결제 결과를 서버에 전달만 한다. "후원 완료"는 서버가 결제 승인·금액·받는 소유자를 확인해 확정했다고 응답한 뒤에만 보여준다.
import { api, clone, mount, q, showError, session, loginHref, formatDate, isMine } from './common.js';

const BASE = { broadcast: '/api/broadcasts', live: '/api/lives' };
const PENDING_KEY = 'chzzk:pending-donation';
const PRESETS = [1000, 5000, 10000, 50000];

export const won = (n) => `${Number(n).toLocaleString('ko-KR')}원`;

let configPromise = null;
const loadConfig = () => (configPromise ??= api('/api/donations/config'));

// container 에 후원 영역을 그린다. 라이브 실시간 알림을 반영할 apply(donation) 을 돌려준다.
export function mountDonations(container, { targetType, targetId, resource }) {
  const root = clone('tpl-donations');
  container.replaceChildren(root);
  const list = q(root, 'list');
  const form = q(root, 'form');
  const note = q(root, 'note');
  const errorBox = q(root, 'error');
  const seen = new Set();
  let total = { amount: 0, count: 0 };

  const renderTotal = () => {
    q(root, 'total-amount').textContent = won(total.amount);
    q(root, 'total-count').textContent = `${total.count}건`;
  };

  function addItem(d, { prepend = false } = {}) {
    if (seen.has(d.id)) return false;
    seen.add(d.id);
    const li = clone('tpl-donation-item');
    q(li, 'amount').textContent = won(d.amount);
    q(li, 'donor').textContent = d.donor.nickname;
    q(li, 'date').textContent = formatDate(d.confirmedAt);
    q(li, 'message').textContent = d.message;
    q(li, 'message').hidden = !d.message;
    if (prepend) list.prepend(li);
    else list.append(li);
    return true;
  }

  // 누가 후원할 수 있는지 안내(실제 허용·거절은 서버가 정한다)
  if (resource.ownerId == null) {
    note.textContent = '소유자가 없는 방송에는 후원할 수 없습니다.';
    note.hidden = false;
  } else if (!session.member) {
    note.replaceChildren(
      Object.assign(document.createElement('a'), { href: loginHref(), textContent: '로그인' }),
      '하면 이 방송의 소유자에게 후원할 수 있습니다.',
    );
    note.hidden = false;
  } else if (isMine(resource)) {
    note.textContent = '내 방송에 들어온 후원입니다. 자기 방송에는 후원할 수 없습니다.';
    note.hidden = false;
  } else {
    setUpForm();
  }

  async function setUpForm() {
    const config = await loadConfig().catch((err) => { showError(errorBox, err.message); return null; });
    if (!config) return;
    form.hidden = false;
    form.amount.min = config.amountMin;
    form.amount.max = config.amountMax;
    form.amount.step = config.amountStep;
    form.amount.value = PRESETS[1];
    q(root, 'amount-hint').textContent = `${won(config.amountMin)}~${won(config.amountMax)}, ${won(config.amountStep)} 단위`;
    q(root, 'provider-note').textContent = config.provider === 'toss'
      ? '토스페이먼츠 테스트 결제창으로 이동합니다. 실제로 돈이 빠져나가지 않습니다.'
      : '내장 모의 결제창으로 이동합니다(토스 테스트 키 미설정). 실제 결제가 아닙니다.';
    const presets = q(root, 'presets');
    for (const amount of PRESETS) {
      const button = Object.assign(document.createElement('button'), { type: 'button', className: 'button secondary', textContent: won(amount) });
      button.addEventListener('click', () => { form.amount.value = amount; });
      presets.append(button);
    }

    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      errorBox.hidden = true;
      const submit = form.querySelector('button[type=submit]');
      submit.disabled = true;
      try {
        const order = await api('/api/donations/orders', {
          method: 'POST',
          json: { targetType, targetId, amount: Number(form.amount.value), message: form.message.value },
        });
        // 결제창이 취소로 돌아올 때 토스는 orderId 를 주지 않으므로, 어떤 주문이었는지 기억해 둔다.
        sessionStorage.setItem(PENDING_KEY, JSON.stringify({ orderId: order.orderId, returnTo: location.hash || '#/' }));
        await openPaymentWindow(order);
      } catch (err) {
        showError(errorBox, err.message);
        submit.disabled = false;
      }
    });
  }

  api(`${BASE[targetType]}/${targetId}/donations`)
    .then((data) => {
      total = data.total;
      renderTotal();
      data.donations.forEach((d) => addItem(d));
    })
    .catch((err) => showError(errorBox, err.message));
  renderTotal();

  return {
    // 라이브 WebSocket으로 받은 새 확정 후원
    apply(donation) {
      if (!addItem(donation, { prepend: true })) return;
      total = { amount: total.amount + donation.amount, count: total.count + 1 };
      renderTotal();
    },
  };
}

async function openPaymentWindow(order) {
  const successUrl = `${location.origin}/donation/success`;
  const failUrl = `${location.origin}/donation/fail`;
  const { payment } = order;

  if (payment.provider === 'mock') {
    const params = new URLSearchParams({
      orderId: order.orderId, amount: order.amount, orderName: order.orderName, successUrl, failUrl,
    });
    location.href = `${payment.payUrl}?${params}`;
    return;
  }

  // 토스페이먼츠 결제창(API 개별 연동 키 test_ck_…). 결제가 끝나면 successUrl/failUrl 로 이동한다.
  await loadScript(payment.sdkUrl);
  const tossPayments = window.TossPayments(payment.clientKey);
  const tossPayment = tossPayments.payment({ customerKey: order.customerKey });
  try {
    await tossPayment.requestPayment({
      method: 'CARD',
      amount: { currency: 'KRW', value: order.amount },
      orderId: order.orderId,
      orderName: order.orderName,
      customerName: order.customerName,
      successUrl,
      failUrl,
    });
  } catch (err) {
    // 결제창을 띄우기 전·도중의 SDK 오류(창 닫기 등). 주문을 취소·실패로 기록한다.
    await api(`/api/donations/orders/${order.orderId}/fail`, {
      method: 'POST', json: { code: err.code ?? 'SDK_ERROR', message: err.message },
    }).catch(() => {});
    throw new Error(err.code === 'USER_CANCEL' || err.code === 'PAY_PROCESS_CANCELED' ? '결제를 취소했습니다.' : `결제창 오류: ${err.message}`);
  }
}

function loadScript(src) {
  if (document.querySelector(`script[src="${src}"]`)) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const script = Object.assign(document.createElement('script'), { src, async: true });
    script.addEventListener('load', resolve);
    script.addEventListener('error', () => reject(new Error('결제 SDK를 불러오지 못했습니다.')));
    document.head.append(script);
  });
}

// 결제창에서 돌아온 화면. 성공이면 서버에 승인 확인·확정을 요청하고, 실패·취소면 주문 상태를 기록한다.
// 새로고침해도 같은 요청이 다시 갈 뿐이고 서버는 한 번만 적립한다.
export async function renderDonationResult(kind) {
  const root = mount('tpl-donation-result');
  const params = new URLSearchParams(location.search);
  const pending = JSON.parse(sessionStorage.getItem(PENDING_KEY) ?? 'null');
  const title = q(root, 'title');
  const message = q(root, 'message');
  const back = q(root, 'back');
  back.href = `/${pending?.returnTo ?? '#/'}`;

  if (kind === 'fail') {
    const code = params.get('code') ?? 'UNKNOWN';
    const orderId = params.get('orderId') ?? pending?.orderId;
    const canceled = code === 'PAY_PROCESS_CANCELED';
    title.textContent = canceled ? '후원을 취소했습니다' : '후원 결제에 실패했습니다';
    message.textContent = `${params.get('message') ?? ''} (${code}) 후원은 적립되지 않았습니다.`;
    if (orderId) {
      await api(`/api/donations/orders/${encodeURIComponent(orderId)}/fail`, {
        method: 'POST', json: { code, message: params.get('message') },
      }).catch(() => {});
    }
    sessionStorage.removeItem(PENDING_KEY);
    return;
  }

  const orderId = params.get('orderId');
  const paymentKey = params.get('paymentKey');
  try {
    const result = await api('/api/donations/confirm', {
      method: 'POST', json: { orderId, paymentKey, amount: Number(params.get('amount')) },
    });
    const d = result.donation;
    title.textContent = '♥ 후원 완료';
    message.textContent = result.alreadyConfirmed
      ? '이미 확정된 후원입니다. 같은 결제는 한 번만 적립됩니다.'
      : '서버가 결제 승인과 금액·받는 소유자를 확인해 후원을 확정했습니다.';
    q(root, 'recipient').textContent = d.recipient.nickname;
    q(root, 'amount').textContent = won(d.amount);
    q(root, 'donation-message').textContent = d.message || '-';
    q(root, 'order-id').textContent = d.orderId;
    q(root, 'details').hidden = false;
    back.href = `/#/${d.targetType === 'live' ? 'lives' : 'broadcasts'}/${d.targetId}`;
    sessionStorage.removeItem(PENDING_KEY);

    const config = await loadConfig().catch(() => null);
    if (config?.provider === 'mock') setUpResend(root, paymentKey, d);
  } catch (err) {
    title.textContent = '후원을 확정하지 못했습니다';
    message.textContent = `${err.message} 후원은 적립되지 않았습니다.`;
    message.className = 'error';
  }
}

// 모의 결제에서만: 같은 승인 통지를 결제 서비스가 다시 보내게 하고, 합계가 그대로인지 보여준다.
function setUpResend(root, paymentKey, donation) {
  q(root, 'mock-tools').hidden = false;
  const log = q(root, 'resend-log');
  q(root, 'resend').addEventListener('click', async () => {
    const before = await api(`${BASE[donation.targetType]}/${donation.targetId}/donations`);
    const res = await api(`/mock-pg/payments/${encodeURIComponent(paymentKey)}/webhook-resend?times=3`, { method: 'POST' });
    const after = await api(`${BASE[donation.targetType]}/${donation.targetId}/donations`);
    log.textContent = [
      ...res.results.map((r, i) => `통지 ${i + 1}: ${r.result}${r.reason ? ` — ${r.reason}` : ''}`),
      `후원 합계: ${won(before.total.amount)} (${before.total.count}건) → ${won(after.total.amount)} (${after.total.count}건)`,
    ].join('\n');
    log.hidden = false;
  });
}

// 라이브 후원 알림(잠깐 떴다 사라짐)
export function showDonationToast(donation) {
  const area = document.querySelector('[data-role="toasts"]');
  if (!area) return;
  const toast = document.createElement('div');
  toast.className = 'toast';
  const strong = Object.assign(document.createElement('strong'), { textContent: `${donation.donor.nickname}님 ${won(donation.amount)} 후원!` });
  toast.append(strong);
  if (donation.message) toast.append(Object.assign(document.createElement('p'), { textContent: donation.message }));
  area.append(toast);
  setTimeout(() => toast.remove(), 6000);
}
