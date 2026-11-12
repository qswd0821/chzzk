# 치지직

로그인 없이 누구나 **방송**을 올리고 보는 웹 서비스입니다.

- **녹화방송** (1단계): 영상 파일을 업로드하거나 이미 저장된 영상 URL을 연결해 등록하고, 목록 → 상세 화면에서 재생합니다.
- **라이브 방송** (2단계): 휴대폰 브라우저에서 카메라·마이크로 라이브 방송을 시작·종료하고, 다른 화면에서 방송 목록 → 라이브 방송을 골라 실시간으로 시청합니다. 방송 중·종료 상태를 구분해 표시합니다.

기술 구성:

- 서버: Node.js + Express, 업로드는 multer, 라이브 시그널링은 WebSocket(`ws`)
- 저장소: Node 내장 SQLite(`node:sqlite`): 별도 DB 설치나 네이티브 빌드가 필요 없습니다
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

- `.env` 없이 `npm start` 하면 **HTTP**로 뜹니다: <http://localhost:3000>. PC 브라우저에서 녹화방송과 라이브 시청은 모두 됩니다. `localhost` 는 브라우저가 보안 출처로 취급하므로 PC 웹캠 송출도 됩니다.
- **휴대폰에서 송출**하려면 `.env` 의 `HTTPS=true` 로 실행합니다(`.env.example` 기본값). 서버가 켜질 때 휴대폰에서 열 주소를 출력합니다.

  ```
  치지직 서버 실행 중: https://localhost:3000
    같은 Wi-Fi 휴대폰에서: https://192.168.0.12:3000
  ```

개발 중에는 `npm run dev`(파일 변경 시 자동 재시작)를 쓸 수 있습니다.

테스트:

```bash
npm test
```

## 환경변수

`.env.example` 을 복사해 `.env` 로 사용합니다. `npm start` 가 `.env` 를 자동으로 읽습니다(Node `--env-file-if-exists`).

| 변수 | 기본값 | 설명 |
| --- | --- | --- |
| `PORT` | `3000` | 서버 포트 |
| `DATA_DIR` | `./data` | SQLite DB(`replay.db`), 업로드 영상(`uploads/`), 자체 서명 인증서(`tls/`)가 저장될 디렉터리. 상대 경로는 프로젝트 루트 기준 |
| `MAX_UPLOAD_MB` | `500` | 업로드 가능한 영상 파일 최대 크기(MB) |
| `HTTPS` | `false` | `true` 면 HTTPS(+WSS)로 실행. 휴대폰 카메라·마이크는 HTTPS에서만 허용됩니다 |
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

## 구현 범위

체크리스트 항목별 구현 위치:

| 체크리스트 | 서버 | 화면 |
| --- | --- | --- |
| 1단계 녹화방송 등록·목록·상세·재생 유지 | `POST/GET /api/broadcasts` — [broadcast.router.js](src/broadcasts/broadcast.router.js) → [broadcast.service.js](src/broadcasts/broadcast.service.js), 파일 저장 [video-storage.js](src/storage/video-storage.js), 영속 저장 [broadcast.repository.js](src/broadcasts/broadcast.repository.js) | 등록 `#/new` — [public/app.js](public/app.js) `renderNew`, 목록 `#/` — `renderList`, 상세·재생 `#/broadcasts/:id` — `renderDetail` |
| 휴대폰 카메라·마이크로 라이브 송출 시작·종료 | 시작 `POST /api/lives` (송출 키 발급), 종료 `POST /api/lives/:id/end` — [live.router.js](src/lives/live.router.js) → [live.service.js](src/lives/live.service.js), 영상 협상 중계 [live.signaling.js](src/lives/live.signaling.js) (`/ws/lives`) | 송출 `#/live/new` — [public/live.js](public/live.js) `renderGoLive`: `getUserMedia` → `RTCPeerConnection` 으로 시청자마다 송출, 카메라 전환, 송출 종료 |
| 라이브 방송 목록·시청 화면과 방송 상태 처리 | `GET /api/lives`(방송 중 먼저), `GET /api/lives/:id`, 상태 저장 [live.repository.js](src/lives/live.repository.js) (`live_broadcasts.status` = `live`/`ended`), 송출자 연결 끊김·미접속·서버 재시작 시 자동 종료 | 목록 `#/` — `loadLives`(● 방송 중 / 종료 배지, 10초마다 갱신), 시청 `#/lives/:id` — `renderWatchLive`(실시간 재생, 종료 알림) |
| 로그인 없이 송출·시청 + 휴대폰 연결·권한·확인 절차 | [src/app.js](src/app.js): 인증·세션 미들웨어 없음. HTTPS [src/http/tls.js](src/http/tls.js) | 아래 [휴대폰 연결과 권한](#휴대폰-연결과-권한), [직접 확인 절차](#직접-확인-절차) |
| README | 이 문서 | — |

### 녹화방송 (1단계)

- **등록 입력**: 제목(필수, 100자 이하), 설명(선택, 2000자 이하), 영상 파일 *또는* 영상 URL 중 정확히 하나.
  - 파일: `video/*` MIME만 허용, `MAX_UPLOAD_MB` 이하. `DATA_DIR/uploads/` 에 충돌 없는 이름으로 저장됩니다. 업로드 진행률이 표시됩니다.
  - URL: `http://` / `https://` 만 허용(`javascript:` 등 차단). 브라우저가 직접 재생할 수 있는 영상 파일 주소(mp4/webm 등)여야 합니다.
  - 검증에 실패하면 400과 한국어 오류 메시지를 반환하고, 이미 받은 업로드 파일은 삭제합니다.
- **영상 위치 저장**: `source_type`(`upload`|`url`)과 `video_location`(업로드 파일명 또는 외부 URL)을 함께 저장하고,
  API 응답의 `videoSrc` 로 플레이어가 바로 쓸 수 있는 주소(`/media/<파일명>` 또는 원본 URL)를 내려줍니다.
- **재생**: 업로드 영상은 `/media/` 경로에서 HTTP Range 요청을 지원하므로 탐색(seek)이 됩니다.

### 라이브 방송 (2단계)

- **송출 시작**: 송출 화면에서 `카메라·마이크 켜기` → 브라우저 권한 허용 → 제목 입력 → `● 송출 시작`.
  서버가 라이브 방송을 **방송 중**으로 만들고 이 송출 화면에만 **송출 키**를 줍니다. 송출 화면은 WebSocket으로 접속해 송출자로 참여합니다.
- **영상 전달**: 시청자가 들어오면 서버가 송출자에게 알리고, 송출자 브라우저가 그 시청자와 WebRTC 연결을 맺어 영상·음성을 직접 보냅니다.
  서버는 offer/answer/ICE 메시지만 중계합니다. 송출 중 `↻ 카메라 전환`(전면/후면)은 연결을 끊지 않고 트랙만 바꿉니다.
- **송출 종료**: `■ 송출 종료` → 송출 키를 가진 요청만 종료할 수 있습니다. 서버가 상태를 **종료**로 바꾸고 시청자에게 즉시 알립니다.
- **자동 종료**: 아래 경우에도 방송은 종료로 바뀌고, 한 번 종료된 방송은 다시 방송 중으로 돌아가지 않습니다.
  - 송출자 연결이 끊김(탭 닫기, 다른 화면으로 이동, 화면 꺼짐·네트워크 끊김은 15초 간격 heartbeat로 감지)
  - 시작만 하고 30초 안에 송출자가 접속하지 않음
  - 서버 재시작(송출 키가 메모리에만 있으므로 방송 중이던 것을 모두 종료)
- **시청**: 방송 목록의 라이브 카드(● 방송 중)를 누르면 시청 화면이 열리고 자동 재생됩니다(브라우저 자동재생 정책 때문에 음소거로 시작, `🔊 소리 켜기`).
  종료된 방송을 열면 "종료된 방송입니다"가 표시됩니다.

### API

| 메서드 | 경로 | 설명 |
| --- | --- | --- |
| `GET` | `/api/broadcasts` | 녹화방송 목록(최신 등록순) |
| `GET` | `/api/broadcasts/:id` | 녹화방송 상세. 없으면 404 |
| `POST` | `/api/broadcasts` | `multipart/form-data`: `title`, `description`, `videoFile` 또는 `videoUrl`. 성공 시 201 |
| `GET` | `/media/:filename` | 업로드된 영상 파일(Range 지원) |
| `GET` | `/api/lives` | 라이브 방송 목록(방송 중 먼저, 같은 상태끼리 최신순) |
| `GET` | `/api/lives/:id` | 라이브 방송 상세(`status`: `live` 또는 `ended`). 없으면 404 |
| `POST` | `/api/lives` | JSON `{ "title": "..." }` → 201 `{ live, streamKey }`. 송출 키는 이 응답에서만 내려갑니다 |
| `POST` | `/api/lives/:id/end` | 헤더 `X-Stream-Key` 필수. 틀리면 403, 이미 종료면 409 |
| `GET` | `/api/lives/rtc-config` | 브라우저 `RTCPeerConnection` 용 ICE 서버 목록 |
| WS | `/ws/lives` | 시그널링. 첫 메시지 `{type:'join', role:'broadcaster'\|'viewer', liveId, streamKey?}` 후 `offer`/`answer`/`ice` 중계, 서버가 `viewer-joined`/`viewer-left`/`ended` 통지 |

### 제외 (이번 단계 범위 밖)

- 인증·인가(로그인, 권한), 댓글, 도네이션: 다음 단계
- 라이브 방송 녹화(종료된 라이브를 녹화방송으로 남기기), 라이브 썸네일
- 대규모 시청: P2P 구조라 송출자 휴대폰이 시청자마다 영상을 따로 올립니다. 한 방송의 동시 시청자는 **약 5~10명**이 현실적인 한계입니다([ADR 0001](docs/adr/0001-webrtc-p2p-live-broadcast.md))
- 녹화방송 수정·삭제, 트랜스코딩/HLS 변환, 업로드·송출 남용 방지(요청 제한): 인증이 없으므로 운영 배포 전에 추가가 필요합니다

## 휴대폰 연결과 권한

### 접속 환경

- **PC와 휴대폰을 같은 Wi-Fi에 연결**합니다.
- PC에서 `.env` 의 `HTTPS=true` 로 `npm start` → 출력된 `https://<PC의 IP>:3000` 을 휴대폰 브라우저(Android Chrome, iOS Safari)로 엽니다.
- 처음 접속하면 자체 서명 인증서라 **"연결이 비공개로 설정되어 있지 않습니다 / 이 연결은 비공개 연결이 아닙니다"** 경고가 뜹니다.
  - Android Chrome: `고급` → `<IP>(으)로 이동(안전하지 않음)`
  - iOS Safari: `세부사항 보기` → `이 웹 사이트 방문` → `웹 사이트 방문`
  - 인증서는 `DATA_DIR/tls/` 에 저장되어 재시작해도 같으므로 보통 한 번만 넘기면 됩니다.
- PC 방화벽이 포트를 막으면 접속이 안 됩니다. Windows는 첫 실행 때 뜨는 "Windows 보안 경고"에서 **개인 네트워크** 허용을 선택하세요.
- **대안(인증서 경고 없이)**: `HTTPS=false` 로 띄운 뒤 `cloudflared tunnel --url http://localhost:3000` 또는 `ngrok http 3000` 이 주는 `https://...` 주소를 휴대폰에서 엽니다. 이 경우 휴대폰은 다른 네트워크(LTE)여도 페이지에 접속할 수 있습니다.
- 시청 화면이 "영상 연결에 실패했습니다"를 띄우면 송출자와 시청자가 서로 다른 네트워크라 P2P 연결이 막힌 것입니다. 같은 Wi-Fi에서 시도하거나 `TURN_URL`/`TURN_USERNAME`/`TURN_CREDENTIAL` 을 설정하세요.

### 카메라·마이크 권한

- 송출 화면에서 `카메라·마이크 켜기` 를 누르면 브라우저가 권한을 묻습니다. **카메라와 마이크 모두 허용**합니다.
- `http://<IP>` 로 열면 브라우저가 카메라 사용 자체를 막고, 화면에 "이 주소에서는 카메라·마이크를 쓸 수 없습니다"가 표시됩니다. 반드시 `https://` 로 여세요.
- 실수로 거부했다면 화면에 안내가 표시됩니다. 다시 허용하는 방법:
  - Android Chrome: 주소창 왼쪽 아이콘 → `권한` → 카메라·마이크 `허용` → 새로고침
  - iOS Safari: 주소창 `가가` → `웹 사이트 설정` → 카메라·마이크 `허용`(또는 `설정` 앱 → `Safari` → `카메라`/`마이크`) → 새로고침
- 다른 앱(카메라 앱, 영상통화)이 카메라를 쓰고 있으면 켜지지 않습니다. 그 앱을 닫고 다시 시도하세요.

## 직접 확인 절차

### 녹화방송 (1단계 기능 유지)

1. **로그인 없이 접근**: <http://localhost:3000> 이 로그인 화면 없이 바로 "방송 목록"으로 열립니다. 위쪽은 라이브 방송, 아래쪽은 녹화방송입니다.
2. **파일 업로드 등록**: 상단 `+ 녹화방송 등록` → 제목 입력 → `파일 업로드` → mp4 파일 선택 → `등록하기`. 진행률 바가 찬 뒤 상세 화면에서 영상이 재생되고 탐색 막대로 구간 이동이 됩니다.
3. **URL 연결 등록**: `+ 녹화방송 등록` → `영상 URL 연결` → 공개 mp4 주소(예: `https://interactive-examples.mdn.mozilla.net/media/cc0-videos/flower.mp4`) → `등록하기`. 상세 화면에서 재생됩니다.
4. **목록·검증**: 방송 목록의 녹화방송 칸에 두 방송이 최신순으로 보입니다. 제목 없이 등록하거나 URL에 `ftp://x` 를 넣으면 오류가 표시되고 등록되지 않습니다.

### 라이브 방송 (휴대폰 송출 → 다른 화면 시청)

5. **서버 실행**: PC에서 `.env` 의 `HTTPS=true` 로 `npm start`. 출력된 `https://<PC의 IP>:3000` 을 확인합니다.
6. **휴대폰 접속**: 같은 Wi-Fi의 휴대폰에서 그 주소를 열고 인증서 경고를 넘깁니다([접속 환경](#접속-환경)).
7. **송출 시작 확인**: 휴대폰에서 상단 `● 라이브 시작` → `카메라·마이크 켜기` → 권한 허용 → 미리보기에 내 카메라 영상이 보이는지 확인 → 제목 입력 → `● 송출 시작`.
   미리보기 위에 **● 방송 중** 배지와 `시청자 0명` 이 표시되면 송출이 시작된 것입니다. `↻ 카메라 전환` 으로 후면 카메라로 바꿀 수 있습니다.
8. **다른 화면에서 시청**: PC 브라우저(또는 다른 휴대폰)에서 `https://localhost:3000`(또는 같은 IP 주소)을 열고 방송 목록의 라이브 방송 칸을 봅니다.
   방금 시작한 방송이 **● 방송 중** 배지로 맨 앞에 있습니다. 카드를 누르면 휴대폰 카메라 영상이 1초 안팎의 지연으로 재생됩니다. `🔊 소리 켜기` 로 소리를 켭니다.
   휴대폰 송출 화면의 시청자 수가 `시청자 1명` 으로 바뀝니다.
9. **송출 종료 확인**: 휴대폰에서 `■ 송출 종료`. 휴대폰 화면에 "송출을 종료했습니다", 시청 화면에 즉시 **종료** 배지와 "방송이 종료되었습니다"가 표시됩니다.
   방송 목록에서 그 방송이 **종료** 배지(흐리게)로 바뀌고, 다시 열면 "종료된 방송입니다"가 보입니다.
10. **비정상 종료 확인**(선택): 다시 송출을 시작한 뒤 휴대폰 탭을 닫거나 화면을 끕니다. 탭 닫기는 즉시, 화면 꺼짐·네트워크 끊김은 최대 30초 안에 시청 화면과 목록이 **종료**로 바뀝니다.
11. **영속 저장 확인**: 서버를 `Ctrl+C` 로 종료 후 다시 `npm start`. 녹화방송과 라이브 방송 목록(모두 종료 상태)이 그대로 남아 있습니다. 저장 위치는 `data/replay.db` 입니다.

### API 직접 호출(선택)

```bash
curl http://localhost:3000/api/lives
```

```bash
curl -X POST -H "Content-Type: application/json" -d "{\"title\":\"curl 라이브\"}" http://localhost:3000/api/lives
```

```bash
curl -X POST -H "X-Stream-Key: <위 응답의 streamKey>" http://localhost:3000/api/lives/1/end
```

자동 테스트(`npm test`)는 임시 디렉터리에서 서버를 띄워 다음을 확인합니다.
- 녹화방송: 업로드·URL 등록, 목록·상세, 입력 검증과 실패 시 파일 정리, Range 응답, 재시작 후 유지, 이전 스키마 DB 마이그레이션
- 라이브: 시작·송출 키 검증·종료·409, 목록 정렬, ICE 설정, 미접속 자동 종료, WebSocket 시그널링(offer/answer/ice 중계, 송출자 끊김 시 종료 통지, 종료된 방송 입장), 재시작 시 방송 중 → 종료

## 디렉터리 구조

```
chzzk/
├─ src/
│  ├─ server.js                 # 진입점: 설정 로드, DB 열기, HTTP/HTTPS 서버 + 시그널링 실행
│  ├─ config.js                 # 환경변수 → 설정 (HTTPS, ICE 서버 포함)
│  ├─ app.js                    # 의존성 조립, 라우터·정적 파일·에러 핸들러·시그널링 연결
│  ├─ database.js               # SQLite 연결과 버전별 마이그레이션(PRAGMA user_version)
│  ├─ http/
│  │  ├─ errors.js              # HttpError, 공통 에러 응답
│  │  └─ tls.js                 # HTTPS 인증서 로드/자체 서명 생성, LAN IP
│  ├─ storage/video-storage.js  # 업로드 영상 저장·삭제·서빙(/media)
│  ├─ broadcasts/               # 녹화방송 모듈 (1단계)
│  │  ├─ broadcast.router.js
│  │  ├─ broadcast.service.js
│  │  └─ broadcast.repository.js
│  └─ lives/                    # 라이브 방송 모듈 (2단계)
│     ├─ live.router.js         # HTTP: 시작·종료·조회·ICE 설정
│     ├─ live.service.js        # 방송 상태 전이, 송출 키, 자동 종료 규칙
│     ├─ live.repository.js     # live_broadcasts 테이블 SQL
│     └─ live.signaling.js      # WebSocket 시그널링(/ws/lives)
├─ public/
│  ├─ index.html                # 화면 템플릿(목록·녹화방송·송출·시청)
│  ├─ app.js                    # 라우팅, 방송 목록, 녹화방송 화면
│  ├─ live.js                   # 라이브 송출·시청 화면(getUserMedia, WebRTC)
│  ├─ common.js                 # 공통 도우미
│  └─ style.css
├─ test/                        # node:test (broadcasts.test.js, lives.test.js)
├─ docs/adr/                    # 설계 결정 기록
├─ GLOSSARY.md                  # 도메인 용어
├─ data/                        # (실행 시 생성) replay.db, uploads/, tls/
└─ .env.example
```

요청은 `router → service → repository / storage` 한 방향으로만 흐릅니다. 서비스는 HTTP·WebSocket·SQL을 모르고,
라우터와 시그널링은 상태 규칙을 모릅니다.

### 다음 단계로 확장할 때

각 단계는 앞 단계의 녹화방송·라이브 방송 기능을 유지한 채 확장합니다.

- **새 기능**(댓글, 도네이션 등): `src/<기능>/` 에 router·service·repository 를 같은 모양으로 만들고 [src/app.js](src/app.js) 에서 라우터를 연결합니다. 라이브 중 실시간 댓글은 `/ws/lives` 와 같은 방식의 WebSocket을 하나 더 두거나 시그널링 방에 메시지 종류를 추가할 수 있습니다.
- **테이블 추가·변경**: [src/database.js](src/database.js) 의 `MIGRATIONS` 배열 끝에 SQL을 추가합니다. 이미 적용된 항목은 다시 실행되지 않으므로 기존 데이터가 유지됩니다.
- **인증·인가**: 인증 미들웨어를 `app.js` 에서 필요한 라우터 앞에만 끼웁니다. 그때 송출 키 대신 "송출자 = 로그인한 사용자" 확인으로 바꿀 수 있습니다.
