import { DatabaseSync } from 'node:sqlite';

// 방송 메타데이터 저장소. 영상 자체는 디스크(업로드) 또는 외부 URL에 있고,
// 여기에는 제목과 "영상 위치"만 남긴다.
//   source_type = 'upload' → video_location 은 업로드 디렉터리 안의 파일명
//   source_type = 'url'    → video_location 은 외부 http(s) 영상 URL
export function openDatabase(dbPath) {
  const db = new DatabaseSync(dbPath);
  db.exec(`
    PRAGMA journal_mode = WAL;
    CREATE TABLE IF NOT EXISTS broadcasts (
      id             INTEGER PRIMARY KEY AUTOINCREMENT,
      title          TEXT    NOT NULL,
      description    TEXT    NOT NULL DEFAULT '',
      source_type    TEXT    NOT NULL CHECK (source_type IN ('upload', 'url')),
      video_location TEXT    NOT NULL,
      mime_type      TEXT,
      file_size      INTEGER,
      created_at     TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
    );
  `);

  const insertStmt = db.prepare(`
    INSERT INTO broadcasts (title, description, source_type, video_location, mime_type, file_size)
    VALUES (?, ?, ?, ?, ?, ?)
  `);
  const listStmt = db.prepare('SELECT * FROM broadcasts ORDER BY id DESC');
  const getStmt = db.prepare('SELECT * FROM broadcasts WHERE id = ?');

  return {
    createBroadcast({ title, description, sourceType, videoLocation, mimeType = null, fileSize = null }) {
      const { lastInsertRowid } = insertStmt.run(
        title, description, sourceType, videoLocation, mimeType, fileSize,
      );
      return getStmt.get(Number(lastInsertRowid));
    },
    listBroadcasts() {
      return listStmt.all();
    },
    getBroadcast(id) {
      return getStmt.get(id);
    },
    close() {
      db.close();
    },
  };
}
