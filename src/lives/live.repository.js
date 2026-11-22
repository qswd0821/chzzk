// live_broadcasts 테이블 접근만 담당한다. 행(snake_case)을 도메인 레코드(camelCase)로 바꿔 돌려준다.
export function createLiveRepository(db) {
  const insertStmt = db.prepare(`INSERT INTO live_broadcasts (title, status, owner_id) VALUES (?, 'live', ?)`);
  const selectWithOwner = `
    SELECT l.*, m.nickname AS owner_nickname
    FROM live_broadcasts l LEFT JOIN members m ON m.id = l.owner_id
  `;
  const findAllStmt = db.prepare(`
    ${selectWithOwner}
    ORDER BY CASE l.status WHEN 'live' THEN 0 ELSE 1 END, l.id DESC
  `);
  const findByIdStmt = db.prepare(`${selectWithOwner} WHERE l.id = ?`);
  const findOnAirByOwnerStmt = db.prepare(`${selectWithOwner} WHERE l.owner_id = ? AND l.status = 'live'`);
  const renameStmt = db.prepare('UPDATE live_broadcasts SET title = ? WHERE id = ?');
  const deleteStmt = db.prepare('DELETE FROM live_broadcasts WHERE id = ?');
  const endStmt = db.prepare(`
    UPDATE live_broadcasts
    SET status = 'ended', ended_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
    WHERE id = ? AND status = 'live'
  `);
  const onAirIdsStmt = db.prepare(`SELECT id FROM live_broadcasts WHERE status = 'live'`);

  return {
    create(title, ownerId) {
      const { lastInsertRowid } = insertStmt.run(title, ownerId);
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

    findOnAirByOwner(ownerId) {
      const row = findOnAirByOwnerStmt.get(ownerId);
      return row ? toRecord(row) : null;
    },

    rename(id, title) {
      renameStmt.run(title, id);
      return this.findById(id);
    },

    delete(id) {
      deleteStmt.run(id);
    },

    // 방송 중이던 것을 종료로 바꿨으면 true. 이미 종료였으면 false.
    markEnded(id) {
      return endStmt.run(id).changes > 0;
    },

    findOnAirIds() {
      return onAirIdsStmt.all().map((row) => row.id);
    },
  };
}

function toRecord(row) {
  return {
    id: row.id,
    title: row.title,
    status: row.status,
    ownerId: row.owner_id,
    owner: row.owner_id == null ? null : { id: row.owner_id, nickname: row.owner_nickname },
    startedAt: row.started_at,
    endedAt: row.ended_at,
  };
}
