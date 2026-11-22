# 치지직

누구나 **방송**을 보고, **회원**은 방송을 올리고 댓글을 다는 웹 서비스입니다.

- **녹화방송** (1단계): 영상 파일을 업로드하거나 이미 저장된 영상 URL을 연결해 등록하고, 목록 → 상세 화면에서 재생합니다.
- **라이브 방송** (2단계): 휴대폰 브라우저에서 카메라·마이크로 라이브 방송을 시작·종료하고, 다른 화면에서 방송 목록 → 라이브 방송을 골라 실시간으로 시청합니다. 방송 중·종료 상태를 구분해 표시합니다.
- **인증·인가와 댓글** (3단계): 회원가입·로그인·로그아웃, 방송 소유자만 할 수 있는 수정·삭제·송출 제어, 녹화방송과 라이브 방송의 댓글(라이브는 실시간), 작성자만 할 수 있는 댓글 수정·삭제. **모든 권한은 서버가 검사합니다.**

기술 구성:

- 서버: Node.js + Express, 업로드는 multer, 라이브 시그널링·실시간 댓글은 WebSocket(`ws`)
- 저장소: Node 내장 SQLite(`node:sqlite`): 별도 DB 설치나 네이티브 빌드가 필요 없습니다
- 인증: 서버 세션 + `HttpOnly; SameSite=Lax` 쿠키, 비밀번호는 Node 내장 `scrypt` 해시
- 화면: 빌드 단계 없는 정적 HTML/CSS/JS(해시 라우팅 SPA)
- 라이브 송출: 브라우저 `getUserMedia`(카메라·마이크) + **WebRTC P2P**. 서버는 연결 협상 메시지만 중계합니다 ([ADR 0001](docs/adr/0001-webrtc-p2p-live-broadcast.md))
- 용어: [GLOSSARY.md](GLOSSARY.md)

## 실행 방법

요구 사항: **Node.js 22.13 이상** (`node:sqlite` 기본 사용 가능 버전, 24 LTS 권장)

```bash
git clone https://github.com/qswd0821/chzzk.git
cd chzzk
npm install
cp .env.example .env   # HTTPS=true 등 기본 설정이 들어 있습니다
npm start
```

- `.env` 없이 `npm start` 하면 **HTTP**로 뜹니다: <http://localhost:3000>. PC 브라우저에서 모든 기능(가입·로그인, 녹화방송, 라이브 시청·댓글)을 쓸 수 있습니다. `localhost` 는 브라우저가 보안 출처로 취급하므로 PC 웹캠 송출도 됩니다.
- **휴대폰에서 송출**하려면 `.env` 의 `HTTPS=true` 로 실행합니다(`.env.example` 기본값). 서버가 켜질 때 휴대폰에서 열 주소를 출력합니다.

  ```
  치지직 서버 실행 중: https://localhost:3000
    같은 Wi-Fi 휴대폰에서: https://192.168.0.12:3000
  ```

- 이전 단계에서 쓰던 `data/replay.db` 가 있으면 시작할 때 자동으로 스키마가 올라갑니다(마이그레이션 3). 기존 방송은 그대로 남고 **소유자 없음**으로 표시됩니다.

개발 중에는 `npm run dev`(파일 변경 시 자동 재시작)를 쓸 수 있습니다.

테스트:

```bash
npm test
```

## 환경변수

`.env.example` 을 복사해 `.env` 로 사용합니다. `npm start` 가 `.env` 를 자동으로 읽습니다(Node `--env-file-if-exists`).
이번 단계에서 추가로 필요한 비밀 값은 없습니다. 세션 토큰은 서버가 로그인할 때마다 무작위로 만들고, DB에는 해시만 저장합니다.

| 변수 | 기본값 | 설명 |
| --- | --- | --- |
| `PORT` | `3000` | 서버 포트 |
| `DATA_DIR` | `./data` | SQLite DB(`replay.db`: 방송·회원·세션·댓글), 업로드 영상(`uploads/`), 자체 서명 인증서(`tls/`)가 저장될 디렉터리. 상대 경로는 프로젝트 루트 기준 |
| `MAX_UPLOAD_MB` | `500` | 업로드 가능한 영상 파일 최대 크기(MB) |
| `HTTPS` | `false` | `true` 면 HTTPS(+WSS)로 실행. 휴대폰 카메라·마이크는 HTTPS에서만 허용됩니다. HTTPS면 세션 쿠키에 `Secure` 가 붙습니다 |
| `HTTPS_KEY`, `HTTPS_CERT` | (비움) | 가진 인증서 파일 경로(PEM). 비워 두면 자체 서명 인증서를 자동 생성해 `DATA_DIR/tls/` 에 보관하고 재사용합니다 |
| `STUN_URLS` | `stun:stun.l.google.com:19302` | WebRTC STUN 서버. 쉼표로 여러 개 |
| `TURN_URL`, `TURN_USERNAME`, `TURN_CREDENTIAL` | (비움) | 휴대폰 LTE ↔ PC Wi-Fi 처럼 서로 다른 네트워크에서 연결이 안 될 때 쓰는 TURN 서버 |

```dotenv
PORT=3000
DATA_DIR=./data
MAX_UPLOAD_MB=500
HTTPS=true
HTTPS_KEY=
HTTPS_CERT=
STUN_URLS=stun:stun.l.google.com:19302
# 예시 값입니다. 실제 TURN 비밀번호는 커밋하지 마세요.
TURN_URL=turn:turn.example.com:3478
TURN_USERNAME=example-user
TURN_CREDENTIAL=example-password
```

## 공개 범위와 권한

**시청과 조회는 공개, 쓰기는 회원, 관리는 소유자·작성자**입니다. 아래 허용·거절은 모두 **서버가** 요청마다 세션 쿠키로 회원을 확인해 정합니다.
화면에서 버튼을 숨기는 것은 편의일 뿐이므로, 버튼 없이 API를 직접 호출해도 같은 401/403을 받습니다.

| 기능 | 비로그인 | 로그인 회원 | 소유자 / 작성자 |
| --- | --- | --- | --- |
| 방송 목록, 녹화방송 상세·재생, 라이브 시청, 댓글 목록 | ✅ 공개 | ✅ | ✅ |
| 녹화방송 등록, 라이브 시작, 댓글 작성 | ❌ 401 | ✅ | ✅ |
| 녹화방송 수정(제목·설명)·삭제 | ❌ 401 | ❌ 403 | ✅ 소유자 |
| 라이브 송출(WebSocket 송출자 참여)·종료·제목 수정·삭제 | ❌ 401 | ❌ 403 | ✅ 소유자 |
| 댓글 수정·삭제 | ❌ 401 | ❌ 403 (방송 소유자도 불가) | ✅ 작성자 |

- **시청을 공개로 둔 이유**: 방송은 많은 사람이 보는 것이 목적이고, 1·2단계부터 누구나 볼 수 있었습니다. 대신 서비스에 무언가를 남기는 행위(등록·송출·댓글)는 누가 했는지 알아야 하므로 로그인을 요구합니다.
- **소유자 없음**: 회원 제도 이전(1·2단계)에 만든 방송은 소유자가 없습니다. 시청과 댓글은 되지만 **누구도 수정·삭제할 수 없습니다**(403).
- 한 회원은 동시에 하나의 라이브만 **방송 중**일 수 있습니다(두 번째 시작은 409).
- 다른 회원의 라이브에 송출자로 참여하려 하면 WebSocket이 "방송 소유자만 송출할 수 있습니다"로 거절됩니다. 시청자 참여는 비로그인도 됩니다.

### 보안 처리

- **비밀번호**: 회원마다 다른 salt + `scrypt` 해시로 저장하고 timing-safe 비교. 없는 아이디로 로그인해도 같은 시간·같은 메시지("아이디 또는 비밀번호가 올바르지 않습니다")로 응답합니다.
- **세션**: 로그인하면 32바이트 무작위 토큰을 `HttpOnly`(스크립트에서 읽을 수 없음), `SameSite=Lax` 쿠키로 줍니다. DB에는 토큰의 SHA-256 해시만 저장하며 7일 후 만료됩니다. 로그아웃하면 서버의 세션을 지우므로 같은 토큰은 즉시 무효가 됩니다.
- **CSRF**: `SameSite=Lax` 에 더해, 상태를 바꾸는 API 요청과 WebSocket 연결에 다른 출처의 `Origin` 이 붙어 있으면 거절합니다(403).
- **업로드**: 비로그인 요청은 업로드 파일을 디스크에 쓰기 전에 401로 거절합니다.
- **화면 출력**: 사용자 입력(제목·댓글·닉네임)은 모두 `textContent` 로 넣어 HTML로 해석되지 않습니다.

## 구현 범위

체크리스트 항목별 구현 위치:

| 체크리스트 | 서버 | 화면 |
| --- | --- | --- |
| 녹화방송과 휴대폰 라이브 송출·시청 유지 | 녹화방송 [src/broadcasts/](src/broadcasts/), 라이브 [src/lives/](src/lives/) (WebRTC 시그널링 [live.signaling.js](src/lives/live.signaling.js)) | [public/app.js](public/app.js) 목록·등록·상세, [public/live.js](public/live.js) 송출·시청 |
| 회원가입·로그인·로그아웃과 인증 상태 관리 | `POST /api/auth/signup`·`/login`·`/logout`, `GET /api/auth/me` — [auth.router.js](src/auth/auth.router.js) → [auth.service.js](src/auth/auth.service.js), 비밀번호 [password.js](src/auth/password.js), 세션 저장 [member.repository.js](src/auth/member.repository.js), 쿠키·`req.member` [session-cookie.js](src/auth/session-cookie.js) | 로그인·가입 `#/login`·`#/signup` — [public/auth.js](public/auth.js), 헤더 로그인 상태 [public/common.js](public/common.js) `refreshSession`/`renderAuthArea` |
| 서버에서 소유자·인증 상태를 검사해 방송 관리·송출 제어 제한 | 권한 규칙 [src/auth/access.js](src/auth/access.js) (`requireMember`/`requireOwner`), 적용: [broadcast.service.js](src/broadcasts/broadcast.service.js) `register`/`update`/`remove`, [live.service.js](src/lives/live.service.js) `start`/`end`/`rename`/`remove`/`canBroadcast`, 송출자 WebSocket 참여 [live.signaling.js](src/lives/live.signaling.js) `join` | 소유자에게만 수정·삭제·종료 버튼 [public/owner-tools.js](public/owner-tools.js) (편의용, 실제 검사는 서버) |
| 방송별 댓글 저장·조회와 로그인 작성자 연결 | `GET/POST /api/broadcasts/:id/comments`, `GET/POST /api/lives/:id/comments` — [comment.router.js](src/comments/comment.router.js) → [comment.service.js](src/comments/comment.service.js) → [comment.repository.js](src/comments/comment.repository.js) (`comments.author_id`), 라이브 댓글 실시간 전달 [live.signaling.js](src/lives/live.signaling.js) | 댓글 영역 [public/comments.js](public/comments.js) (녹화방송 상세, 라이브 시청·송출 화면) |
| 서버에서 비로그인 댓글 작성 거절, 작성자만 수정·삭제 | [comment.service.js](src/comments/comment.service.js) `create`(`requireMember` → 401), `update`/`remove`(`requireAuthor` → 401/403), `PATCH/DELETE /api/comments/:id` | 작성자에게만 수정·삭제 버튼 |
| README | 이 문서 | — |

### 녹화방송 (1단계 + 3단계)

- **등록**(회원): 제목(필수, 100자 이하), 설명(선택, 2000자 이하), 영상 파일 *또는* 영상 URL 중 정확히 하나. 등록한 회원이 소유자가 됩니다.
  - 파일: `video/*` MIME만 허용, `MAX_UPLOAD_MB` 이하. `DATA_DIR/uploads/` 에 충돌 없는 이름으로 저장됩니다.
  - URL: `http://` / `https://` 만 허용(`javascript:` 등 차단).
  - 검증에 실패하면 400과 한국어 오류 메시지를 반환하고, 이미 받은 업로드 파일은 삭제합니다.
- **수정**(소유자): 제목·설명만 바꿉니다. 영상 교체는 하지 않습니다.
- **삭제**(소유자): 방송, 업로드된 영상 파일, 그 방송의 댓글을 함께 지웁니다. 되돌릴 수 없습니다.
- **재생**(공개): 업로드 영상은 `/media/` 경로에서 HTTP Range 요청을 지원하므로 탐색(seek)이 됩니다.

### 라이브 방송 (2단계 + 3단계)

- **송출 시작**(회원): 송출 화면에서 `카메라·마이크 켜기` → 권한 허용 → 제목 입력 → `● 송출 시작`. 시작한 회원이 소유자가 되고, 송출 화면은 WebSocket으로 접속해 송출자로 참여합니다. 서버는 이때 세션 쿠키로 **소유자인지** 확인합니다.
- **영상 전달**: 시청자가 들어오면 송출자 브라우저가 그 시청자와 WebRTC 연결을 맺어 영상·음성을 직접 보냅니다. 서버는 offer/answer/ICE 메시지만 중계합니다. 송출 중 `↻ 카메라 전환`(전면/후면)은 연결을 끊지 않고 트랙만 바꿉니다.
- **송출 종료**(소유자): 송출 화면의 `■ 송출 종료` 또는 시청 화면의 `■ 방송 종료`. 서버가 상태를 **종료**로 바꾸고 시청자에게 즉시 알립니다.
- **제목 수정·삭제**(소유자): 시청 화면의 관리 영역. 방송 중인 라이브를 삭제하면 먼저 종료해 시청자에게 알리고, 댓글도 함께 지웁니다.
- **자동 종료**: 송출자 연결이 끊김(탭 닫기·화면 꺼짐·네트워크 끊김은 15초 간격 heartbeat로 감지), 시작 후 30초 안에 송출자 미접속, 서버 재시작. 한 번 종료된 방송은 다시 방송 중으로 돌아가지 않습니다.
- **시청**(공개): 방송 목록의 라이브 카드(● 방송 중)를 누르면 자동 재생됩니다(음소거로 시작, `🔊 소리 켜기`).

### 댓글 (3단계)

- 녹화방송과 라이브 방송 **모두**에 달 수 있고, 종료된 라이브에도 조회·작성할 수 있습니다. 1~500자.
- 목록은 누구나 볼 수 있고 오래된 순입니다. 작성은 로그인 회원만 할 수 있고, 작성자 닉네임이 함께 표시됩니다.
- 수정·삭제는 **작성자만** 할 수 있습니다. 방송 소유자라도 남의 댓글은 고치거나 지울 수 없습니다. 수정한 댓글에는 "(수정됨)"이 붙습니다.
- **라이브 댓글은 실시간**: 작성·수정·삭제가 그 라이브에 연결된 모든 시청자와 송출자(휴대폰 송출 화면 포함)에게 WebSocket으로 즉시 전달됩니다. 녹화방송 댓글은 내가 쓴 것만 바로 반영되고, 새로고침하면 다른 사람 댓글이 보입니다.

### API

| 메서드 | 경로 | 권한 | 설명 |
| --- | --- | --- | --- |
| `POST` | `/api/auth/signup` | 공개 | JSON `{ username, password, nickname }` → 201 `{ member }` + 세션 쿠키. 아이디·닉네임 중복 409 |
| `POST` | `/api/auth/login` | 공개 | JSON `{ username, password }` → 200 `{ member }` + 세션 쿠키. 실패 401 |
| `POST` | `/api/auth/logout` | 공개 | 204. 서버 세션 삭제 + 쿠키 삭제 |
| `GET` | `/api/auth/me` | 공개 | `{ member }` (비로그인이면 `null`) |
| `GET` | `/api/broadcasts` | 공개 | 녹화방송 목록(최신 등록순, `owner` 포함) |
| `GET` | `/api/broadcasts/:id` | 공개 | 녹화방송 상세. 없으면 404 |
| `POST` | `/api/broadcasts` | 회원 | `multipart/form-data`: `title`, `description`, `videoFile` 또는 `videoUrl` → 201 |
| `PATCH` | `/api/broadcasts/:id` | 소유자 | JSON `{ title?, description? }` |
| `DELETE` | `/api/broadcasts/:id` | 소유자 | 204. 영상 파일·댓글도 삭제 |
| `GET` | `/media/:filename` | 공개 | 업로드된 영상 파일(Range 지원) |
| `GET` | `/api/lives` | 공개 | 라이브 방송 목록(방송 중 먼저) |
| `GET` | `/api/lives/:id` | 공개 | 라이브 방송 상세(`status`: `live`/`ended`, `owner`) |
| `POST` | `/api/lives` | 회원 | JSON `{ title }` → 201. 이미 방송 중이면 409 |
| `POST` | `/api/lives/:id/end` | 소유자 | 종료. 이미 종료면 409 |
| `PATCH` | `/api/lives/:id` | 소유자 | JSON `{ title }` |
| `DELETE` | `/api/lives/:id` | 소유자 | 204. 방송 중이면 종료 후 삭제, 댓글도 삭제 |
| `GET` | `/api/lives/rtc-config` | 공개 | 브라우저 `RTCPeerConnection` 용 ICE 서버 목록 |
| `GET` | `/api/broadcasts/:id/comments`, `/api/lives/:id/comments` | 공개 | 방송별 댓글 목록(오래된 순, `author` 포함) |
| `POST` | `/api/broadcasts/:id/comments`, `/api/lives/:id/comments` | 회원 | JSON `{ body }` → 201 |
| `PATCH` | `/api/comments/:id` | 작성자 | JSON `{ body }` |
| `DELETE` | `/api/comments/:id` | 작성자 | 204 |
| WS | `/ws/lives` | 시청자: 공개, 송출자: 소유자 | 첫 메시지 `{type:'join', role:'broadcaster'\|'viewer', liveId}` 후 `offer`/`answer`/`ice` 중계. 서버가 `viewer-joined`/`viewer-left`/`comment`/`ended` 통지 |

오류 응답은 모두 `{ "error": "한국어 메시지" }` 형식입니다. 401 = 로그인 필요, 403 = 권한 없음(소유자·작성자 아님, 다른 출처 요청), 404 = 없음, 409 = 상태 충돌.

### 제외 (이번 단계 범위 밖)

- 도네이션: 다음 단계
- 비밀번호 찾기·변경, 이메일 인증, 회원 탈퇴, 소셜 로그인
- 방송 소유자의 댓글 관리(남의 댓글 삭제) 권한, 관리자 역할
- 로그인 시도 횟수 제한·요청 속도 제한: 공개 서비스로 운영하기 전에 추가가 필요합니다
- 라이브 방송 녹화, 대규모 시청(P2P 구조라 한 방송의 동시 시청자는 약 5~10명이 현실적인 한계, [ADR 0001](docs/adr/0001-webrtc-p2p-live-broadcast.md))

## 휴대폰 연결과 권한

### 접속 환경

- **PC와 휴대폰을 같은 Wi-Fi에 연결**합니다.
- PC에서 `.env` 의 `HTTPS=true` 로 `npm start` → 출력된 `https://<PC의 IP>:3000` 을 휴대폰 브라우저(Android Chrome, iOS Safari)로 엽니다.
- 처음 접속하면 자체 서명 인증서라 **"연결이 비공개로 설정되어 있지 않습니다 / 이 연결은 비공개 연결이 아닙니다"** 경고가 뜹니다.
  - Android Chrome: `고급` → `<IP>(으)로 이동(안전하지 않음)`
  - iOS Safari: `세부사항 보기` → `이 웹 사이트 방문` → `웹 사이트 방문`
  - 인증서는 `DATA_DIR/tls/` 에 저장되어 재시작해도 같으므로 보통 한 번만 넘기면 됩니다.
- 휴대폰에서도 **로그인해야 송출할 수 있습니다**. 로그인 쿠키는 주소(호스트)마다 따로라서, PC에서 `localhost` 로 로그인했어도 휴대폰의 `https://<IP>:3000` 에서는 다시 로그인합니다.
- PC 방화벽이 포트를 막으면 접속이 안 됩니다. Windows는 첫 실행 때 뜨는 "Windows 보안 경고"에서 **개인 네트워크** 허용을 선택하세요.
- **대안(인증서 경고 없이)**: `HTTPS=false` 로 띄운 뒤 `cloudflared tunnel --url http://localhost:3000` 또는 `ngrok http 3000` 이 주는 `https://...` 주소를 휴대폰에서 엽니다.
- 시청 화면이 "영상 연결에 실패했습니다"를 띄우면 송출자와 시청자가 서로 다른 네트워크라 P2P 연결이 막힌 것입니다. 같은 Wi-Fi에서 시도하거나 `TURN_URL`/`TURN_USERNAME`/`TURN_CREDENTIAL` 을 설정하세요.

### 카메라·마이크 권한

- 송출 화면에서 `카메라·마이크 켜기` 를 누르면 브라우저가 권한을 묻습니다. **카메라와 마이크 모두 허용**합니다.
- `http://<IP>` 로 열면 브라우저가 카메라 사용 자체를 막고, 화면에 "이 주소에서는 카메라·마이크를 쓸 수 없습니다"가 표시됩니다. 반드시 `https://` 로 여세요.
- 실수로 거부했다면 다시 허용합니다.
  - Android Chrome: 주소창 왼쪽 아이콘 → `권한` → 카메라·마이크 `허용` → 새로고침
  - iOS Safari: 주소창 `가가` → `웹 사이트 설정` → 카메라·마이크 `허용`(또는 `설정` 앱 → `Safari` → `카메라`/`마이크`) → 새로고침

## 직접 확인 절차

세 사람으로 나눠 확인합니다. 로그인 쿠키는 브라우저 프로필마다 따로이므로, **브라우저 창 3개**(예: 일반 창, 시크릿 창, 다른 브라우저)를 쓰면 편합니다.

- **A = 비로그인 사용자**: 로그인하지 않은 창
- **B = 방송 소유자**: `streamer` 로 가입한 창 (휴대폰 송출도 B로 로그인)
- **C = 다른 회원**: `viewer2` 로 가입한 창

### 1. 공개 범위 확인 (A)

1. A에서 <http://localhost:3000> → 로그인 없이 방송 목록이 열립니다. 녹화방송 상세에서 영상이 재생되고, 댓글 목록이 보이며, 댓글 입력칸 대신 "로그인하면 댓글을 쓸 수 있습니다"가 표시됩니다.
2. A에서 `+ 녹화방송 등록` 이나 `● 라이브 시작` → "로그인한 회원만 할 수 있습니다" 안내가 나옵니다.

### 2. 가입·로그인·로그아웃 (B, C)

3. B에서 상단 `회원가입` → 아이디 `streamer`, 비밀번호 8자 이상, 닉네임 `방송인` → `가입하고 로그인`. 헤더에 "방송인님 · 로그아웃"이 보입니다.
4. C에서 같은 방법으로 `viewer2` / `시청자2` 로 가입합니다.
5. B에서 `로그아웃` → 헤더가 "로그인 · 회원가입"으로 바뀝니다. 다시 `로그인` → 같은 아이디·비밀번호로 로그인됩니다. 틀린 비밀번호는 "아이디 또는 비밀번호가 올바르지 않습니다"로 거절됩니다.

### 3. 녹화방송 등록·관리 권한 (A, B, C)

6. B에서 `+ 녹화방송 등록` → mp4 파일 업로드 또는 URL(예: `https://interactive-examples.mdn.mozilla.net/media/cc0-videos/flower.mp4`) → `등록하기`. 상세 화면에 "방송인" 표시와 **수정·삭제** 버튼이 보입니다.
7. B에서 `수정` → 제목 변경 → `저장` → 바뀐 제목이 표시됩니다.
8. C와 A에서 같은 방송을 열면 수정·삭제 버튼이 **보이지 않습니다**. 버튼 숨김이 아니라 서버가 막는지 확인하려면 C의 개발자 도구 콘솔에서:

   ```js
   await fetch('/api/broadcasts/1', { method: 'DELETE' }).then(r => r.status)   // C: 403, A: 401
   ```

   B에서 `삭제` → 확인 → 목록에서 사라집니다(영상 파일·댓글도 삭제).

### 4. 라이브 송출 제어 권한 (휴대폰 B, A, C)

9. PC에서 `.env` 의 `HTTPS=true` 로 `npm start`. 같은 Wi-Fi 휴대폰에서 출력된 `https://<PC의 IP>:3000` 을 열고 인증서 경고를 넘긴 뒤 **B(`streamer`)로 로그인**합니다.
10. 휴대폰에서 `● 라이브 시작` → `카메라·마이크 켜기` → 권한 허용 → 제목 입력 → `● 송출 시작`. **● 방송 중** 배지와 `시청자 0명` 이 보이면 송출이 시작된 것입니다.
11. A·C의 PC 창(`https://localhost:3000`, 인증서 경고 통과)에서 방송 목록 → **● 방송 중** 카드 → 휴대폰 카메라 영상이 재생됩니다. 휴대폰의 시청자 수가 늘어납니다.
12. C의 시청 화면에는 `■ 방송 종료`·수정·삭제가 **없습니다**. C 콘솔에서 `await fetch('/api/lives/<id>/end', { method: 'POST' }).then(r => r.status)` → **403**, A에서는 **401**. 방송은 계속됩니다.
13. B가 같은 라이브를 하나 더 시작하려 하면 "이미 방송 중인 라이브가 있습니다"로 거절됩니다.
14. 휴대폰(B)에서 `■ 송출 종료` → A·C 화면이 즉시 **종료**로 바뀌고, 목록에서도 종료 배지로 표시됩니다.

### 5. 댓글 작성·수정·삭제 권한 (A, B, C)

15. 휴대폰(B)에서 다시 송출을 시작하고 C가 시청합니다. C가 댓글 `안녕하세요!` 를 쓰면 **휴대폰 송출 화면과 다른 시청 화면에 바로** 나타납니다.
16. A(비로그인)에는 댓글 입력칸이 없습니다. A 콘솔에서 `await fetch('/api/lives/<id>/comments', { method: 'POST', headers: {'Content-Type':'application/json'}, body: '{"body":"익명"}' }).then(r => r.status)` → **401**.
17. C의 댓글에는 C에게만 `수정`·`삭제` 가 보입니다. C가 수정하면 "(수정됨)"이 붙고 모든 화면에 반영됩니다. B(방송 소유자)도 C의 댓글은 수정·삭제할 수 없습니다(콘솔에서 `PATCH /api/comments/<id>` → 403).
18. 녹화방송 상세에서도 같은 방식으로 댓글 작성(회원)과 작성자 권한을 확인합니다.

### 6. 영속 저장

19. 서버를 `Ctrl+C` 로 종료 후 다시 `npm start`. 방송·회원·댓글이 그대로 남고, 로그인 상태도 유지됩니다(세션 7일). 방송 중이던 라이브는 종료로 바뀝니다.

### 자동 테스트

`npm test` 는 임시 디렉터리에서 서버를 띄워 38개 시나리오를 확인합니다.

- 인증([test/auth.test.js](test/auth.test.js)): 가입 즉시 로그인, HttpOnly·SameSite 쿠키, scrypt 해시 저장, 입력 검증·중복 409, 로그인 실패 메시지 동일, 로그아웃 후 같은 토큰 무효, 세션 토큰 해시 저장, 만료
- 녹화방송([test/broadcasts.test.js](test/broadcasts.test.js)): 1단계 기능, 비로그인 등록 401(파일 미저장), 수정·삭제 401/403/200, 삭제 시 파일·댓글 정리, 다른 출처 요청 403, 재시작 후 유지, 이전 DB 마이그레이션·소유자 없는 방송 관리 불가
- 라이브([test/lives.test.js](test/lives.test.js)): 시작 401, 동시 방송 409, 종료·수정·삭제 401/403/200, 비로그인·다른 회원의 송출자 참여 거절, 시그널링 중계, 라이브 댓글 실시간 전달, 다른 출처 WebSocket 거절, 재시작
- 댓글([test/comments.test.js](test/comments.test.js)): 비로그인 작성 401, 작성자 연결, 공개 목록·방송별 분리, 검증, 수정·삭제 401/403(방송 소유자 포함)/200, 종료된 라이브 댓글, 재시작 후 유지

## 디렉터리 구조

```
chzzk/
├─ src/
│  ├─ server.js                 # 진입점: 설정 로드, DB 열기, HTTP/HTTPS 서버 + WebSocket 실행
│  ├─ config.js                 # 환경변수 → 설정 (HTTPS, ICE 서버 포함)
│  ├─ app.js                    # 의존성 조립, 로그인 확인 미들웨어, 라우터·정적 파일·에러 핸들러 연결
│  ├─ database.js               # SQLite 연결과 버전별 마이그레이션(PRAGMA user_version)
│  ├─ http/
│  │  ├─ errors.js              # HttpError(400/401/403/404/409), 공통 에러 응답
│  │  └─ tls.js                 # HTTPS 인증서 로드/자체 서명 생성, LAN IP
│  ├─ storage/video-storage.js  # 업로드 영상 저장·삭제·서빙(/media)
│  ├─ auth/                     # 인증·인가 (3단계)
│  │  ├─ auth.router.js         # 가입·로그인·로그아웃·me
│  │  ├─ auth.service.js        # 가입 검증, 로그인, 세션 발급·확인
│  │  ├─ member.repository.js   # members·sessions 테이블 SQL
│  │  ├─ password.js            # scrypt 해시·검증
│  │  ├─ session-cookie.js      # 세션 쿠키, req.member, 로그인 필수, 다른 출처 거절
│  │  └─ access.js              # 권한 규칙: requireMember / requireOwner / requireAuthor
│  ├─ broadcasts/               # 녹화방송 (1단계, 3단계 소유자 권한)
│  ├─ lives/                    # 라이브 방송 (2단계, 3단계 소유자 권한·실시간 댓글)
│  └─ comments/                 # 댓글 (3단계)
│     ├─ comment.router.js      # 방송별 댓글 조회·작성, 댓글 수정·삭제
│     ├─ comment.service.js     # 작성(회원)·수정·삭제(작성자) 규칙, 변경 이벤트
│     └─ comment.repository.js  # comments 테이블 SQL
├─ public/
│  ├─ index.html                # 화면 템플릿
│  ├─ app.js                    # 라우팅, 방송 목록, 녹화방송 화면
│  ├─ auth.js                   # 로그인·회원가입 화면
│  ├─ live.js                   # 라이브 송출·시청 화면(getUserMedia, WebRTC)
│  ├─ comments.js               # 댓글 영역
│  ├─ owner-tools.js            # 소유자 수정·삭제 영역
│  ├─ common.js                 # 공통 도우미, 로그인 상태
│  └─ style.css
├─ test/                        # node:test (auth, broadcasts, lives, comments)
├─ docs/adr/                    # 설계 결정 기록
├─ GLOSSARY.md                  # 도메인 용어
├─ data/                        # (실행 시 생성) replay.db, uploads/, tls/
└─ .env.example
```

요청은 `router → service → repository / storage` 한 방향으로만 흐릅니다. 권한 검사는 **서비스 안에서** `access.js` 규칙으로 하므로,
HTTP 라우터든 WebSocket이든 어느 경로로 들어와도 같은 규칙이 적용됩니다.

### 다음 단계로 확장할 때

- **새 기능**(도네이션 등): `src/<기능>/` 에 router·service·repository 를 같은 모양으로 만들고 [src/app.js](src/app.js) 에서 연결합니다. 회원은 `req.member`, 권한은 `access.js` 를 그대로 씁니다. 라이브 중 실시간 알림은 댓글처럼 서비스 이벤트를 [live.signaling.js](src/lives/live.signaling.js) 가 방에 전달하면 됩니다.
- **테이블 추가·변경**: [src/database.js](src/database.js) 의 `MIGRATIONS` 배열 끝에 SQL을 추가합니다. 이미 적용된 항목은 다시 실행되지 않으므로 기존 데이터가 유지됩니다.
