import { ProviderError, toPayment } from './provider-error.js';

// 토스페이먼츠 테스트 모드 어댑터 (결제창, API 개별 연동 키 test_ck / test_sk)
//   승인: POST {apiBase}/v1/payments/confirm  { paymentKey, orderId, amount }
//   조회: GET  {apiBase}/v1/payments/{paymentKey}
//   인증: Authorization: Basic base64("{시크릿 키}:")
// 시크릿 키는 서버에만 두고 브라우저에는 클라이언트 키만 내려준다.
export function createTossProvider({ clientKey, secretKey, apiBase, fetchImpl = fetch }) {
  const authorization = `Basic ${Buffer.from(`${secretKey}:`).toString('base64')}`;

  async function call(method, path, body) {
    let res;
    try {
      res = await fetchImpl(`${apiBase}${path}`, {
        method,
        headers: { Authorization: authorization, 'Content-Type': 'application/json' },
        body: body ? JSON.stringify(body) : undefined,
        signal: AbortSignal.timeout(15_000),
      });
    } catch (err) {
      throw new ProviderError('PROVIDER_UNREACHABLE', `결제 서비스에 연결하지 못했습니다: ${err.message}`, 502);
    }
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new ProviderError(data.code ?? 'PROVIDER_ERROR', data.message ?? `결제 서비스 오류 (HTTP ${res.status})`, res.status);
    return toPayment(data);
  }

  return {
    name: 'toss',

    // 브라우저가 결제창을 열 때 필요한 공개 정보
    clientConfig() {
      return { provider: 'toss', clientKey, sdkUrl: 'https://js.tosspayments.com/v2/standard' };
    },

    confirm({ paymentKey, orderId, amount }) {
      return call('POST', '/v1/payments/confirm', { paymentKey, orderId, amount });
    },

    getPayment(paymentKey) {
      return call('GET', `/v1/payments/${encodeURIComponent(paymentKey)}`);
    },
  };
}
