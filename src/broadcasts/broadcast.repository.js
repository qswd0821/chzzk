// broadcasts 테이블 접근만 담당한다. 행(snake_case)을 도메인 레코드(camelCase)로 바꿔 돌려준다.
export function createBroadcastRepository(db) {
  const insertStmt = db.prepare(`
    INSERT INTO broadcasts (title, description, source_type, video_location, mime_type, file_size, owner_id)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `);
  const selectWithOwner = `
    SELECT b.*, m.nickname AS owner_nickname
    FROM broadcasts b LEFT JOIN members m ON m.id = b.owner_id
  `;
  const findAllStmt = db.prepare(`${selectWithOwner} ORDER BY b.id DESC`);
  const findByIdStmt = db.prepare(`${selectWithOwner} WHERE b.id = ?`);
  const updateStmt = db.prepare('UPDATE broadcasts SET title = ?, description = ? WHERE id = ?');
  const deleteStmt = db.prepare('DELETE FROM broadcasts WHERE id = ?');

  return {
    save({ title, description, sourceType, videoLocation, mimeType = null, fileSize = null, ownerId }) {
      const { lastInsertRowid } = insertStmt.run(
        title, description, sourceType, videoLocation, mimeType, fileSize, ownerId,
      );
      return this.findById(Number(lastInsertRowid));
    },

    findAll() {
      return findAllStmt.all().map(toRecord);
    },

    findById(id) {
      const row = findByIdStmt.get(id);
      return row ? toRecord(row) : null;
    },

    update(id, { title, description }) {
      updateStmt.run(title, description, id);
      return this.findById(id);
    },

    delete(id) {
      deleteStmt.run(id);
    },
  };
}

function toRecord(row) {
  return {
    id: row.id,
    title: row.title,
    description: row.description,
    sourceType: row.source_type,
    videoLocation: row.video_location,
    mimeType: row.mime_type,
    fileSize: row.file_size,
    ownerId: row.owner_id,
    owner: row.owner_id == null ? null : { id: row.owner_id, nickname: row.owner_nickname },
    createdAt: row.created_at,
  };
}
