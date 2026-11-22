import { createClient } from 'redis';

// 인스턴스 사이의 실시간 상태(docs/adr/0003).
//   publish/subscribe: 라이브 시그널링·댓글·후원·종료 알림을 모든 인스턴스로 보낸다(보낸 인스턴스 자신도 받는다).
//   setPresence/hasPresence: TTL 이 있는 표시. "송출자가 지금 어느 인스턴스엔가 붙어 있다"를 나타낸다.
// REDIS_URL 이 있으면 Redis, 없으면 같은 인터페이스의 메모리 버스(단일 인스턴스·테스트).
export async function createBus({ redisUrl, prefix = 'chzzk:' } = {}) {
  return redisUrl ? createRedisBus(redisUrl, prefix) : createMemoryBus();
}

export function createMemoryBus() {
  const handlers = new Map(); // channel → Set<handler>
  const presence = new Map(); // key → { value, expiresAt }

  const alive = (key) => {
    const entry = presence.get(key);
    if (entry && entry.expiresAt > Date.now()) return entry;
    presence.delete(key);
    return null;
  };

  return {
    kind: 'memory',
    async publish(channel, message) {
      // Redis 처럼 비동기로 전달한다(보낸 쪽 코드가 끝난 뒤 도착).
      const payload = JSON.stringify(message);
      for (const handler of handlers.get(channel) ?? []) queueMicrotask(() => handler(JSON.parse(payload)));
    },
    async subscribe(channel, handler) {
      if (!handlers.has(channel)) handlers.set(channel, new Set());
      handlers.get(channel).add(handler);
    },
    async setPresence(key, value, ttlMs) {
      presence.set(key, { value: String(value), expiresAt: Date.now() + ttlMs });
    },
    async getPresence(key) {
      return alive(key)?.value ?? null;
    },
    async deletePresence(key, onlyIfValue) {
      const entry = alive(key);
      if (entry && (onlyIfValue === undefined || entry.value === String(onlyIfValue))) presence.delete(key);
    },
    async ping() {
      return true;
    },
    async close() {
      handlers.clear();
      presence.clear();
    },
  };
}

async function createRedisBus(url, prefix) {
  const client = createClient({ url });
  const subscriber = client.duplicate();
  for (const c of [client, subscriber]) c.on('error', (err) => console.error('[redis]', err.message));
  await Promise.all([client.connect(), subscriber.connect()]);

  return {
    kind: 'redis',
    async publish(channel, message) {
      await client.publish(prefix + channel, JSON.stringify(message));
    },
    async subscribe(channel, handler) {
      await subscriber.subscribe(prefix + channel, (raw) => {
        try {
          handler(JSON.parse(raw));
        } catch (err) {
          console.error('[bus] handler error', err);
        }
      });
    },
    async setPresence(key, value, ttlMs) {
      await client.set(prefix + key, String(value), { PX: ttlMs });
    },
    async getPresence(key) {
      return client.get(prefix + key);
    },
    // onlyIfValue 가 있으면 그 값일 때만 지운다(다른 연결이 이미 덮어쓴 표시는 건드리지 않음).
    async deletePresence(key, onlyIfValue) {
      if (onlyIfValue === undefined) {
        await client.del(prefix + key);
        return;
      }
      await client.eval(
        "if redis.call('GET', KEYS[1]) == ARGV[1] then return redis.call('DEL', KEYS[1]) else return 0 end",
        { keys: [prefix + key], arguments: [String(onlyIfValue)] },
      );
    },
    async ping() {
      return (await client.ping()) === 'PONG';
    },
    async close() {
      await Promise.allSettled([subscriber.quit(), client.quit()]);
    },
  };
}
