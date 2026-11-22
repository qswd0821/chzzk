// 부하 생성 (k6). 읽기 위주 요청 + 가끔 로그인(scrypt 라 CPU 를 쓴다).
//   클러스터 안 Job:  kubectl apply -k k8s/load       (BASE_URL 기본값: 서비스 주소)
//   PC 에서 직접:     docker run --rm -i -e BASE_URL=http://host.docker.internal:8080 grafana/k6 run - < k8s/load/k6-chzzk.js
// 환경변수: BASE_URL, VUS(기본 50), HOLD(최대 부하 유지 시간, 기본 2m)
import http from 'k6/http';
import { check, sleep } from 'k6';
import { Counter } from 'k6/metrics';

const BASE = __ENV.BASE_URL || 'http://chzzk.chzzk.svc.cluster.local';
const VUS = Number(__ENV.VUS || 50);

// 어느 인스턴스가 응답했는지 센다(X-Instance 헤더) → 요청이 여러 파드로 나뉘는지 확인
const byInstance = new Counter('chzzk_responses_by_instance');

export const options = {
  stages: [
    { duration: '30s', target: VUS },
    { duration: __ENV.HOLD || '2m', target: VUS },
    { duration: '20s', target: 0 },
  ],
  thresholds: {
    http_req_failed: ['rate<0.05'],
  },
  summaryTrendStats: ['avg', 'p(95)', 'max'],
};

// 부하용 회원 하나를 만든다(이미 있으면 로그인만).
export function setup() {
  const username = `load_${Date.now().toString(36)}`;
  const password = 'load-test-password';
  const res = http.post(`${BASE}/api/auth/signup`, JSON.stringify({ username, password, nickname: `부하${username.slice(-6)}` }), {
    headers: { 'Content-Type': 'application/json' },
  });
  check(res, { 'signup 201': (r) => r.status === 201 });
  return { username, password };
}

export default function (user) {
  const responses = http.batch([
    ['GET', `${BASE}/api/broadcasts`],
    ['GET', `${BASE}/api/lives`],
    ['GET', `${BASE}/healthz`],
  ]);
  for (const r of responses) byInstance.add(1, { instance: r.headers['X-Instance'] || 'unknown' });
  check(responses[0], { 'broadcasts 200': (r) => r.status === 200 });
  check(responses[1], { 'lives 200': (r) => r.status === 200 });

  // 열 번에 한 번꼴로 로그인 (세션은 공유 DB 에 저장되어 어느 파드에서든 유효)
  if (Math.random() < 0.1) {
    const login = http.post(`${BASE}/api/auth/login`, JSON.stringify({ username: user.username, password: user.password }), {
      headers: { 'Content-Type': 'application/json' },
    });
    check(login, { 'login 200': (r) => r.status === 200 });
  }
  sleep(0.2);
}
