#!/usr/bin/env bash
# OCI VM 에서 실행: 최신 코드로 이미지를 빌드해 앱 + Caddy 를 띄우고 HTTPS 상태 확인 경로를 점검한다.
#   ssh ubuntu@<VM 공인 IP> /opt/chzzk/scripts/deploy.sh
set -euo pipefail
cd "$(dirname "$0")/.."

if [ ! -f deploy/.env ]; then
  echo "deploy/.env 가 없습니다: cp deploy/.env.example deploy/.env 후 DOMAIN 등을 고치세요." >&2
  exit 1
fi
# shellcheck disable=SC1091
set -a; . deploy/.env; set +a
if [ -z "${DOMAIN:-}" ] || [ "$DOMAIN" = "chzzk.example.com" ]; then
  echo "deploy/.env 의 DOMAIN 을 구매한 도메인으로 바꾸세요." >&2
  exit 1
fi

git pull --ff-only
docker compose -f deploy/docker-compose.yml --env-file deploy/.env up -d --build --remove-orphans
docker image prune -f >/dev/null

echo "상태 확인: https://$DOMAIN/healthz"
for i in $(seq 1 30); do
  if curl -fsS "https://$DOMAIN/healthz"; then
    echo
    echo "배포 완료: https://$DOMAIN  (다운로드: https://$DOMAIN/download)"
    exit 0
  fi
  sleep 5
done
echo "HTTPS 상태 확인에 실패했습니다. 'docker compose -f deploy/docker-compose.yml logs caddy app' 로 원인을 확인하세요." >&2
exit 1
