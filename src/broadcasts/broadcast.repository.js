// broadcasts 테이블 접근만 담당한다. 행(snake_case)을 도메인 레코드(camelCase)로 바꿔 돌려준다.
export function createBroadcastRepository(db) {
  const insertStmt = db.prepare(`
    INSERT INTO broadcasts (title, description, source_type, video_location, mime_type, file_size)
    VALUES (?, ?, ?, ?, ?, ?)
  `);
  const findAllStmt = db.prepare('SELECT * FROM broadcasts ORDER BY id DESC');
  const findByIdStmt = db.prepare('SELECT * FROM broadcasts WHERE id = ?');

  return {
    save({ title, description, sourceType, videoLocation, mimeType = null, fileSize = null }) {
      const { lastInsertRowid } = insertStmt.run(
        title, description, sourceType, videoLocation, mimeType, fileSize,
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
    createdAt: row.created_at,
  };
}
