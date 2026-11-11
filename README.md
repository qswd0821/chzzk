# Replay VOD

로그인 없이 **녹화방송을 등록하고 시청**하는 웹 서비스입니다.
영상 파일을 직접 업로드하거나, 이미 어딘가에 저장된 영상의 URL을 연결해 방송을 등록하고,
목록 → 상세 화면에서 바로 재생할 수 있습니다.

- 서버: Node.js + Express, 업로드는 multer
- 저장소: Node 내장 SQLite(`node:sqlite`) — 별도 DB 설치나 네이티브 빌드가 필요 없습니다
- 화면: 빌드 단계 없는 정적 HTML/CSS/JS(해시 라우팅 SPA), HTML5 `<video>` 플레이어

## 실행 방법

요구 사항: **Node.js 22.13 이상** (`node:sqlite` 기본 사용 가능 버전, 24 LTS 권장)

```bash
git clone https://github.com/qswd0821/chzzk.git
cd chzzk
npm install
cp .env.example .env   # 선택 사항: 없으면 기본값으로 실행됩니다
npm start
```

브라우저에서 <http://localhost:3000> 을 엽니다. 개발 중에는 `npm run dev`(파일 변경 시 자동 재시작)를 쓸 수 있습니다.

테스트:

```bash
npm test
```

## 환경변수

`.env.example` 을 복사해 `.env` 로 사용합니다. `npm start` 가 `.env` 를 자동으로 읽습니다(Node `--env-file-if-exists`).

| 변수 | 기본값 | 설명 |
| --- | --- | --- |
| `PORT` | `3000` | 서버 포트 |
| `DATA_DIR` | `./data` | SQLite DB(`replay.db`)와 업로드 영상(`uploads/`)이 저장될 디렉터리. 상대 경로는 프로젝트 루트 기준 |
| `MAX_UPLOAD_MB` | `500` | 업로드 가능한 영상 파일 최대 크기(MB) |

```dotenv
PORT=3000
DATA_DIR=./data
MAX_UPLOAD_MB=500
```

## 구현 범위

### 포함

체크리스트 항목별 구현 위치:

| 체크리스트 | 서버 | 화면 |
| --- | --- | --- |
| 녹화 영상의 제목과 파일 또는 영상 위치를 등록 | `POST /api/broadcasts` — [broadcast.router.js](src/broadcasts/broadcast.router.js) → [broadcast.service.js](src/broadcasts/broadcast.service.js) `register`, 파일 저장은 [video-storage.js](src/storage/video-storage.js) | 등록 화면 `#/new` — [public/app.js](public/app.js) `renderNew`, 폼은 [public/index.html](public/index.html) `tpl-new` |
| 녹화방송 목록과 상세 화면 및 영상 플레이어 | `GET /api/broadcasts`, `GET /api/broadcasts/:id` — `service.list` / `service.get`, 영상 파일 `GET /media/:file` | 목록 `#/` — `renderList`, 상세 `#/broadcasts/:id` — `renderDetail` + `<video controls>` (`tpl-detail`) |
| 방송 메타데이터를 영속 저장하고 조회 | SQLite 스키마·마이그레이션 [src/database.js](src/database.js), 저장·조회 [broadcast.repository.js](src/broadcasts/broadcast.repository.js) | — |
| 로그인 없이 등록·조회 화면과 서버 기능 이용 | [src/app.js](src/app.js) — 인증·세션 미들웨어 없이 라우터와 정적 화면을 바로 연결 | 로그인 화면·토큰 처리 없음 |
| README | 이 문서: 실행 방법, 환경변수, 구현 범위, 직접 확인 절차 | — |

세부 동작:

- **등록 입력**: 제목(필수, 100자 이하), 설명(선택, 2000자 이하), 영상 파일 *또는* 영상 URL 중 정확히 하나.
  - 파일: `video/*` MIME만 허용, `MAX_UPLOAD_MB` 이하. `DATA_DIR/uploads/` 에 충돌 없는 이름으로 저장됩니다. 업로드 진행률이 표시됩니다.
  - URL: `http://` / `https://` 만 허용(`javascript:` 등 차단). 브라우저가 직접 재생할 수 있는 영상 파일 주소(mp4/webm 등)여야 합니다.
  - 검증에 실패하면 400과 한국어 오류 메시지를 반환하고, 이미 받은 업로드 파일은 삭제합니다.
- **영상 위치 저장**: `source_type`(`upload`|`url`)과 `video_location`(업로드 파일명 또는 외부 URL)을 함께 저장하고,
  API 응답의 `videoSrc` 로 플레이어가 바로 쓸 수 있는 주소(`/media/<파일명>` 또는 원본 URL)를 내려줍니다.
- **재생**: 업로드 영상은 `/media/` 경로에서 HTTP Range 요청을 지원하므로 탐색(seek)이 됩니다.
  재생할 수 없는 영상이면 플레이어 아래에 안내 문구를 띄웁니다.

### API

| 메서드 | 경로 | 설명 |
| --- | --- | --- |
| `GET` | `/api/broadcasts` | 방송 목록(최신 등록순) |
| `GET` | `/api/broadcasts/:id` | 방송 상세. 없으면 404 |
| `POST` | `/api/broadcasts` | `multipart/form-data`: `title`, `description`, `videoFile` 또는 `videoUrl`. 성공 시 201 |
| `GET` | `/media/:filename` | 업로드된 영상 파일(Range 지원) |

응답 예시:

```json
{
  "id": 1,
  "title": "11월 4일 정기 방송",
  "description": "",
  "sourceType": "upload",
  "videoLocation": "1762230000000-3f2c...e1.mp4",
  "videoSrc": "/media/1762230000000-3f2c...e1.mp4",
  "mimeType": "video/mp4",
  "fileSize": 22548213,
  "createdAt": "2026-11-04T05:20:00.000Z"
}
```

### 제외 (이번 단계 범위 밖)

- 인증·인가(로그인, 권한), 라이브 송출, 댓글, 도네이션
- 방송 수정·삭제, 썸네일 자동 생성, 트랜스코딩/HLS 변환, 외부 URL 영상의 유효성 사전 검사
- 공개 서비스 운영에 필요한 업로드 남용 방지(요청 제한, 용량 쿼터) — 인증이 없으므로 운영 배포 전에 추가가 필요합니다

## 직접 확인 절차

`npm start` 로 서버를 띄운 뒤 아래 순서대로 확인합니다.

1. **로그인 없이 접근** — <http://localhost:3000> 이 로그인 화면 없이 바로 "녹화방송 목록"으로 열립니다. 처음에는 "아직 등록된 방송이 없습니다"가 보입니다.
2. **파일 업로드 등록** — 상단 `+ 방송 등록` → 제목 입력 → `파일 업로드` 선택 → mp4 파일 선택 → `등록하기`.
   진행률 바가 차오른 뒤 상세 화면으로 이동하고, 플레이어에서 영상이 재생되며 탐색 막대로 구간 이동이 됩니다.
3. **URL 연결 등록** — 다시 `+ 방송 등록` → 제목 입력 → `영상 URL 연결` 선택 → 공개 mp4 주소 입력
   (예: `https://interactive-examples.mdn.mozilla.net/media/cc0-videos/flower.mp4`) → `등록하기`. 상세 화면에서 재생됩니다.
4. **목록 확인** — `방송 목록` 으로 이동하면 방금 등록한 두 방송이 최신순으로 보이고, 카드에 `업로드` / `URL` 배지가 표시됩니다. 카드를 누르면 상세 화면으로 이동합니다.
5. **입력 검증** — 등록 화면에서 제목 없이 등록하거나, 영상을 비워 두거나, URL에 `ftp://x` 를 넣으면 오류 메시지가 표시되고 등록되지 않습니다.
6. **영속 저장** — 터미널에서 서버를 `Ctrl+C` 로 종료한 뒤 `npm start` 로 다시 실행합니다. 목록과 상세 화면, 업로드 영상 재생이 그대로 유지됩니다.
   저장 위치는 `data/replay.db`(메타데이터)와 `data/uploads/`(영상 파일)입니다.
7. **API 직접 호출**(선택):

   ```bash
   curl http://localhost:3000/api/broadcasts
   ```

   ```bash
   curl -F "title=curl 업로드" -F "videoFile=@sample.mp4;type=video/mp4" http://localhost:3000/api/broadcasts
   ```

   ```bash
   curl -F "title=curl URL" -F "videoUrl=https://interactive-examples.mdn.mozilla.net/media/cc0-videos/flower.mp4" http://localhost:3000/api/broadcasts
   ```

자동 테스트(`npm test`)는 임시 디렉터리에서 서버를 띄워 업로드·URL 등록, 목록·상세 조회, 입력 검증과 실패 시 파일 정리,
업로드 영상의 Range 응답, 서버 재시작 후 데이터 유지, 이전 스키마 DB의 마이그레이션, 비로그인 접근을 확인합니다.

## 디렉터리 구조

```
chzzk/
├─ src/
│  ├─ server.js                 # 진입점: 설정 로드, DB 열기, 서버 실행
│  ├─ config.js                 # 환경변수 → 설정
│  ├─ app.js                    # 의존성 조립, 라우터·정적 파일·에러 핸들러 연결
│  ├─ database.js               # SQLite 연결과 버전별 마이그레이션(PRAGMA user_version)
│  ├─ http/errors.js            # HttpError, 공통 에러 응답
│  ├─ storage/video-storage.js  # 업로드 영상 저장·삭제·서빙(/media)
│  └─ broadcasts/               # 녹화방송 모듈
│     ├─ broadcast.router.js     # HTTP ↔ 서비스 (요청 파싱, 상태 코드)
│     ├─ broadcast.service.js    # 등록 검증, 영상 위치 종류, 재생 주소(videoSrc) 계산
│     └─ broadcast.repository.js # broadcasts 테이블 SQL
├─ public/                      # 목록·상세·등록 화면 (index.html, app.js, style.css)
├─ test/                        # node:test API 테스트
├─ data/                        # (실행 시 생성) replay.db, uploads/
└─ .env.example
```

요청은 `router → service → repository / storage` 한 방향으로만 흐릅니다. 서비스는 HTTP와 SQL을 모르고,
라우터는 검증 규칙을 모릅니다.

### 다음 단계로 확장할 때

각 단계는 이 단계의 녹화방송 기능을 유지한 채 확장합니다.

- **새 기능**(댓글, 도네이션 등): `src/<기능>/` 에 router·service·repository 를 같은 모양으로 만들고 [src/app.js](src/app.js) 에서 라우터를 하나 더 연결합니다.
- **테이블 추가·변경**: [src/database.js](src/database.js) 의 `MIGRATIONS` 배열 끝에 SQL을 추가합니다. 이미 적용된 항목은 다시 실행되지 않으므로 기존 방송 데이터가 유지됩니다.
- **인증·인가**: 인증 미들웨어를 `app.js` 에서 필요한 라우터 앞에만 끼웁니다. 녹화방송 조회처럼 공개로 둘 경로는 그대로 둘 수 있습니다.
