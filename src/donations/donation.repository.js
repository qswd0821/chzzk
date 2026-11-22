// donations 테이블 접근만 담당한다.
export function createDonationRepository(db) {
  const insertStmt = db.prepare(`
    INSERT INTO donations (order_id, donor_id, recipient_id, target_type, target_id, amount, message, provider, status)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'pending')
  `);
  const selectWithNames = `
    SELECT d.*, donor.nickname AS donor_nickname, recipient.nickname AS recipient_nickname
    FROM donations d
    JOIN members donor ON donor.id = d.donor_id
    JOIN members recipient ON recipient.id = d.recipient_id
  `;
  const byOrderIdStmt = db.prepare(`${selectWithNames} WHERE d.order_id = ?`);
  const confirmedForTargetStmt = db.prepare(`
    ${selectWithNames} WHERE d.target_type = ? AND d.target_id = ? AND d.status = 'done' ORDER BY d.confirmed_at DESC, d.id DESC
  `);
  const totalForTargetStmt = db.prepare(`
    SELECT COALESCE(SUM(amount), 0) AS amount, COUNT(*) AS count
    FROM donations WHERE target_type = ? AND target_id = ? AND status = 'done'
  `);
  // 결제 대기 → 확정. 이미 확정·실패·취소·만료된 주문이면 바뀌지 않는다(changes = 0).
  const confirmStmt = db.prepare(`
    UPDATE donations
    SET status = 'done', payment_key = ?, confirmed_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
    WHERE order_id = ? AND status = 'pending'
  `);
  const closeStmt = db.prepare(`
    UPDATE donations SET status = ?, failure_code = ?, failure_message = ?
    WHERE order_id = ? AND status = 'pending'
  `);

  return {
    create({ orderId, donorId, recipientId, targetType, targetId, amount, message, provider }) {
      insertStmt.run(orderId, donorId, recipientId, targetType, targetId, amount, message, provider);
      return this.findByOrderId(orderId);
    },

    findByOrderId(orderId) {
      const row = byOrderIdStmt.get(String(orderId ?? ''));
      return row ? toRecord(row) : null;
    },

    // 확정된 후원만, 최근 확정 순
    listConfirmedFor(targetType, targetId) {
      return confirmedForTargetStmt.all(targetType, targetId).map(toRecord);
    },

    totalFor(targetType, targetId) {
      const { amount, count } = totalForTargetStmt.get(targetType, targetId);
      return { amount: Number(amount), count: Number(count) };
    },

    // 이번 호출로 확정되었으면 true. 이미 처리된 주문이면 false.
    markConfirmed(orderId, paymentKey) {
      return confirmStmt.run(paymentKey, orderId).changes === 1;
    },

    // status: 'failed' | 'canceled' | 'expired'. 결제 대기 주문만 바뀐다.
    close(orderId, status, code, message) {
      return closeStmt.run(status, code ?? null, message ?? null, orderId).changes === 1;
    },
  };
}

function toRecord(row) {
  return {
    id: row.id,
    orderId: row.order_id,
    donorId: row.donor_id,
    donor: { id: row.donor_id, nickname: row.donor_nickname },
    recipientId: row.recipient_id,
    recipient: { id: row.recipient_id, nickname: row.recipient_nickname },
    targetType: row.target_type,
    targetId: row.target_id,
    amount: row.amount,
    message: row.message,
    provider: row.provider,
    status: row.status,
    paymentKey: row.payment_key,
    failureCode: row.failure_code,
    failureMessage: row.failure_message,
    createdAt: row.created_at,
    confirmedAt: row.confirmed_at,
  };
}
