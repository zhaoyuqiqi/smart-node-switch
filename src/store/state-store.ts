import type { NodeState } from '../types.ts';
import { stateKey, deadKey } from '../types.ts';
import Redis from 'ioredis';

export interface StateStore {
  getState(key: string): Promise<NodeState | null>;
  setState(key: string, state: NodeState, ttlSeconds: number): Promise<void>;
  renewTtl(key: string, ttlSeconds: number): Promise<void>;
  isDead(key: string): Promise<boolean>;
  markDead(key: string, ttlSeconds: number): Promise<void>;
  clearDead(key: string): Promise<void>;
}

function parseState(hash: Record<string, string>): NodeState {
  return {
    latency: Number(hash['latency'] ?? 0),
    failCount: Number(hash['failCount'] ?? 0),
    successCount: Number(hash['successCount'] ?? 0),
    lastCheck: Number(hash['lastCheck'] ?? 0),
    name: hash['name'] ?? '',
    protocol: hash['protocol'] ?? '',
    server: hash['server'] ?? '',
    port: Number(hash['port'] ?? 0),
  };
}

export class RedisStateStore implements StateStore {
  constructor(private readonly redis: Redis) {}

  async getState(key: string): Promise<NodeState | null> {
    const hash = await this.redis.hgetall(stateKey(key));
    if (!hash || Object.keys(hash).length === 0) return null;
    // Renew TTL on read
    await this.redis.expire(stateKey(key), 172800);
    return parseState(hash);
  }

  async setState(key: string, state: NodeState, ttlSeconds: number): Promise<void> {
    const sk = stateKey(key);
    await this.redis.hset(sk, {
      latency: String(state.latency),
      failCount: String(state.failCount),
      successCount: String(state.successCount),
      lastCheck: String(state.lastCheck),
      name: state.name,
      protocol: state.protocol,
      server: state.server,
      port: String(state.port),
    });
    await this.redis.expire(sk, ttlSeconds);
  }

  async renewTtl(key: string, ttlSeconds: number): Promise<void> {
    await this.redis.expire(stateKey(key), ttlSeconds);
  }

  async isDead(key: string): Promise<boolean> {
    return (await this.redis.exists(deadKey(key))) > 0;
  }

  async markDead(key: string, ttlSeconds: number): Promise<void> {
    await this.redis.set(deadKey(key), '1', 'EX', ttlSeconds);
  }

  async clearDead(key: string): Promise<void> {
    await this.redis.del(deadKey(key));
  }

  quit(): Promise<string> {
    return this.redis.quit();
  }
}

export function createRedisStore(redisUrl: string): RedisStateStore {
  const redis = new Redis(redisUrl, { lazyConnect: true });
  return new RedisStateStore(redis);
}
