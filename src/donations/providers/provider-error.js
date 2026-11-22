// 결제 서비스가 돌려준 오류. code 는 토스페이먼츠 오류 코드 체계를 따른다(모의 결제도 같은 코드를 쓴다).
export class ProviderError extends Error {
  constructor(code, message, status = 400) {
    super(message);
    this.code = code;
    this.providerStatus = status;
  }
}

// 결제 서비스 포트가 돌려주는 결제 정보의 모양(토스 Payment 객체에서 쓰는 필드만)
//   { paymentKey, orderId, status: 'DONE' | ..., totalAmount, approvedAt }
export function toPayment(raw) {
  return {
    paymentKey: raw.paymentKey,
    orderId: raw.orderId,
    status: raw.status,
    totalAmount: Number(raw.totalAmount),
    approvedAt: raw.approvedAt ?? null,
  };
}
