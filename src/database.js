import { DatabaseSync } from 'node:sqlite';

// 스키마 변경은 배열 끝에 추가만 한다. 적용된 개수는 PRAGMA user_version 에 기록되므로
// 다음 단계(인증, 댓글 등)에서 테이블을 늘려도 기존 DB의 녹화방송 데이터가 유지된다.
const MIGRATIONS = [
  // 1: 녹화방송 메타데이터와 영상 위치
  `CREATE TABLE IF NOT EXISTS broadcasts (
     id             INTEGER PRIMARY KEY AUTOINCREMENT,
     title          TEXT    NOT NULL,
     description    TEXT    NOT NULL DEFAULT '',
     source_type    TEXT    NOT NULL CHECK (source_type IN ('upload', 'url')),
     video_location TEXT    NOT NULL,
     mime_type      TEXT,
     file_size      INTEGER,
     created_at     TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
   )`,
  // 2: 라이브 방송과 방송 상태
  `CREATE TABLE IF NOT EXISTS live_broadcasts (
     id         INTEGER PRIMARY KEY AUTOINCREMENT,
     title      TEXT    NOT NULL,
     status     TEXT    NOT NULL CHECK (status IN ('live', 'ended')),
     started_at TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
     ended_at   TEXT
   )`,
];

export function openDatabase(dbPath) {
  const db = new DatabaseSync(dbPath);
  db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;');
  migrate(db);
  return db;
}

function migrate(db) {
  const applied = db.prepare('PRAGMA user_version').get().user_version;
  for (let version = applied; version < MIGRATIONS.length; version++) {
    db.exec('BEGIN');
    try {
      db.exec(MIGRATIONS[version]);
      db.exec(`PRAGMA user_version = ${version + 1}`);
      db.exec('COMMIT');
    } catch (err) {
      db.exec('ROLLBACK');
      throw err;
    }
  }
}
