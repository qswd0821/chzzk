// 모의 결제창: 토스 결제창처럼 결과에 따라 successUrl / failUrl 로 이동한다.
//   성공 → successUrl?paymentKey&orderId&amount
//   실패 → failUrl?code=REJECT_CARD_COMPANY&message&orderId
//   취소 → failUrl?code=PAY_PROCESS_CANCELED&message   (토스처럼 orderId 를 주지 않는다)
const params = new URLSearchParams(location.search);
const orderId = params.get('orderId') ?? '';
const amount = Number(params.get('amount'));
const $ = (role) => document.querySelector(`[data-role="${role}"]`);

// 같은 사이트 주소로만 돌려보낸다(다른 사이트로 결제 결과를 넘기는 오픈 리다이렉트 방지).
function sameOriginUrl(value) {
  try {
    const url = new URL(value, location.origin);
    return url.origin === location.origin ? url : null;
  } catch {
    return null;
  }
}

const successUrl = sameOriginUrl(params.get('successUrl'));
const failUrl = sameOriginUrl(params.get('failUrl'));

$('order-name').textContent = params.get('orderName') ?? '';
$('amount').textContent = `${amount.toLocaleString('ko-KR')}원`;
$('order-id').textContent = orderId;
$('pay-amount').value = amount;
$('redirect-amount').value = amount;

if (!orderId || !amount || !successUrl || !failUrl) {
  $('error').textContent = '결제 요청 정보가 올바르지 않습니다.';
  $('error').hidden = false;
  document.querySelectorAll('.mock-actions button').forEach((b) => { b.disabled = true; });
}

function go(base, query) {
  for (const [k, v] of Object.entries(query)) base.searchParams.set(k, v);
  location.href = base.href;
}

$('success').addEventListener('click', async () => {
  $('success').disabled = true;
  const res = await fetch('/mock-pg/payments', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ orderId, amount: Number($('pay-amount').value) }),
  });
  const payment = await res.json();
  if (!res.ok) {
    $('error').textContent = payment.message ?? '결제를 만들지 못했습니다.';
    $('error').hidden = false;
    $('success').disabled = false;
    return;
  }
  go(successUrl, { paymentKey: payment.paymentKey, orderId, amount: $('redirect-amount').value });
});

$('fail').addEventListener('click', () => {
  go(failUrl, { code: 'REJECT_CARD_COMPANY', message: '결제 승인이 거절되었습니다.', orderId });
});

$('cancel').addEventListener('click', () => {
  go(failUrl, { code: 'PAY_PROCESS_CANCELED', message: '사용자에 의해 결제가 취소되었습니다.' });
});
