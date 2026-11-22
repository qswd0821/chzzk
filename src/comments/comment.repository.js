// comments 테이블 접근만 담당한다. 댓글은 (target_type, target_id)로 녹화방송 또는 라이브 방송에 붙는다.
export function createCommentRepository(db) {
  const insertStmt = db.prepare('INSERT INTO comments (target_type, target_id, author_id, body) VALUES (?, ?, ?, ?)');
  const selectWithAuthor = `
    SELECT c.*, m.nickname AS author_nickname
    FROM comments c JOIN members m ON m.id = c.author_id
  `;
  const listStmt = db.prepare(`${selectWithAuthor} WHERE c.target_type = ? AND c.target_id = ? ORDER BY c.id ASC`);
  const byIdStmt = db.prepare(`${selectWithAuthor} WHERE c.id = ?`);
  const updateStmt = db.prepare(`UPDATE comments SET body = ?, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE id = ?`);
  const deleteStmt = db.prepare('DELETE FROM comments WHERE id = ?');
  const deleteForTargetStmt = db.prepare('DELETE FROM comments WHERE target_type = ? AND target_id = ?');

  return {
    create({ targetType, targetId, authorId, body }) {
      const { lastInsertRowid } = insertStmt.run(targetType, targetId, authorId, body);
      return this.findById(Number(lastInsertRowid));
    },

    // 오래된 댓글부터
    listFor(targetType, targetId) {
      return listStmt.all(targetType, targetId).map(toRecord);
    },

    findById(id) {
      const row = byIdStmt.get(id);
      return row ? toRecord(row) : null;
    },

    update(id, body) {
      updateStmt.run(body, id);
      return this.findById(id);
    },

    delete(id) {
      deleteStmt.run(id);
    },

    // 방송을 지울 때 그 방송의 댓글을 함께 지운다.
    deleteAllFor(targetType, targetId) {
      deleteForTargetStmt.run(targetType, targetId);
    },
  };
}

function toRecord(row) {
  return {
    id: row.id,
    targetType: row.target_type,
    targetId: row.target_id,
    authorId: row.author_id,
    author: { id: row.author_id, nickname: row.author_nickname },
    body: row.body,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}
