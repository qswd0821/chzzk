// CI·로컬 자동 확인용: 백엔드에 회원과 녹화방송(공개 mp4 URL)을 하나 만든다.
//   node client/scripts/seed-smoke.mjs http://127.0.0.1:3100
const base = (process.argv[2] || 'http://127.0.0.1:3100').replace(/\/$/, '');

for (let i = 0; i < 60; i++) {
  try {
    if ((await fetch(`${base}/healthz`)).ok) break;
  } catch {
    // 서버가 아직 뜨는 중
  }
  await new Promise((r) => setTimeout(r, 1000));
}

const signup = await fetch(`${base}/api/auth/signup`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ username: `smoke_${Date.now().toString(36)}`, password: 'smoke-test-pass', nickname: `자동확인${Date.now() % 10000}` }),
});
if (signup.status !== 201) throw new Error(`signup failed: ${signup.status}`);
const cookie = signup.headers.get('set-cookie').split(';')[0];

const form = new FormData();
form.append('title', '자동 확인용 녹화방송');
form.append('videoUrl', 'https://interactive-examples.mdn.mozilla.net/media/cc0-videos/flower.mp4');
const created = await fetch(`${base}/api/broadcasts`, { method: 'POST', headers: { cookie }, body: form });
if (created.status !== 201) throw new Error(`broadcast failed: ${created.status}`);
console.log('seeded', (await created.json()).id);
