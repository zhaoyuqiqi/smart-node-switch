/**
 * 清除 Redis 中所有 dead key，让节点重新接受探测
 * 用法: bun run scripts/clear-dead.ts
 */
import Redis from 'ioredis';

const redisUrl = process.env['REDIS_URL'] ?? 'redis://127.0.0.1:6379';
const redis = new Redis(redisUrl);

const pattern = 'dead:*';
let cursor = '0';
let totalDeleted = 0;

console.log(`[clear-dead] connecting to Redis...`);
console.log(`[clear-dead] scanning pattern: ${pattern}`);

do {
  const [nextCursor, keys] = await redis.scan(cursor, 'MATCH', pattern, 'COUNT', 100);
  cursor = nextCursor;
  if (keys.length > 0) {
    await redis.del(...keys);
    totalDeleted += keys.length;
    console.log(`[clear-dead] deleted ${keys.length} keys: ${keys.join(', ')}`);
  }
} while (cursor !== '0');

console.log(`[clear-dead] done. total deleted: ${totalDeleted} dead keys`);
await redis.quit();
