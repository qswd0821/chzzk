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
  // 3: 회원·로그인 세션, 방송 소유자, 댓글
  //    이전 단계에서 만든 방송은 owner_id 가 NULL(소유자 없음)로 남는다.
  `CREATE TABLE members (
     id            INTEGER PRIMARY KEY AUTOINCREMENT,
     username      TEXT    NOT NULL UNIQUE,
     nickname      TEXT    NOT NULL UNIQUE,
     password_hash TEXT    NOT NULL,
     created_at    TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
   );
   CREATE TABLE sessions (
     token_hash TEXT    PRIMARY KEY,
     member_id  INTEGER NOT NULL REFERENCES members(id) ON DELETE CASCADE,
     created_at TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
     expires_at TEXT    NOT NULL
   );
   ALTER TABLE broadcasts ADD COLUMN owner_id INTEGER REFERENCES members(id);
   ALTER TABLE live_broadcasts ADD COLUMN owner_id INTEGER REFERENCES members(id);
   CREATE UNIQUE INDEX one_live_per_owner ON live_broadcasts(owner_id) WHERE status = 'live';
   CREATE TABLE comments (
     id          INTEGER PRIMARY KEY AUTOINCREMENT,
     target_type TEXT    NOT NULL CHECK (target_type IN ('broadcast', 'live')),
     target_id   INTEGER NOT NULL,
     author_id   INTEGER NOT NULL REFERENCES members(id),
     body        TEXT    NOT NULL,
     created_at  TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
     updated_at  TEXT
   );
   CREATE INDEX comments_by_target ON comments(target_type, target_id, id)`,
  // 4: 후원 주문과 모의 결제 서비스의 결제 기록
  //    order_id·payment_key UNIQUE 로 한 결제가 두 번 적립되거나 두 주문에 쓰이지 않게 한다.
  //    확정은 status='pending' 인 행만 'done' 으로 바꾸는 조건부 UPDATE 로 한 번만 성공한다.
  `CREATE TABLE donations (
     id              INTEGER PRIMARY KEY AUTOINCREMENT,
     order_id        TEXT    NOT NULL UNIQUE,
     donor_id        INTEGER NOT NULL REFERENCES members(id),
     recipient_id    INTEGER NOT NULL REFERENCES members(id),
     target_type     TEXT    NOT NULL CHECK (target_type IN ('broadcast', 'live')),
     target_id       INTEGER NOT NULL,
     amount          INTEGER NOT NULL CHECK (amount > 0),
     message         TEXT    NOT NULL DEFAULT '',
     provider        TEXT    NOT NULL,
     status          TEXT    NOT NULL CHECK (status IN ('pending', 'done', 'failed', 'canceled', 'expired')),
     payment_key     TEXT    UNIQUE,
     failure_code    TEXT,
     failure_message TEXT,
     created_at      TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
     confirmed_at    TEXT,
     CHECK (status <> 'done' OR payment_key IS NOT NULL)
   );
   CREATE INDEX donations_by_target ON donations(target_type, target_id, status);
   CREATE TABLE mock_payments (
     payment_key TEXT    PRIMARY KEY,
     order_id    TEXT    NOT NULL UNIQUE,
     amount      INTEGER NOT NULL,
     status      TEXT    NOT NULL CHECK (status IN ('READY', 'DONE')),
     created_at  TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
     approved_at TEXT
   )`,
];

export function openDatabase(dbPath) {
  const db = new DatabaseSync(dbPath);
  // 여러 인스턴스(프로세스)가 공유 볼륨의 같은 파일을 쓴다(docs/adr/0003). 잠금이 풀릴 때까지 최대 5초 기다린다.
  db.exec('PRAGMA busy_timeout = 5000; PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;');
  migrate(db);
  return db;
}

function migrate(db) {
  for (let version = currentVersion(db); version < MIGRATIONS.length; version++) {
    // 여러 인스턴스가 동시에 시작해도 한 인스턴스만 마이그레이션하도록 쓰기 잠금을 먼저 잡고 버전을 다시 확인한다.
    db.exec('BEGIN IMMEDIATE');
    if (currentVersion(db) > version) {
      db.exec('COMMIT');
      continue;
    }
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

function currentVersion(db) {
  return db.prepare('PRAGMA user_version').get().user_version;
}
