# 치지직

누구나 **방송**을 보고, **회원**은 방송을 올리고 댓글을 달고 방송 소유자에게 **후원**하는 웹 서비스입니다.

- **녹화방송** (1단계): 영상 파일을 업로드하거나 이미 저장된 영상 URL을 연결해 등록하고, 목록 → 상세 화면에서 재생합니다.
- **라이브 방송** (2단계): 휴대폰 브라우저에서 카메라·마이크로 라이브 방송을 시작·종료하고, 다른 화면에서 방송 목록 → 라이브 방송을 골라 실시간으로 시청합니다. 방송 중·종료 상태를 구분해 표시합니다.
- **인증·인가와 댓글** (3단계): 회원가입·로그인·로그아웃, 방송 소유자만 할 수 있는 수정·삭제·송출 제어, 녹화방송과 라이브 방송의 댓글(라이브는 실시간), 작성자만 할 수 있는 댓글 수정·삭제. **모든 권한은 서버가 검사합니다.**
- **후원** (4단계): 로그인한 회원이 방송을 보며 그 방송의 소유자에게 금액을 정해 후원합니다. **토스페이먼츠 테스트 모드**(키가 없으면 내장 모의 결제 서비스)로 결제하고, **서버가 결제 승인과 금액·받는 소유자를 확인한 뒤에만** 확정합니다. 같은 승인 통지가 반복돼도 한 번만 적립되며, 방송별 후원 내역과 합계를 보여줍니다(라이브는 실시간 알림).
- **로컬 오토스케일** (5단계): 서버를 컨테이너 이미지로 만들어 로컬 Kubernetes(k3d = Docker 안의 k3s)에서 **여러 인스턴스**로 띄우고, **HPA가 CPU 사용률에 따라 2~5개 사이에서 자동으로 늘리고 줄입니다.** Traefik 인그레스 → Service 가 요청을 나누고, 상태는 인스턴스 밖(공유 볼륨의 SQLite·업로드, Redis)에 두어 인스턴스가 바뀌어도 로그인·방송·라이브·댓글·후원이 그대로입니다. k6 부하 Job 과 [실측 결과](#실측-결과-2026-11-22)를 함께 둡니다.

기술 구성:

- 서버: Node.js + Express, 업로드는 multer, 라이브 시그널링·실시간 댓글은 WebSocket(`ws`)
- 저장소: Node 내장 SQLite(`node:sqlite`): 별도 DB 설치나 네이티브 빌드가 필요 없습니다
- 인증: 서버 세션 + `HttpOnly; SameSite=Lax` 쿠키, 비밀번호는 Node 내장 `scrypt` 해시
- 결제: 토스페이먼츠 결제창(v2 SDK, API 개별 연동 테스트 키) + 승인 API·조회 API·웹훅. 키가 없으면 같은 흐름을 흉내 내는 내장 모의 결제 서비스 ([ADR 0002](docs/adr/0002-payment-provider-port-with-mock.md))
- 화면: 빌드 단계 없는 정적 HTML/CSS/JS(해시 라우팅 SPA)
- 라이브 송출: 브라우저 `getUserMedia`(카메라·마이크) + **WebRTC P2P**. 서버는 연결 협상 메시지만 중계합니다 ([ADR 0001](docs/adr/0001-webrtc-p2p-live-broadcast.md))
- 여러 인스턴스(5단계): Docker 이미지([Dockerfile](Dockerfile)), k3d/k3s + HPA(autoscaling/v2) + Traefik 인그레스 + Service([k8s/](k8s/)), 공유 볼륨(PVC)의 SQLite·업로드, Redis pub/sub·TTL 키([ADR 0003](docs/adr/0003-shared-sqlite-volume-and-redis-bus.md)), 부하 생성 k6([k8s/load/](k8s/load/))
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

- 이전 단계에서 쓰던 `data/replay.db` 가 있으면 시작할 때 자동으로 스키마가 올라갑니다(마이그레이션 3: 회원·댓글, 4: 후원). 기존 방송은 그대로 남고 **소유자 없음**으로 표시됩니다.
- **후원 결제**: `.env` 에 토스 테스트 키가 없으면 내장 **모의 결제 서비스**로 동작하므로 바로 후원 흐름을 확인할 수 있습니다. 토스 테스트 결제창으로 확인하려면 [토스 테스트 모드로 실행](#토스-테스트-모드로-실행)을 보세요.

개발 중에는 `npm run dev`(파일 변경 시 자동 재시작)를 쓸 수 있습니다.

### 여러 인스턴스 + 오토스케일로 실행 (5단계, 로컬 Kubernetes)

요구 사항: **Docker Desktop**(실행 중), **kubectl**, **k3d** v5 (`winget install k3d.k3d` / `brew install k3d`). 클라우드는 필요 없습니다.

```bash
scripts/k3d.sh up        # k3d 클러스터 생성 (노드 1개, 호스트 8080 → 인그레스)
```

```bash
scripts/k3d.sh deploy    # docker build → k3d image import → kubectl apply -k k8s → 롤아웃 대기
```

브라우저에서 <http://localhost:8080> 을 엽니다(1~4단계 기능이 그대로 동작). 파드 2개로 시작합니다.

```bash
scripts/k3d.sh status    # HPA, 파드, kubectl top pods
```

```bash
scripts/k3d.sh load      # k6 부하 Job 시작 (50 VU, 30초 증가 → 2분 유지 → 20초 감소)
```

```bash
kubectl -n chzzk get hpa chzzk -w    # 또는 scripts/k3d.sh watch
```

```bash
scripts/k3d.sh down      # 정리
```

PowerShell 에서는 스크립트 대신 같은 명령을 직접 실행합니다.

```powershell
k3d cluster create --config k8s/k3d-cluster.yaml
docker build -t chzzk:local .
k3d image import chzzk:local -c chzzk
kubectl apply -k k8s
kubectl -n chzzk rollout status deployment/chzzk
kubectl apply -k k8s/load            # 부하 (다시 돌릴 땐 먼저: kubectl -n chzzk delete job chzzk-load)
kubectl -n chzzk get hpa chzzk -w
```

PC 에서 직접 부하를 걸 수도 있습니다(인그레스 경유): `docker run --rm -i -e BASE_URL=http://host.docker.internal:8080 grafana/k6 run - < k8s/load/k6-chzzk.js`

클러스터에서는 인그레스를 HTTP 로만 엽니다. 휴대폰 송출(카메라는 HTTPS 필요)은 `cloudflared tunnel --url http://localhost:8080` 또는 `ngrok http 8080` 이 주는 `https://…` 주소로 접속합니다. 단일 인스턴스 HTTPS 모드(`npm start` + `HTTPS=true`)는 그대로 쓸 수 있습니다.

테스트:

```bash
npm test
```

## 환경변수

`.env.example` 을 복사해 `.env` 로 사용합니다. `npm start` 가 `.env` 를 자동으로 읽습니다(Node `--env-file-if-exists`).
세션 토큰은 서버가 로그인할 때마다 무작위로 만들고, DB에는 해시만 저장합니다. 비밀 값은 토스 **테스트** 시크릿 키뿐이며 `.env`(커밋되지 않음)에만 넣습니다.

| 변수 | 기본값 | 설명 |
| --- | --- | --- |
| `PORT` | `3000` | 서버 포트 |
| `DATA_DIR` | `./data` | SQLite DB(`replay.db`: 방송·회원·세션·댓글), 업로드 영상(`uploads/`), 자체 서명 인증서(`tls/`)가 저장될 디렉터리. 상대 경로는 프로젝트 루트 기준 |
| `MAX_UPLOAD_MB` | `500` | 업로드 가능한 영상 파일 최대 크기(MB) |
| `HTTPS` | `false` | `true` 면 HTTPS(+WSS)로 실행. 휴대폰 카메라·마이크는 HTTPS에서만 허용됩니다. HTTPS면 세션 쿠키에 `Secure` 가 붙습니다 |
| `HTTPS_KEY`, `HTTPS_CERT` | (비움) | 가진 인증서 파일 경로(PEM). 비워 두면 자체 서명 인증서를 자동 생성해 `DATA_DIR/tls/` 에 보관하고 재사용합니다 |
| `STUN_URLS` | `stun:stun.l.google.com:19302` | WebRTC STUN 서버. 쉼표로 여러 개 |
| `TURN_URL`, `TURN_USERNAME`, `TURN_CREDENTIAL` | (비움) | 휴대폰 LTE ↔ PC Wi-Fi 처럼 서로 다른 네트워크에서 연결이 안 될 때 쓰는 TURN 서버 |
| `PAYMENT_PROVIDER` | `auto` | 후원 결제 서비스. `auto` = 토스 테스트 키가 둘 다 있으면 `toss`, 없으면 `mock`(내장 모의 결제). `toss` 로 고정하면 키가 없을 때 서버가 시작하지 않습니다 |
| `TOSS_CLIENT_KEY` | (비움) | 토스페이먼츠 **API 개별 연동** 테스트 클라이언트 키(`test_ck_…`). 브라우저 결제창에 쓰는 공개 키 |
| `REDIS_URL` | (비움) | 여러 인스턴스용 Redis(예: `redis://redis:6379`). 비우면 단일 인스턴스용 메모리 버스 |
| `INSTANCE_ID` | 호스트 이름 | 응답 헤더 `X-Instance`·`/healthz` 에 표시할 인스턴스 이름. k8s 에서는 파드 이름 |
| `LIVE_RECONNECT_GRACE_SECONDS` | `20` | 송출자 연결이 끊긴 뒤 라이브를 종료하기까지 기다리는 시간(재접속 유예) |
| `TOSS_SECRET_KEY` | (비움) | 토스페이먼츠 테스트 시크릿 키(`test_sk_…`). 서버에서 승인·조회 API 호출에만 쓰며 브라우저로 보내지 않습니다. `live_` 키는 서버가 거부합니다 |

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
PAYMENT_PROVIDER=auto
# 예시 형식입니다. 토스 개발자센터에서 받은 본인의 테스트 키를 넣으세요(커밋 금지).
TOSS_CLIENT_KEY=test_ck_xxxxxxxxxxxxxxxxxxxxxxxx
TOSS_SECRET_KEY=test_sk_xxxxxxxxxxxxxxxxxxxxxxxx
# 여러 인스턴스(k8s/app.yaml 에서 설정하는 값)
REDIS_URL=redis://redis:6379
INSTANCE_ID=
LIVE_RECONNECT_GRACE_SECONDS=20
```

k8s 에서는 위 값을 [k8s/app.yaml](k8s/app.yaml) 의 `env` 로 주고, 토스 테스트 키는 Secret 으로 넣습니다(선택): `kubectl -n chzzk create secret generic chzzk-secrets --from-literal=TOSS_CLIENT_KEY=test_ck_… --from-literal=TOSS_SECRET_KEY=test_sk_…`

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
| 방송별 후원 내역·합계 (확정된 후원만) | ✅ 공개 | ✅ | ✅ |
| 후원하기(후원 주문 생성) | ❌ 401 | ✅ (소유자 없는 방송은 400) | ❌ 403 (자기 방송) |
| 후원 주문 확정·실패 기록 | ❌ 401 | ❌ 403 (남의 주문) | ✅ 그 주문의 후원자 |

- **시청을 공개로 둔 이유**: 방송은 많은 사람이 보는 것이 목적이고, 1·2단계부터 누구나 볼 수 있었습니다. 대신 서비스에 무언가를 남기는 행위(등록·송출·댓글)는 누가 했는지 알아야 하므로 로그인을 요구합니다.
- **소유자 없음**: 회원 제도 이전(1·2단계)에 만든 방송은 소유자가 없습니다. 시청과 댓글은 되지만 **누구도 수정·삭제할 수 없습니다**(403).
- 한 회원은 동시에 하나의 라이브만 **방송 중**일 수 있습니다(두 번째 시작은 409).
- 다른 회원의 라이브에 송출자로 참여하려 하면 WebSocket이 "방송 소유자만 송출할 수 있습니다"로 거절됩니다. 시청자 참여는 비로그인도 됩니다.
- **후원 내역을 공개로 둔 이유**: 방송 화면에서 누가 얼마를 후원했는지 함께 보는 것이 후원의 일부이기 때문입니다. 확정된 후원만 보이고, 결제 대기·실패·취소·만료 주문과 결제키는 공개 응답에 나오지 않습니다.

### 보안 처리

- **비밀번호**: 회원마다 다른 salt + `scrypt` 해시로 저장하고 timing-safe 비교. 없는 아이디로 로그인해도 같은 시간·같은 메시지("아이디 또는 비밀번호가 올바르지 않습니다")로 응답합니다.
- **세션**: 로그인하면 32바이트 무작위 토큰을 `HttpOnly`(스크립트에서 읽을 수 없음), `SameSite=Lax` 쿠키로 줍니다. DB에는 토큰의 SHA-256 해시만 저장하며 7일 후 만료됩니다. 로그아웃하면 서버의 세션을 지우므로 같은 토큰은 즉시 무효가 됩니다.
- **CSRF**: `SameSite=Lax` 에 더해, 상태를 바꾸는 API 요청과 WebSocket 연결에 다른 출처의 `Origin` 이 붙어 있으면 거절합니다(403).
- **업로드**: 비로그인 요청은 업로드 파일을 디스크에 쓰기 전에 401로 거절합니다.
- **화면 출력**: 사용자 입력(제목·댓글·닉네임·후원 메시지)은 모두 `textContent` 로 넣어 HTML로 해석되지 않습니다.
- **결제**: 토스 시크릿 키는 서버에만 있고, 브라우저에는 클라이언트 키만 내려갑니다. `live_` 키는 설정 단계에서 거부합니다. 모의 결제 서비스(`/mock-pg`, `/mock-pay.html`)는 토스 모드에서는 404 로 닫힙니다.

## 구현 범위

체크리스트 항목별 구현 위치:

| 체크리스트 | 서버 | 화면 |
| --- | --- | --- |
| 녹화방송과 휴대폰 라이브 송출·시청 유지 (1·2단계) | 녹화방송 [src/broadcasts/](src/broadcasts/), 라이브 [src/lives/](src/lives/) (WebRTC 시그널링 [live.signaling.js](src/lives/live.signaling.js)) | [public/app.js](public/app.js) 목록·등록·상세, [public/live.js](public/live.js) 송출·시청 |
| 회원가입·로그인·로그아웃과 인증 상태 관리 | `POST /api/auth/signup`·`/login`·`/logout`, `GET /api/auth/me` — [auth.router.js](src/auth/auth.router.js) → [auth.service.js](src/auth/auth.service.js), 비밀번호 [password.js](src/auth/password.js), 세션 저장 [member.repository.js](src/auth/member.repository.js), 쿠키·`req.member` [session-cookie.js](src/auth/session-cookie.js) | 로그인·가입 `#/login`·`#/signup` — [public/auth.js](public/auth.js), 헤더 로그인 상태 [public/common.js](public/common.js) `refreshSession`/`renderAuthArea` |
| 서버에서 소유자·인증 상태를 검사해 방송 관리·송출 제어 제한 | 권한 규칙 [src/auth/access.js](src/auth/access.js) (`requireMember`/`requireOwner`), 적용: [broadcast.service.js](src/broadcasts/broadcast.service.js) `register`/`update`/`remove`, [live.service.js](src/lives/live.service.js) `start`/`end`/`rename`/`remove`/`canBroadcast`, 송출자 WebSocket 참여 [live.signaling.js](src/lives/live.signaling.js) `join` | 소유자에게만 수정·삭제·종료 버튼 [public/owner-tools.js](public/owner-tools.js) (편의용, 실제 검사는 서버) |
| 방송별 댓글 저장·조회와 로그인 작성자 연결 | `GET/POST /api/broadcasts/:id/comments`, `GET/POST /api/lives/:id/comments` — [comment.router.js](src/comments/comment.router.js) → [comment.service.js](src/comments/comment.service.js) → [comment.repository.js](src/comments/comment.repository.js) (`comments.author_id`), 라이브 댓글 실시간 전달 [live.signaling.js](src/lives/live.signaling.js) | 댓글 영역 [public/comments.js](public/comments.js) (녹화방송 상세, 라이브 시청·송출 화면) |
| 서버에서 비로그인 댓글 작성 거절, 작성자만 수정·삭제 | [comment.service.js](src/comments/comment.service.js) `create`(`requireMember` → 401), `update`/`remove`(`requireAuthor` → 401/403), `PATCH/DELETE /api/comments/:id` | 작성자에게만 수정·삭제 버튼 |
| **3단계 인증·인가·댓글 유지** | 인증·권한 [src/auth/](src/auth/), 댓글 [src/comments/](src/comments/) (위 3단계 행 참고) | [public/auth.js](public/auth.js), [public/comments.js](public/comments.js) |
| **로그인 회원의 후원 대상·금액 선택과 테스트 결제 요청** | `POST /api/donations/orders` — [donation.router.js](src/donations/donation.router.js) → [donation.service.js](src/donations/donation.service.js) `createOrder` (회원 확인, 받는 소유자 = 방송 소유자, 금액 1,000~500,000원·1,000원 단위 검증, 주문 저장) | 방송 화면의 후원 영역 [public/donations.js](public/donations.js) `mountDonations`(금액 빠른 선택·직접 입력·메시지) → `openPaymentWindow`: 토스 결제창(`TossPayments(clientKey).payment().requestPayment`) 또는 모의 결제창 [public/mock-pay.html](public/mock-pay.html) |
| **서버에서 결제 승인·금액·수신 대상을 검증한 뒤 확정** | `POST /api/donations/confirm` — `donation.service.js` `confirm` → 결제 서비스 승인 API([toss.js](src/donations/providers/toss.js) `POST /v1/payments/confirm`) → `finalize`: `status=DONE`, 승인 금액 = 저장된 주문 금액, 주문번호 일치, 받는 회원 = 지금의 방송 소유자를 모두 확인한 뒤에만 확정 | 결과 화면 `/donation/success` — `renderDonationResult`: 서버가 확정했다고 응답한 뒤에만 "후원 완료" 표시 |
| **같은 결제 건의 중복 확정 방지 코드와 저장 구조** | [src/database.js](src/database.js) 마이그레이션 4: `donations.order_id UNIQUE`, `donations.payment_key UNIQUE`, `CHECK (status <> 'done' OR payment_key IS NOT NULL)`. [donation.repository.js](src/donations/donation.repository.js) `markConfirmed`: `UPDATE … WHERE status = 'pending'` 조건부 갱신(한 번만 성공). 웹훅 `POST /api/donations/webhook` → `handleWebhook`: 결제 서비스에 다시 조회 후 같은 `finalize` → 이미 확정이면 `duplicate` | 결과 화면 새로고침 시 "이미 확정된 후원", 모의 결제의 "승인 통지 3번 다시 보내기" |
| **방송별 후원 내역과 합계 조회·표시** | `GET /api/broadcasts/:id/donations`, `GET /api/lives/:id/donations` → `listFor` (확정된 후원만, `SUM`·`COUNT`), 라이브 새 확정 후원은 WebSocket `donation` 메시지 | 녹화방송 상세·라이브 시청·라이브 송출 화면의 후원 영역(합계, 후원자·금액·메시지·시각), 라이브 후원 알림 `showDonationToast` |
| **[5단계] 서버 컨테이너 이미지** | [Dockerfile](Dockerfile) (node:24-slim 2단계 빌드, non-root, `HEALTHCHECK /healthz`), [.dockerignore](.dockerignore) | — |
| **[5단계] 로컬 클러스터에서 여러 인스턴스 실행** | [k8s/k3d-cluster.yaml](k8s/k3d-cluster.yaml)(k3d 단일 노드), [k8s/app.yaml](k8s/app.yaml) Deployment `replicas: 2`, readiness/liveness `/healthz`, SIGTERM 시 WebSocket 1012 종료 [src/server.js](src/server.js), [k8s/kustomization.yaml](k8s/kustomization.yaml) | — |
| **[5단계] 지표 기준 자동 스케일(최소·최대)** | [k8s/hpa.yaml](k8s/hpa.yaml) HPA autoscaling/v2: CPU 평균 50%, `minReplicas: 2`, `maxReplicas: 5`, 스케일 인 안정화 60초. 지표는 k3s 기본 metrics-server | — |
| **[5단계] 여러 인스턴스 앞 요청 분산** | [k8s/service.yaml](k8s/service.yaml) ClusterIP Service, [k8s/ingress.yaml](k8s/ingress.yaml) Traefik 인그레스(WebSocket 포함), 응답 헤더 `X-Instance` [src/app.js](src/app.js) | — |
| **[5단계] 상태를 인스턴스 밖 공용 저장소에** | 공유 볼륨 [k8s/storage.yaml](k8s/storage.yaml) PVC → `/data/replay.db`(회원·세션·방송·라이브 상태·댓글·후원), `/data/uploads`(영상), 다중 프로세스 SQLite `busy_timeout`·`BEGIN IMMEDIATE` 마이그레이션 [src/database.js](src/database.js). Redis [k8s/redis.yaml](k8s/redis.yaml) + [src/realtime/bus.js](src/realtime/bus.js): 라이브 시그널링·댓글·후원·종료 알림 pub/sub, 송출자 접속 표시 TTL 키 [src/lives/live.signaling.js](src/lives/live.signaling.js), 재접속 유예·주기 점검 [src/lives/live.service.js](src/lives/live.service.js) | 송출·시청 화면 자동 재접속 [public/live.js](public/live.js) |
| **[5단계] 부하 생성** | k6 스크립트 [k8s/load/k6-chzzk.js](k8s/load/k6-chzzk.js) + 클러스터 안 Job [k8s/load/k6-job.yaml](k8s/load/k6-job.yaml), 실행 도우미 [scripts/k3d.sh](scripts/k3d.sh) | — |
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

### 여러 인스턴스에서의 라이브 방송 (5단계에서 바뀐 규칙)

인스턴스가 늘고 줄 때마다 WebSocket 이 끊길 수 있으므로, 2단계의 "송출자 연결이 끊기면 즉시 종료", "서버가 시작되면 방송 중인 라이브를 모두 종료"를 다음처럼 바꿨습니다([ADR 0003](docs/adr/0003-shared-sqlite-volume-and-redis-bus.md)).

- 송출자·시청자 화면은 연결이 끊기면(인스턴스 종료 코드 1012, 네트워크 끊김) **자동으로 다시 접속**하고, 송출자는 시청자마다 영상 연결을 새로 맺습니다.
- 송출자 인스턴스는 Redis 에 **송출자 접속 표시**(TTL 20초)를 계속 갱신합니다. 연결이 끊긴 뒤 **재접속 유예 20초** 안에 어느 인스턴스로든 다시 붙으면 방송이 이어지고, 돌아오지 않으면 **어느 인스턴스든 5초마다 도는 점검**이 표시가 사라진 라이브를 종료합니다. 새 인스턴스가 뜬다고 남의 라이브를 끝내지 않습니다.
- `■ 송출 종료` 버튼, 탭 닫기·다른 화면 이동은 유예 없이 즉시 종료합니다.
- 소유자가 다른 화면으로 다시 송출에 참여하면 그 화면이 송출자가 되고 이전 연결은 닫힙니다(4001).
- 시그널링·댓글·후원·종료 알림은 Redis pub/sub 로 모든 인스턴스에 퍼지고, 각 인스턴스는 자기에게 붙은 연결에만 전달합니다. 송출자가 A 파드, 시청자가 B 파드에 붙어도 영상 협상이 됩니다.

### 후원 (4단계)

**흐름** (토스와 모의 결제가 같습니다)

1. **후원 주문**: 방송 화면에서 금액(1,000~500,000원, 1,000원 단위)과 메시지(선택, 100자)를 정해 `♥ 후원하기` → `POST /api/donations/orders`. 서버가 로그인 회원인지, 받는 회원(= 방송 소유자)이 있는지, 자기 방송이 아닌지, 금액이 맞는지 확인하고 **주문번호·금액·받는 회원·방송·후원자를 저장**합니다(상태 `pending`, 결제 대기).
2. **결제 요청**: 브라우저가 결제창을 엽니다. 토스: `TossPayments(clientKey).payment({ customerKey }).requestPayment({ method: 'CARD', amount: { currency: 'KRW', value }, orderId, orderName, successUrl, failUrl })`. 모의: `/mock-pay.html`.
3. **결과 리다이렉트**: 성공이면 `/donation/success?paymentKey&orderId&amount`, 실패·취소면 `/donation/fail?code&message(&orderId)`.
4. **승인 확인 → 확정**(서버, `POST /api/donations/confirm`):
   - 주문이 이 로그인 회원의 것인지, 결제 대기 상태인지, 30분이 지나지 않았는지
   - 리다이렉트로 온 `amount` 가 **서버에 저장된 주문 금액**과 같은지(다르면 결제 서비스에 승인 요청조차 하지 않고 실패 처리)
   - 받는 회원이 **지금도** 그 방송의 소유자인지(방송 삭제·소유자 변경이면 실패)
   - 결제 서비스 승인 API를 **저장된 주문 금액으로** 호출하고, 응답의 `status === 'DONE'`, `totalAmount === 주문 금액`, `orderId` 일치를 확인
   - 모두 통과하면 `UPDATE donations SET status='done' … WHERE order_id=? AND status='pending'` 으로 **한 번만** 확정
5. 화면은 서버가 확정했다고 응답한 뒤에만 "♥ 후원 완료"를 보여줍니다.

**같은 승인 통지가 반복될 때**: 승인 통지는 두 경로로 옵니다. (1) 브라우저의 성공 리다이렉트 → `/api/donations/confirm`(새로고침·뒤로 가기로 반복될 수 있음), (2) 결제 서비스의 `PAYMENT_STATUS_CHANGED` 웹훅 → `/api/donations/webhook`(토스는 200을 못 받으면 최대 7회 재전송). 두 경로 모두 같은 `finalize` 로 들어갑니다.

- 웹훅 본문은 믿지 않고 `paymentKey` 로 결제 서비스에 실제 상태를 **다시 조회**한 뒤 검증합니다(위조된 웹훅은 `ignored`).
- 이미 확정된 주문이면 `duplicate` 로 응답하고 적립하지 않습니다. 결제 서비스가 재전송을 멈추도록 처리·중복·무시 모두 200 으로 응답합니다.
- 토스가 승인 재요청에 `ALREADY_PROCESSED_PAYMENT` 를 주면(웹훅이 먼저 확정한 경우 등) 조회 API로 `DONE` 인지 확인하고 같은 검증을 거칩니다.
- 저장 구조로도 막습니다: `order_id UNIQUE`(주문당 한 행), `payment_key UNIQUE`(한 결제가 두 주문에 쓰이지 않음), 조건부 UPDATE(동시에 두 통지가 와도 하나만 `changes = 1`).

**실패·취소·만료**: failUrl 의 `code` 가 `PAY_PROCESS_CANCELED`(사용자가 결제창을 닫음)이면 **취소**, 그 밖(`REJECT_CARD_COMPANY` 등)은 **실패**로 기록합니다. 토스는 취소 때 `orderId` 를 주지 않으므로, 주문을 만들 때 브라우저 sessionStorage 에 주문번호를 기억해 둡니다. 결제창에서 돌아오지 않은 결제 대기 주문은 30분 뒤 확정할 수 없습니다(**만료**). 실패·취소·만료 주문은 다시 확정할 수 없고(409) 내역·합계에 들어가지 않습니다.

**라이브**: 라이브 방송에 새로 확정된 후원은 연결된 시청자·송출자(휴대폰 송출 화면 포함)에게 WebSocket으로 한 번만 알림이 갑니다(중복 통지로는 다시 오지 않음).

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
| WS | `/ws/lives` | 시청자: 공개, 송출자: 소유자 | 첫 메시지 `{type:'join', role:'broadcaster'\|'viewer', liveId}` 후 `offer`/`answer`/`ice` 중계. 서버가 `viewer-joined`/`viewer-left`/`comment`/`donation`/`ended` 통지 |
| `GET` | `/api/donations/config` | 공개 | 결제 서비스 종류(`toss`/`mock`), 토스 클라이언트 키, 금액 범위 |
| `POST` | `/api/donations/orders` | 회원 | JSON `{ targetType: 'broadcast' 또는 'live', targetId, amount, message? }` → 201 `{ orderId, amount, orderName, customerKey, payment }` |
| `POST` | `/api/donations/confirm` | 주문의 후원자 | JSON `{ orderId, paymentKey, amount }` → 200 `{ donation, alreadyConfirmed }`. 금액 불일치 400, 결제 거절 402, 만료·이미 실패 409 |
| `POST` | `/api/donations/orders/:orderId/fail` | 주문의 후원자 | JSON `{ code, message }`. `PAY_PROCESS_CANCELED` → 취소, 그 외 → 실패 |
| `POST` | `/api/donations/webhook` | 결제 서비스 | `{ eventType: 'PAYMENT_STATUS_CHANGED', data: { paymentKey, … } }` → 200 `{ result: confirmed / duplicate / ignored / rejected }` |
| `GET` | `/api/broadcasts/:id/donations`, `/api/lives/:id/donations` | 공개 | `{ total: { amount, count }, donations: [...] }` (확정된 후원만, 최근 순) |
| `POST` | `/mock-pg/payments` | 모의 결제창 | (모의 결제일 때만) 결제창 '성공' — 결제(READY) 생성 |
| `POST` | `/mock-pg/payments/:paymentKey/webhook-resend?times=3` | 테스트 | (모의 결제일 때만) 같은 승인 웹훅을 여러 번 다시 보냄 |

오류 응답은 모두 `{ "error": "한국어 메시지" }` 형식입니다. 401 = 로그인 필요, 403 = 권한 없음(소유자·작성자 아님, 다른 출처 요청), 404 = 없음, 409 = 상태 충돌.

### 제외 (이번 단계 범위 밖)

- 후원 환불·결제 취소(확정 후), 받는 회원의 정산·출금, 익명 후원, 회원별 "내 후원 내역" 화면
- 토스 웹훅 서명(`tosspayments-webhook-signature`) 검증: 대신 웹훅 본문을 믿지 않고 결제 조회 API로 다시 확인합니다
- 실제 금전 결제: 토스 `live_` 키는 서버가 거부합니다
- 여러 노드 클러스터: 공유 볼륨의 SQLite 는 단일 노드에서만 안전합니다. 노드가 늘면 PostgreSQL·오브젝트 스토리지로 옮겨야 합니다([ADR 0003](docs/adr/0003-shared-sqlite-volume-and-redis-bus.md))
- Redis 고가용성(Sentinel·클러스터), 클러스터 인그레스 TLS, 클라우드 배포: 다음 단계
- 비밀번호 찾기·변경, 이메일 인증, 회원 탈퇴, 소셜 로그인
- 방송 소유자의 댓글 관리(남의 댓글 삭제) 권한, 관리자 역할
- 로그인 시도 횟수 제한·요청 속도 제한: 공개 서비스로 운영하기 전에 추가가 필요합니다
- 라이브 방송 녹화, 대규모 시청(P2P 구조라 한 방송의 동시 시청자는 약 5~10명이 현실적인 한계, [ADR 0001](docs/adr/0001-webrtc-p2p-live-broadcast.md))

### 토스 테스트 모드로 실행

1. [토스페이먼츠 개발자센터](https://developers.tosspayments.com)에 가입(계약 불필요)하고 `API 키` 메뉴에서 **API 개별 연동 키**의 테스트 클라이언트 키(`test_ck_…`)와 테스트 시크릿 키(`test_sk_…`)를 확인합니다. 결제위젯 키(`test_gck_…`/`test_gsk_…`)는 이 결제창 방식과 맞지 않습니다.
2. `.env` 에 `TOSS_CLIENT_KEY`, `TOSS_SECRET_KEY` 를 넣고 `npm start`. 후원 영역에 "토스페이먼츠 테스트 결제창으로 이동합니다"가 보이면 토스 모드입니다.
3. 후원하기 → 토스 테스트 결제창에서 결제수단을 고르고 진행하면 `/donation/success` 로 돌아와 서버가 승인 API를 호출합니다. 테스트 키라 **실제로 돈이 빠져나가지 않습니다.** 결제창을 닫으면 `PAY_PROCESS_CANCELED` 로 취소 화면이 나옵니다.
4. 웹훅까지 확인하려면 서버를 공개 주소로 열어야 합니다(토스는 로컬 포트 주소를 웹훅으로 등록할 수 없음). 예: `ngrok http 3000` → 개발자센터 `웹훅` 메뉴에 `https://<ngrok 주소>/api/donations/webhook` 를 `PAYMENT_STATUS_CHANGED` 로 등록. 결제 승인 직후 토스가 보내는 웹훅이 리다이렉트 확정과 겹치는 **실제 중복 통지**가 되고, 응답은 `duplicate` 입니다. 웹훅 전송 기록은 개발자센터에서 볼 수 있습니다.

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

### 6. 후원: 테스트 결제 성공·실패·취소, 승인 통지 중복 (A, B, C)

`.env` 에 토스 키가 없으면 **모의 결제창**, 있으면 **토스 테스트 결제창**이 열립니다. 아래는 모의 결제 기준이고, 토스에서도 같은 결과 화면과 서버 동작을 확인할 수 있습니다.

19. **후원 영역 확인**: B가 등록한 녹화방송을 엽니다.
    - A(비로그인): 합계와 내역은 보이고, 후원 입력칸 대신 "로그인하면 … 후원할 수 있습니다"가 표시됩니다. 콘솔에서 `await fetch('/api/donations/orders', {method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify({targetType:'broadcast', targetId:<id>, amount:5000})}).then(r => r.status)` → **401**
    - B(소유자): "자기 방송에는 후원할 수 없습니다" 안내. 같은 요청 → **403**
    - 소유자 없는 이전 단계 방송: "소유자가 없는 방송에는 후원할 수 없습니다"(→ 400)
20. **결제 성공**: C로 `10,000원` 선택, 메시지 `첫 후원입니다!` → `♥ 후원하기` → 모의 결제창에서 `결제 성공` → `/donation/success` 에서 "후원 확인 중…" 뒤 **"♥ 후원 완료"**, 받는 소유자·금액·메시지가 표시됩니다. `방송으로 돌아가기` → 후원 합계 **10,000원 1건**, 내역에 C의 닉네임·금액·메시지·시각.
21. **승인 통지 중복**:
    - 성공 화면에서 `승인 통지 3번 다시 보내기` → 로그에 `통지 1~3: duplicate — 이미 확정된 후원 — 다시 적립하지 않음`, `후원 합계: 10,000원 (1건) → 10,000원 (1건)`
    - 성공 화면을 **새로고침**(같은 승인 요청 재전송) → "이미 확정된 후원입니다. 같은 결제는 한 번만 적립됩니다."
    - 웹훅 주소로 직접 반복(`<paymentKey>` 는 성공 화면 주소창의 값):

      ```bash
      curl -X POST http://localhost:3000/api/donations/webhook -H "Content-Type: application/json" -d "{\"eventType\":\"PAYMENT_STATUS_CHANGED\",\"data\":{\"paymentKey\":\"<paymentKey>\"}}"
      ```

      몇 번을 보내도 `{"result":"duplicate",…}` 이고 합계는 그대로입니다. 없는 `paymentKey` 로 보내면 `ignored` 입니다.
22. **결제 실패**: C로 다시 후원 → 모의 결제창 `결제 실패 (카드사 거절)` → "후원 결제에 실패했습니다 … (REJECT_CARD_COMPANY) 후원은 적립되지 않았습니다." 합계 변화 없음.
23. **결제 취소**: C로 다시 후원 → `결제 취소 (창 닫기)` → "후원을 취소했습니다 … (PAY_PROCESS_CANCELED)". 합계 변화 없음. 토스 결제창에서는 창을 닫으면 같은 결과입니다.
24. **금액 변조**(선택): 모의 결제창의 `금액 변조 테스트` 를 펼쳐 50,000원 주문의 결제 금액·성공 주소 금액을 1,000으로 바꾸고 `결제 성공` → "후원을 확정하지 못했습니다 — 결제 금액이 후원 주문 금액과 다릅니다". 합계 변화 없음.
25. **라이브 후원 알림**: B가 라이브를 송출하고 C가 시청하며 후원하면, **휴대폰 송출 화면과 다른 시청 화면에 "○○님 10,000원 후원!" 알림**이 뜨고 라이브의 후원 합계가 올라갑니다. 승인 통지를 다시 보내도 알림은 다시 뜨지 않습니다.

### 7. 로컬 오토스케일: 스케일 아웃·인과 상태 유지 (5단계)

27. **배포**: `scripts/k3d.sh up` → `scripts/k3d.sh deploy`. `kubectl -n chzzk get pods` 에 `chzzk-…` 파드 2개와 `redis-…` 1개가 `Running`, `kubectl -n chzzk get hpa` 가 `cpu: 2%/50%  2  5  2` 처럼 보이면 준비된 것입니다(지표가 `<unknown>` 이면 1분쯤 기다립니다).
28. **요청 분산 확인**: `curl -s -D - -o /dev/null http://localhost:8080/healthz` 를 여러 번 실행하면 `X-Instance` 헤더가 파드 이름 두 개를 번갈아 보여줍니다.
29. **상태 준비**: <http://localhost:8080> 에서 회원가입(로그인 유지) → 녹화방송 업로드 → 댓글 작성. 라이브를 하나 시작해 다른 창에서 시청해 두면 라이브 유지도 함께 볼 수 있습니다.
30. **부하 → 스케일 아웃**: 터미널 하나에서 `kubectl -n chzzk get hpa chzzk -w`(또는 `scripts/k3d.sh watch`), 다른 터미널에서 `scripts/k3d.sh load`. 1분 안팎에 CPU 사용률이 50%를 넘고 `REPLICAS` 가 3·4·5로 늘어납니다(`kubectl -n chzzk get pods` 에 새 파드).
31. **스케일 중 상태 확인**: 늘어나는 동안 브라우저를 새로고침하고 방송 목록·상세·댓글을 오가도 **로그인 상태와 목록·댓글이 그대로**입니다(응답 헤더 `X-Instance` 는 매번 다른 파드일 수 있음). 시청 중인 라이브는 끊기지 않거나, 인스턴스가 바뀌면 몇 초 안에 자동으로 다시 붙습니다.
32. **부하 종료 → 스케일 인**: k6 Job 이 끝나면(약 3분) CPU 가 내려가고, 안정화 60초 뒤 `REPLICAS` 가 2로 돌아옵니다. 이때도 로그인·목록·댓글·업로드 영상이 그대로입니다.
33. **부하 결과**: `kubectl -n chzzk logs job/chzzk-load` 의 `chzzk_responses_by_instance` 에서 응답이 여러 파드로 나뉜 것과 실패율(`http_req_failed`)을 볼 수 있습니다.

#### 실측 결과 (2026-11-22)

이 저장소의 설정 그대로 Windows 11 + Docker Desktop 29.9 + k3d 5.9.0(k3s v1.35.5) 에서 실행한 기록입니다. `scripts/k3d.sh watch` 와 같은 방식으로 5초마다 기록했습니다. 왼쪽부터 시각, HPA 의 평균 CPU 사용률/목표(requests 100m 대비), HPA 가 본 현재 파드 수(`replicas`), 실제 `chzzk` 파드 상태입니다. 2개 → 4 → 5(최대)로 늘었다가 부하가 끝나고 안정화 60초 뒤 4 → 2(최소)로 줄었습니다.

```text
17:40:13 cpu: 1%/50% replicas=2 pods=[Running,Running,]
17:40:19 cpu: 1%/50% replicas=2 pods=[Running,Running,]
17:40:24 cpu: 1%/50% replicas=2 pods=[Running,Running,]
17:40:30 cpu: 3%/50% replicas=2 pods=[Running,Running,]
17:40:35 cpu: 3%/50% replicas=2 pods=[Running,Running,]
17:40:41 cpu: 4%/50% replicas=2 pods=[Running,Running,]
17:40:46 cpu: 4%/50% replicas=2 pods=[Running,Running,]
17:40:52 cpu: 4%/50% replicas=2 pods=[Running,Running,]
17:40:57 cpu: 111%/50% replicas=2 pods=[Running,Running,Running,Running,]
17:41:03 cpu: 111%/50% replicas=2 pods=[Running,Running,Running,Running,]
17:41:08 cpu: 111%/50% replicas=2 pods=[Running,Running,Running,Running,]
17:41:14 cpu: 291%/50% replicas=4 pods=[Running,Running,Running,Running,Running,]
17:41:20 cpu: 291%/50% replicas=4 pods=[Running,Running,Running,Running,Running,]
17:41:26 cpu: 322%/50% replicas=5 pods=[Running,Running,Running,Running,Running,]
17:41:31 cpu: 322%/50% replicas=5 pods=[Running,Running,Running,Running,Running,]
17:41:37 cpu: 322%/50% replicas=5 pods=[Running,Running,Running,Running,Running,]
17:41:42 cpu: 132%/50% replicas=5 pods=[Running,Running,Running,Running,Running,]
17:41:48 cpu: 132%/50% replicas=5 pods=[Running,Running,Running,Running,Running,]
17:41:54 cpu: 132%/50% replicas=5 pods=[Running,Running,Running,Running,Running,]
17:41:59 cpu: 131%/50% replicas=5 pods=[Running,Running,Running,Running,Running,]
17:42:05 cpu: 131%/50% replicas=5 pods=[Running,Running,Running,Running,Running,]
17:42:10 cpu: 131%/50% replicas=5 pods=[Running,Running,Running,Running,Running,]
17:42:15 cpu: 127%/50% replicas=5 pods=[Running,Running,Running,Running,Running,]
17:42:21 cpu: 127%/50% replicas=5 pods=[Running,Running,Running,Running,Running,]
17:42:27 cpu: 130%/50% replicas=5 pods=[Running,Running,Running,Running,Running,]
17:42:32 cpu: 130%/50% replicas=5 pods=[Running,Running,Running,Running,Running,]
17:42:38 cpu: 130%/50% replicas=5 pods=[Running,Running,Running,Running,Running,]
17:42:43 cpu: 132%/50% replicas=5 pods=[Running,Running,Running,Running,Running,]
17:42:49 cpu: 132%/50% replicas=5 pods=[Running,Running,Running,Running,Running,]
17:42:54 cpu: 132%/50% replicas=5 pods=[Running,Running,Running,Running,Running,]
17:43:00 cpu: 136%/50% replicas=5 pods=[Running,Running,Running,Running,Running,]
17:43:06 cpu: 136%/50% replicas=5 pods=[Running,Running,Running,Running,Running,]
17:43:12 cpu: 139%/50% replicas=5 pods=[Running,Running,Running,Running,Running,]
17:43:18 cpu: 139%/50% replicas=5 pods=[Running,Running,Running,Running,Running,]
17:43:23 cpu: 139%/50% replicas=5 pods=[Running,Running,Running,Running,Running,]
17:43:28 cpu: 118%/50% replicas=5 pods=[Running,Running,Running,Running,Running,]
17:43:34 cpu: 118%/50% replicas=5 pods=[Running,Running,Running,Running,Running,]
17:43:39 cpu: 118%/50% replicas=5 pods=[Running,Running,Running,Running,Running,]
17:43:45 cpu: 39%/50% replicas=5 pods=[Running,Running,Running,Running,Running,]
17:43:50 cpu: 39%/50% replicas=5 pods=[Running,Running,Running,Running,Running,]
17:43:55 cpu: 39%/50% replicas=5 pods=[Running,Running,Running,Running,Running,]
17:44:01 cpu: 2%/50% replicas=5 pods=[Running,Running,Running,Running,Running,]
17:44:07 cpu: 2%/50% replicas=5 pods=[Running,Running,Running,Running,Running,]
17:44:12 cpu: 1%/50% replicas=5 pods=[Running,Running,Running,Running,Running,]
17:44:18 cpu: 1%/50% replicas=5 pods=[Running,Running,Running,Running,Running,]
17:44:23 cpu: 1%/50% replicas=5 pods=[Running,Running,Running,Running,Running,]
17:44:29 cpu: 1%/50% replicas=5 pods=[Running,Running,Completed,Running,Running,]
17:44:34 cpu: 1%/50% replicas=5 pods=[Running,Running,Running,Running,]
17:44:40 cpu: 1%/50% replicas=5 pods=[Running,Running,Running,Running,]
17:44:45 cpu: 2%/50% replicas=4 pods=[Running,Running,]
17:44:50 cpu: 2%/50% replicas=4 pods=[Running,Running,]
17:44:56 cpu: 2%/50% replicas=2 pods=[Running,Running,]
17:45:01 cpu: 2%/50% replicas=2 pods=[Running,Running,]
17:45:07 cpu: 2%/50% replicas=2 pods=[Running,Running,]
17:45:12 cpu: 2%/50% replicas=2 pods=[Running,Running,]

# k6 부하 Job 요약 (kubectl -n chzzk logs job/chzzk-load)
checks_succeeded...: 100.00% 33453 out of 33453
chzzk_responses_by_instance....: 47730  280.360308/s
http_req_duration..............: avg=101.63ms p(95)=380.8ms max=3.99s
http_req_failed................: 0.00%  0 out of 49363
http_reqs......................: 49363  289.952354/s
default ✓ [ 100% ] 00/50 VUs  2m50s
```

같은 시간 동안 인그레스(`http://localhost:8080`)로 5초마다 로그인 세션(`/api/auth/me`)·방송 목록·댓글·업로드 영상을 조회한 기록입니다. `@xxxxx` 는 응답한 파드 이름 끝 5자리입니다(스케일 아웃 직전·직후는 5초마다, 나머지는 15초 간격으로 줄여 실었습니다). 파드가 2 → 5 → 2 로 바뀌는 동안 한 번도 로그아웃되거나 목록·댓글·영상이 사라지지 않았습니다.

```text
17:40:14 me=스케일확인@4t2d7 broadcasts=1@hqsfm comments=1 video=ok
17:40:19 me=스케일확인@4t2d7 broadcasts=1@hqsfm comments=1 video=ok
17:40:24 me=스케일확인@4t2d7 broadcasts=1@hqsfm comments=1 video=ok
17:40:54 me=스케일확인@4t2d7 broadcasts=1@hqsfm comments=1 video=ok
17:41:01 me=스케일확인@hqsfm broadcasts=1@4t2d7 comments=1 video=ok
17:41:06 me=스케일확인@6xwtg broadcasts=1@4t2d7 comments=1 video=ok
17:41:12 me=스케일확인@hqsfm broadcasts=1@4gkmt comments=1 video=ok
17:41:17 me=스케일확인@6xwtg broadcasts=1@hqsfm comments=1 video=ok
17:41:22 me=스케일확인@4t2d7 broadcasts=1@wvwwx comments=1 video=ok
17:41:32 me=스케일확인@6xwtg broadcasts=1@4gkmt comments=1 video=ok
17:41:47 me=스케일확인@6xwtg broadcasts=1@4t2d7 comments=1 video=ok
17:42:07 me=스케일확인@4gkmt broadcasts=1@wvwwx comments=1 video=ok
17:42:22 me=스케일확인@hqsfm broadcasts=1@wvwwx comments=1 video=ok
17:42:37 me=스케일확인@4gkmt broadcasts=1@4t2d7 comments=1 video=ok
17:43:02 me=스케일확인@6xwtg broadcasts=1@4gkmt comments=1 video=ok
17:43:17 me=스케일확인@6xwtg broadcasts=1@4t2d7 comments=1 video=ok
17:43:32 me=스케일확인@4gkmt broadcasts=1@wvwwx comments=1 video=ok
17:43:47 me=스케일확인@hqsfm broadcasts=1@wvwwx comments=1 video=ok
17:44:02 me=스케일확인@4gkmt broadcasts=1@4t2d7 comments=1 video=ok
17:44:17 me=스케일확인@6xwtg broadcasts=1@4gkmt comments=1 video=ok
17:44:32 me=스케일확인@4t2d7 broadcasts=1@4gkmt comments=1 video=ok
17:44:47 me=스케일확인@4t2d7 broadcasts=1@hqsfm comments=1 video=ok
17:45:02 me=스케일확인@4t2d7 broadcasts=1@hqsfm comments=1 video=ok
```

라이브 시그널링이 파드를 넘나드는지도 같은 클러스터(실제 Redis)에서 확인했습니다: 송출자는 `…hqsfm`, 시청자는 `…4t2d7` 파드에 붙은 상태에서 offer·answer 가 전달되었고, `…hqsfm` 로 쓴 댓글과 `…4t2d7` 로 보낸 종료 요청이 양쪽 연결 모두에 도착했습니다.

### 8. 영속 저장

34. 서버를 `Ctrl+C` 로 종료 후 다시 `npm start`. 방송·회원·댓글·후원 내역과 합계가 그대로 남고, 로그인 상태도 유지됩니다(세션 7일). 방송 중이던 라이브는 송출자가 돌아오지 않으면 재접속 유예 뒤 종료로 바뀝니다.

### 자동 테스트

`npm test` 는 임시 디렉터리에서 서버를 띄워 64개 시나리오를 확인합니다.

- 인증([test/auth.test.js](test/auth.test.js)): 가입 즉시 로그인, HttpOnly·SameSite 쿠키, scrypt 해시 저장, 입력 검증·중복 409, 로그인 실패 메시지 동일, 로그아웃 후 같은 토큰 무효, 세션 토큰 해시 저장, 만료
- 녹화방송([test/broadcasts.test.js](test/broadcasts.test.js)): 1단계 기능, 비로그인 등록 401(파일 미저장), 수정·삭제 401/403/200, 삭제 시 파일·댓글 정리, 다른 출처 요청 403, 재시작 후 유지, 이전 DB 마이그레이션·소유자 없는 방송 관리 불가
- 라이브([test/lives.test.js](test/lives.test.js)): 시작 401, 동시 방송 409, 종료·수정·삭제 401/403/200, 비로그인·다른 회원의 송출자 참여 거절, 시그널링 중계, 라이브 댓글 실시간 전달, 다른 출처 WebSocket 거절, 재시작
- 댓글([test/comments.test.js](test/comments.test.js)): 비로그인 작성 401, 작성자 연결, 공개 목록·방송별 분리, 검증, 수정·삭제 401/403(방송 소유자 포함)/200, 종료된 라이브 댓글, 재시작 후 유지
- 후원([test/donations.test.js](test/donations.test.js), 모의 결제): 공개 설정에 비밀 없음, 주문 401·자기 방송 403·소유자 없음·금액 범위·메시지 길이, 성공 확정과 내역·합계, **승인 재요청 3회·자동 웹훅·웹훅 재전송 5회·웹훅 직접 3회에도 1회 적립**, 위조 웹훅(없는 결제·READY 결제) 무시, 리다이렉트·결제창 금액 변조 거절, 남의 주문 401/403, 실패·취소 후 확정 불가, 30분 만료, 주문 후 방송 삭제 시 확정 거절, `order_id`·`payment_key` UNIQUE, 라이브 실시간 후원 알림 1회, 재시작 후 유지
- 여러 인스턴스([test/multi-instance.test.js](test/multi-instance.test.js), 서버 2~3개가 같은 DB 파일·같은 버스 공유): `X-Instance`·`/healthz`, A 에서 만든 세션으로 B 로그인, A 에서 등록한 방송·업로드 영상·댓글·후원이 B 에서 보임, 두 인스턴스에 동시에 온 승인 요청도 1회 확정, 송출자 A·시청자 B 사이 시그널링·댓글·후원·종료 전달, 송출자 인스턴스가 1012 로 내려가도 다른 인스턴스로 재접속하면 유지, 새 인스턴스가 떠도 남의 라이브를 끝내지 않음
- 라이브 재접속([test/lives.test.js](test/lives.test.js)): 유예 안 재접속 시 유지·돌아오지 않으면 종료, 새 화면 이어받기(4001), 재시작 후 주기 점검 종료
- 토스 어댑터([test/toss.test.js](test/toss.test.js), 가짜 토스 API 서버): 클라이언트 키만 공개·모의 결제 경로 닫힘, 승인 API 호출 형식(Basic 인증·저장된 금액), 웹훅 선도착 후 `ALREADY_PROCESSED_PAYMENT` 에도 1회 적립, 카드사 거절 시 실패 기록, `live_` 키 거부

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
│  ├─ realtime/bus.js           # 인스턴스 사이 메시지 버스(Redis 또는 메모리): pub/sub, TTL 접속 표시
│  ├─ auth/                     # 인증·인가 (3단계)
│  │  ├─ auth.router.js         # 가입·로그인·로그아웃·me
│  │  ├─ auth.service.js        # 가입 검증, 로그인, 세션 발급·확인
│  │  ├─ member.repository.js   # members·sessions 테이블 SQL
│  │  ├─ password.js            # scrypt 해시·검증
│  │  ├─ session-cookie.js      # 세션 쿠키, req.member, 로그인 필수, 다른 출처 거절
│  │  └─ access.js              # 권한 규칙: requireMember / requireOwner / requireAuthor
│  ├─ broadcasts/               # 녹화방송 (1단계, 3단계 소유자 권한)
│  ├─ lives/                    # 라이브 방송 (2단계, 3단계 소유자 권한·실시간 댓글)
│  ├─ comments/                 # 댓글 (3단계)
│  │  ├─ comment.router.js      # 방송별 댓글 조회·작성, 댓글 수정·삭제
│  │  ├─ comment.service.js     # 작성(회원)·수정·삭제(작성자) 규칙, 변경 이벤트
│  │  └─ comment.repository.js  # comments 테이블 SQL
│  └─ donations/                # 후원 (4단계)
│     ├─ donation.router.js     # 주문·확정·실패·웹훅, 방송별 내역·합계
│     ├─ donation.service.js    # 주문 검증, 승인 확인·확정(finalize), 중복 통지 처리, 만료
│     ├─ donation.repository.js # donations 테이블 SQL (조건부 확정 UPDATE)
│     └─ providers/             # 결제 서비스 포트
│        ├─ toss.js             # 토스페이먼츠 테스트 모드: 승인·조회 API
│        ├─ mock.js             # 내장 모의 결제 서비스(결제창 API, 자동 웹훅, 웹훅 재전송)
│        ├─ provider-error.js   # 결제 서비스 오류·결제 정보 모양
│        └─ index.js            # 설정에 따라 어댑터 선택
├─ public/
│  ├─ index.html                # 화면 템플릿
│  ├─ app.js                    # 라우팅, 방송 목록, 녹화방송 화면
│  ├─ auth.js                   # 로그인·회원가입 화면
│  ├─ live.js                   # 라이브 송출·시청 화면(getUserMedia, WebRTC)
│  ├─ comments.js               # 댓글 영역
│  ├─ owner-tools.js            # 소유자 수정·삭제 영역
│  ├─ donations.js              # 후원 영역, 결제창 열기, 결제 결과 화면, 라이브 후원 알림
│  ├─ mock-pay.html, mock-pay.js # 모의 결제창 (토스 키가 없을 때만)
│  ├─ common.js                 # 공통 도우미, 로그인 상태
│  └─ style.css
├─ test/                        # node:test (auth, broadcasts, lives, comments, donations, toss, multi-instance)
├─ Dockerfile, .dockerignore    # 서버 컨테이너 이미지 (5단계)
├─ k8s/                         # 로컬 Kubernetes (5단계)
│  ├─ k3d-cluster.yaml          # k3d 클러스터(노드 1, 호스트 8080 → 인그레스)
│  ├─ kustomization.yaml        # kubectl apply -k k8s
│  ├─ app.yaml                  # chzzk Deployment(replicas 2, probes, 리소스, 공유 볼륨)
│  ├─ service.yaml, ingress.yaml # 요청 분산(Service + Traefik)
│  ├─ hpa.yaml                  # CPU 50%, 2~5 파드
│  ├─ storage.yaml              # 공유 볼륨 PVC (SQLite·업로드)
│  ├─ redis.yaml                # Redis (pub/sub, 송출자 접속 표시)
│  └─ load/                     # k6 스크립트 + Job
├─ scripts/k3d.sh               # up / deploy / load / watch / status / down
├─ docs/adr/                    # 설계 결정 기록
├─ GLOSSARY.md                  # 도메인 용어
├─ data/                        # (실행 시 생성) replay.db, uploads/, tls/
└─ .env.example
```

요청은 `router → service → repository / storage` 한 방향으로만 흐릅니다. 권한 검사는 **서비스 안에서** `access.js` 규칙으로 하므로,
HTTP 라우터든 WebSocket이든 어느 경로로 들어와도 같은 규칙이 적용됩니다.

### 다음 단계로 확장할 때

- **새 기능**: `src/<기능>/` 에 router·service·repository 를 같은 모양으로 만들고 [src/app.js](src/app.js) 에서 연결합니다. 회원은 `req.member`, 권한은 `access.js` 를 그대로 씁니다. 라이브 중 실시간 알림은 댓글처럼 서비스 이벤트를 [live.signaling.js](src/lives/live.signaling.js) 가 방에 전달하면 됩니다.
- **테이블 추가·변경**: [src/database.js](src/database.js) 의 `MIGRATIONS` 배열 끝에 SQL을 추가합니다. 이미 적용된 항목은 다시 실행되지 않으므로 기존 데이터가 유지됩니다.
