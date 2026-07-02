import type Redis from 'ioredis';
import type { NodeStatistics } from './types.ts';

export interface NodeMetricsStoreOptions {
  redis: Redis;
  keyPrefix?: string;
  ttlSeconds?: number;
  maxSamples?: number;
}

export class NodeMetricsStore {
  private readonly keyPrefix: string;
  private readonly ttlSeconds: number;
  private readonly maxSamples: number;

  constructor(private readonly opts: NodeMetricsStoreOptions) {
    this.keyPrefix = opts.keyPrefix ?? 'sns:node-metrics';
    this.ttlSeconds = opts.ttlSeconds ?? 6 * 60 * 60;
    this.maxSamples = opts.maxSamples ?? 100;
  }

  private listKey(nodeKey: string): string {
    return `${this.keyPrefix}:node:${nodeKey}:rtt:list`;
  }

  private hashKey(nodeKey: string): string {
    return `${this.keyPrefix}:node:${nodeKey}:stats:hash`;
  }

  async readRecentSamples(nodeKey: string): Promise<number[]> {
    const listKey = this.listKey(nodeKey);
    const hashKey = this.hashKey(nodeKey);

    const raw = await this.opts.redis.lrange(listKey, -this.maxSamples, -1);

    const pipeline = this.opts.redis.pipeline();
    pipeline.expire(listKey, this.ttlSeconds);
    pipeline.expire(hashKey, this.ttlSeconds);
    await pipeline.exec();

    return raw
      .map((v) => Number(v))
      .filter((v) => Number.isFinite(v))
      .slice(-this.maxSamples);
  }

  async record(nodeKey: string, rtt: number, stats: NodeStatistics, score: number): Promise<void> {
    const listKey = this.listKey(nodeKey);
    const hashKey = this.hashKey(nodeKey);

    const pipeline = this.opts.redis.pipeline();
    pipeline.rpush(listKey, String(rtt));
    pipeline.ltrim(listKey, -this.maxSamples, -1);
    pipeline.expire(listKey, this.ttlSeconds);

    pipeline.hset(hashKey, {
      currentRtt: String(stats.currentRtt),
      avgRtt: String(stats.avgRtt),
      medianRtt: String(stats.medianRtt),
      p95Rtt: String(stats.p95Rtt),
      jitter: String(stats.jitter),
      successRate: String(stats.successRate),
      consecutiveFailure: String(stats.consecutiveFailure),
      sampleCount: String(stats.sampleCount),
      score: String(score),
    });
    pipeline.expire(hashKey, this.ttlSeconds);

    await pipeline.exec();
  }
}
