// live_broadcasts 테이블 접근만 담당한다. 행(snake_case)을 도메인 레코드(camelCase)로 바꿔 돌려준다.
export function createLiveRepository(db) {
  const insertStmt = db.prepare(`INSERT INTO live_broadcasts (title, status) VALUES (?, 'live')`);
  const findAllStmt = db.prepare(`
    SELECT * FROM live_broadcasts
    ORDER BY CASE status WHEN 'live' THEN 0 ELSE 1 END, id DESC
  `);
  const findByIdStmt = db.prepare('SELECT * FROM live_broadcasts WHERE id = ?');
  const endStmt = db.prepare(`
    UPDATE live_broadcasts
    SET status = 'ended', ended_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
    WHERE id = ? AND status = 'live'
  `);
  const endAllStmt = db.prepare(`
    UPDATE live_broadcasts
    SET status = 'ended', ended_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
    WHERE status = 'live'
  `);

  return {
    create(title) {
      const { lastInsertRowid } = insertStmt.run(title);
      return this.findById(Number(lastInsertRowid));
    },

    // 방송 중 먼저, 같은 상태끼리는 최신순
    findAll() {
      return findAllStmt.all().map(toRecord);
    },

    findById(id) {
      const row = findByIdStmt.get(id);
      return row ? toRecord(row) : null;
    },

    // 방송 중이던 것을 종료로 바꿨으면 true. 이미 종료였으면 false.
    markEnded(id) {
      return endStmt.run(id).changes > 0;
    },

    markAllEnded() {
      return Number(endAllStmt.run().changes);
    },
  };
}

function toRecord(row) {
  return {
    id: row.id,
    title: row.title,
    status: row.status,
    startedAt: row.started_at,
    endedAt: row.ended_at,
  };
}
