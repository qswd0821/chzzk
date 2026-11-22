import crypto from 'node:crypto';
import { EventEmitter } from 'node:events';
import { HttpError, badRequest, conflict, forbidden, notFound } from '../http/errors.js';
import { requireMember } from '../auth/access.js';
import { ProviderError } from './providers/provider-error.js';

export const DonationStatus = Object.freeze({
  PENDING: 'pending', DONE: 'done', FAILED: 'failed', CANCELED: 'canceled', EXPIRED: 'expired',
});

export const AMOUNT_MIN = 1_000;
export const AMOUNT_MAX = 500_000;
export const AMOUNT_STEP = 1_000;
const MESSAGE_MAX = 100;
const ORDER_TTL_MS = 30 * 60 * 1000;
const USER_CANCEL_CODE = 'PAY_PROCESS_CANCELED';

// 후원 주문 생성, 결제 승인 확인, 확정, 중복 통지 처리.
// "화면이 성공이라고 했다"는 아무것도 확정하지 않는다. 확정은 오직 finalize() 에서
// 결제 서비스의 승인 결과(status·금액·주문번호)와 받는 소유자를 확인한 뒤 조건부 UPDATE 로 한 번만 일어난다.
//
// findTarget[type](id) → 방송(ownerId, owner 포함). 없으면 404.
// events: 'confirmed' (donation) — 이번에 새로 확정된 후원(라이브 실시간 알림용)
export function createDonationService({ repository, provider, findTarget, now = () => Date.now() }) {
  const events = new EventEmitter();

  function findOrder(orderId) {
    const order = repository.findByOrderId(orderId);
    if (!order) throw notFound('후원 주문을 찾을 수 없습니다.');
    return order;
  }

  function isExpired(order) {
    return now() - Date.parse(order.createdAt) > ORDER_TTL_MS;
  }

  function assertRecipientStillOwner(order) {
    let target;
    try {
      target = findTarget[order.targetType](order.targetId);
    } catch {
      throw failOrder(order, 'TARGET_NOT_FOUND', '후원할 방송이 삭제되었습니다.', 409);
    }
    if (target.ownerId !== order.recipientId) {
      throw failOrder(order, 'RECIPIENT_MISMATCH', '방송 소유자가 주문할 때와 달라 후원을 확정할 수 없습니다.', 409);
    }
  }

  function failOrder(order, code, message, status = 400) {
    repository.close(order.orderId, DonationStatus.FAILED, code, message);
    return new HttpError(status, message);
  }

  // 결제 서비스의 승인 결과를 주문과 맞춰 보고 확정한다. 리다이렉트 승인과 웹훅이 모두 여기로 온다.
  // 돌려주는 값: { donation, newlyConfirmed }
  function finalize(order, payment) {
    if (payment.orderId !== order.orderId) {
      throw failOrder(order, 'ORDER_MISMATCH', '결제 정보의 주문번호가 후원 주문과 다릅니다.');
    }
    if (payment.status !== 'DONE') {
      throw failOrder(order, `PAYMENT_${payment.status}`, `결제가 승인되지 않았습니다(상태: ${payment.status}).`);
    }
    if (payment.totalAmount !== order.amount) {
      throw failOrder(order, 'AMOUNT_MISMATCH', '승인된 금액이 후원 주문 금액과 다릅니다.');
    }
    assertRecipientStillOwner(order);

    let newlyConfirmed;
    try {
      newlyConfirmed = repository.markConfirmed(order.orderId, payment.paymentKey);
    } catch (err) {
      // 같은 결제키가 이미 다른 주문에 쓰였다(payment_key UNIQUE)
      if (/UNIQUE constraint failed: donations\.payment_key/.test(err.message)) {
        throw failOrder(order, 'PAYMENT_KEY_REUSED', '이미 다른 후원에 사용된 결제입니다.', 409);
      }
      throw err;
    }
    const donation = repository.findByOrderId(order.orderId);
    if (newlyConfirmed) {
      events.emit('confirmed', toPublic(donation));
    } else if (donation.status !== DonationStatus.DONE || donation.paymentKey !== payment.paymentKey) {
      throw conflict(`이미 ${statusLabel(donation.status)} 처리된 후원 주문입니다.`);
    }
    return { donation, newlyConfirmed };
  }

  return {
    events,

    clientConfig() {
      return { ...provider.clientConfig(), amountMin: AMOUNT_MIN, amountMax: AMOUNT_MAX, amountStep: AMOUNT_STEP };
    },

    // 1단계: 결제 전에 서버가 금액·받는 소유자·방송을 정해 저장한다(결제 대기).
    createOrder({ targetType, targetId, amount, message }, actor) {
      requireMember(actor);
      const target = findTarget[targetType]?.(targetId);
      if (!target) throw notFound('후원할 방송을 찾을 수 없습니다.');
      if (target.ownerId == null) throw badRequest('소유자가 없는 방송에는 후원할 수 없습니다.');
      if (target.ownerId === actor.id) throw forbidden('자기 방송에는 후원할 수 없습니다.');

      const cleanAmount = Number(amount);
      if (!Number.isInteger(cleanAmount) || cleanAmount < AMOUNT_MIN || cleanAmount > AMOUNT_MAX || cleanAmount % AMOUNT_STEP !== 0) {
        throw badRequest(`후원 금액은 ${AMOUNT_MIN.toLocaleString()}원~${AMOUNT_MAX.toLocaleString()}원, ${AMOUNT_STEP.toLocaleString()}원 단위여야 합니다.`);
      }
      const cleanMessage = String(message ?? '').trim();
      if (cleanMessage.length > MESSAGE_MAX) throw badRequest(`후원 메시지는 ${MESSAGE_MAX}자 이하여야 합니다.`);

      const order = repository.create({
        orderId: `don-${crypto.randomUUID()}`,
        donorId: actor.id,
        recipientId: target.ownerId,
        targetType,
        targetId,
        amount: cleanAmount,
        message: cleanMessage,
        provider: provider.name,
      });
      return {
        orderId: order.orderId,
        amount: order.amount,
        orderName: `${target.owner.nickname}님 후원`,
        customerKey: `member-${actor.id}-${crypto.randomUUID()}`,
        customerName: actor.nickname,
        payment: provider.clientConfig(),
      };
    },

    // 2단계: 결제창에서 성공으로 돌아온 뒤 화면이 요청한다. 같은 요청이 여러 번 와도 한 번만 확정된다.
    async confirm({ orderId, paymentKey, amount }, actor) {
      requireMember(actor);
      const order = findOrder(orderId);
      if (order.donorId !== actor.id) throw forbidden('내 후원 주문만 확정할 수 있습니다.');
      if (!paymentKey) throw badRequest('결제키가 없습니다.');

      if (order.status === DonationStatus.DONE) {
        if (order.paymentKey === paymentKey) return { donation: toPublic(order), alreadyConfirmed: true };
        throw conflict('이미 다른 결제로 확정된 후원 주문입니다.');
      }
      if (order.status !== DonationStatus.PENDING) throw conflict(`이미 ${statusLabel(order.status)} 처리된 후원 주문입니다.`);
      if (isExpired(order)) {
        repository.close(order.orderId, DonationStatus.EXPIRED, 'ORDER_EXPIRED', '결제 시간이 지나 만료되었습니다.');
        throw conflict('결제 시간(30분)이 지나 만료된 후원 주문입니다. 다시 후원해 주세요.');
      }
      // 리다이렉트 주소의 금액은 사용자가 바꿀 수 있다. 서버에 저장된 주문 금액과 같아야 한다.
      if (Number(amount) !== order.amount) {
        throw failOrder(order, 'AMOUNT_MISMATCH', '결제 금액이 후원 주문 금액과 다릅니다. 후원을 확정하지 않았습니다.');
      }
      assertRecipientStillOwner(order);

      let payment;
      try {
        // 결제 서비스에는 화면이 보낸 값이 아니라 서버가 저장한 주문 금액으로 승인을 요청한다.
        payment = await provider.confirm({ paymentKey, orderId: order.orderId, amount: order.amount });
      } catch (err) {
        if (!(err instanceof ProviderError)) throw err;
        if (err.code === 'ALREADY_PROCESSED_PAYMENT') {
          // 웹훅이 먼저 확정했거나 같은 승인 요청이 반복된 경우: 실제 상태를 조회해 같은 검증을 거친다.
          payment = await provider.getPayment(paymentKey);
        } else {
          throw failOrder(order, err.code, `결제 승인에 실패했습니다: ${err.message}`, 402);
        }
      }
      const { donation, newlyConfirmed } = finalize(repository.findByOrderId(order.orderId), payment);
      return { donation: toPublic(donation), alreadyConfirmed: !newlyConfirmed };
    },

    // 결제창에서 실패·취소로 돌아왔을 때. 사용자 취소(PAY_PROCESS_CANCELED)는 취소, 나머지는 실패.
    fail({ orderId, code, message }, actor) {
      requireMember(actor);
      const order = findOrder(orderId);
      if (order.donorId !== actor.id) throw forbidden('내 후원 주문만 바꿀 수 있습니다.');
      const status = code === USER_CANCEL_CODE ? DonationStatus.CANCELED : DonationStatus.FAILED;
      repository.close(order.orderId, status, String(code ?? 'UNKNOWN').slice(0, 100), String(message ?? '').slice(0, 300));
      return toPublic(repository.findByOrderId(order.orderId), { includeStatus: true });
    },

    // 결제 서비스의 상태 변경 웹훅(PAYMENT_STATUS_CHANGED). 같은 통지가 여러 번 와도 안전하다.
    // 본문은 믿지 않고 paymentKey 로 결제 서비스에 실제 상태를 다시 조회한다.
    // 결제 서비스가 재전송을 멈추도록, 처리했거나 무시한 통지에는 항상 결과를 돌려준다(라우터가 200 응답).
    async handleWebhook(body) {
      if (body?.eventType !== 'PAYMENT_STATUS_CHANGED') return { result: 'ignored', reason: '처리하지 않는 이벤트' };
      const paymentKey = body?.data?.paymentKey;
      if (!paymentKey) return { result: 'ignored', reason: 'paymentKey 없음' };

      let payment;
      try {
        payment = await provider.getPayment(paymentKey);
      } catch (err) {
        if (err instanceof ProviderError && err.code === 'NOT_FOUND_PAYMENT') return { result: 'ignored', reason: '결제 서비스에 없는 결제' };
        throw err; // 결제 서비스 장애: 500 을 돌려 재전송을 받는다.
      }
      const order = repository.findByOrderId(payment.orderId);
      if (!order) return { result: 'ignored', reason: '알 수 없는 주문' };
      if (payment.status !== 'DONE') return { result: 'ignored', reason: `결제 상태 ${payment.status}` };
      if (order.status === DonationStatus.DONE) {
        return { result: 'duplicate', orderId: order.orderId, reason: '이미 확정된 후원 — 다시 적립하지 않음' };
      }
      if (order.status !== DonationStatus.PENDING) {
        return { result: 'ignored', orderId: order.orderId, reason: `이미 ${statusLabel(order.status)} 처리된 주문` };
      }
      try {
        const { newlyConfirmed } = finalize(order, payment);
        return newlyConfirmed
          ? { result: 'confirmed', orderId: order.orderId }
          : { result: 'duplicate', orderId: order.orderId, reason: '이미 확정된 후원 — 다시 적립하지 않음' };
      } catch (err) {
        if (err instanceof HttpError) return { result: 'rejected', orderId: order.orderId, reason: err.message };
        throw err;
      }
    },

    // 방송별 후원 내역(확정된 것만)과 합계. 공개.
    listFor(targetType, targetId) {
      findTarget[targetType](targetId);
      return {
        total: repository.totalFor(targetType, targetId),
        donations: repository.listConfirmedFor(targetType, targetId).map((d) => toPublic(d)),
      };
    },
  };
}

// 공개 응답에는 결제키·실패 사유 같은 내부 정보를 넣지 않는다.
function toPublic(d, { includeStatus = false } = {}) {
  return {
    id: d.id,
    orderId: d.orderId,
    donor: d.donor,
    recipient: d.recipient,
    targetType: d.targetType,
    targetId: d.targetId,
    amount: d.amount,
    message: d.message,
    status: d.status,
    confirmedAt: d.confirmedAt,
    ...(includeStatus ? { failureCode: d.failureCode, failureMessage: d.failureMessage } : {}),
  };
}

function statusLabel(status) {
  return { done: '확정', failed: '실패', canceled: '취소', expired: '만료', pending: '결제 대기' }[status] ?? status;
}
