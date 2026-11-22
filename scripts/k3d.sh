#!/usr/bin/env bash
# 로컬 오토스케일 실습 도우미 (Git Bash / macOS / Linux)
#   scripts/k3d.sh up       k3d 클러스터 생성 (k8s/k3d-cluster.yaml)
#   scripts/k3d.sh deploy   이미지 빌드 → 클러스터로 가져오기 → kubectl apply -k k8s → 롤아웃 대기
#   scripts/k3d.sh load     k6 부하 Job 실행 (k8s/load)
#   scripts/k3d.sh watch    HPA·파드 수 변화를 5초마다 시각과 함께 출력
#   scripts/k3d.sh status   HPA, 파드, CPU 사용량 한 번 출력
#   scripts/k3d.sh down     클러스터 삭제
set -euo pipefail
cd "$(dirname "$0")/.."

CLUSTER=chzzk
NS=chzzk
IMAGE=chzzk:local

case "${1:-help}" in
  up)
    if k3d cluster list "$CLUSTER" >/dev/null 2>&1; then
      echo "클러스터 $CLUSTER 가 이미 있습니다."
    else
      k3d cluster create --config k8s/k3d-cluster.yaml
    fi
    kubectl config use-context "k3d-$CLUSTER"
    ;;
  deploy)
    docker build -t "$IMAGE" .
    k3d image import "$IMAGE" -c "$CLUSTER"
    kubectl apply -k k8s
    # 같은 태그를 다시 가져왔으므로 파드를 새 이미지로 교체한다.
    kubectl -n "$NS" rollout restart deployment/chzzk
    kubectl -n "$NS" rollout status deployment/chzzk --timeout=180s
    kubectl -n "$NS" rollout status deployment/redis --timeout=120s
    echo "열기: http://localhost:8080"
    ;;
  load)
    kubectl -n "$NS" delete job chzzk-load --ignore-not-found
    kubectl apply -k k8s/load
    echo "부하 진행: kubectl -n $NS logs -f job/chzzk-load"
    ;;
  watch)
    while true; do
      hpa=$(kubectl -n "$NS" get hpa chzzk --no-headers -o custom-columns=TARGETS:.status.currentMetrics[0].resource.current.averageUtilization,REPLICAS:.status.currentReplicas,DESIRED:.status.desiredReplicas 2>/dev/null || true)
      pods=$(kubectl -n "$NS" get pods -l app=chzzk --no-headers 2>/dev/null | awk '$3=="Running"' | wc -l | tr -d ' ')
      printf '%s  cpu%%=%s replicas=%s desired=%s running_pods=%s\n' "$(date +%H:%M:%S)" $hpa "$pods"
      sleep 5
    done
    ;;
  status)
    kubectl -n "$NS" get hpa chzzk
    kubectl -n "$NS" get pods -o wide
    kubectl -n "$NS" top pods || true
    ;;
  down)
    k3d cluster delete "$CLUSTER"
    ;;
  *)
    sed -n '2,9p' "$0"
    ;;
esac
