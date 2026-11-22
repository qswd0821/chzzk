// members·sessions 테이블 접근만 담당한다.
// 세션 토큰은 원문이 아니라 SHA-256 해시로만 저장한다(DB가 유출돼도 토큰으로 로그인할 수 없다).
export function createMemberRepository(db) {
  const insertMember = db.prepare('INSERT INTO members (username, nickname, password_hash) VALUES (?, ?, ?)');
  const byId = db.prepare('SELECT * FROM members WHERE id = ?');
  const byUsername = db.prepare('SELECT * FROM members WHERE username = ?');
  const byNickname = db.prepare('SELECT id FROM members WHERE nickname = ?');

  const insertSession = db.prepare('INSERT INTO sessions (token_hash, member_id, expires_at) VALUES (?, ?, ?)');
  const memberBySession = db.prepare(`
    SELECT m.* FROM sessions s JOIN members m ON m.id = s.member_id
    WHERE s.token_hash = ? AND s.expires_at > strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
  `);
  const deleteSession = db.prepare('DELETE FROM sessions WHERE token_hash = ?');
  const deleteExpired = db.prepare(`DELETE FROM sessions WHERE expires_at <= strftime('%Y-%m-%dT%H:%M:%fZ', 'now')`);

  return {
    create({ username, nickname, passwordHash }) {
      const { lastInsertRowid } = insertMember.run(username, nickname, passwordHash);
      return toMember(byId.get(Number(lastInsertRowid)));
    },

    // 로그인 검증용: 비밀번호 해시를 포함해 돌려준다.
    findCredentialsByUsername(username) {
      const row = byUsername.get(username);
      return row ? { member: toMember(row), passwordHash: row.password_hash } : null;
    },

    usernameTaken(username) {
      return !!byUsername.get(username);
    },

    nicknameTaken(nickname) {
      return !!byNickname.get(nickname);
    },

    createSession(tokenHash, memberId, expiresAt) {
      insertSession.run(tokenHash, memberId, expiresAt);
    },

    findMemberBySession(tokenHash) {
      const row = memberBySession.get(tokenHash);
      return row ? toMember(row) : null;
    },

    deleteSession(tokenHash) {
      deleteSession.run(tokenHash);
    },

    deleteExpiredSessions() {
      deleteExpired.run();
    },
  };
}

// 비밀번호 해시는 절대 바깥으로 내보내지 않는다.
function toMember(row) {
  return { id: row.id, username: row.username, nickname: row.nickname, createdAt: row.created_at };
}
