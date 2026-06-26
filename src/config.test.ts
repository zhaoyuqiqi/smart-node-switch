import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { loadConfig } from './config.ts';
import { nodeKey } from './types.ts';

describe('loadConfig', () => {
  const originalEnv = process.env;

  beforeEach(() => {
    process.env = { ...originalEnv };
    delete process.env['SUBSCRIPTION_URL'];
  });

  afterEach(() => {
    process.env = originalEnv;
  });

  it('throws when SUBSCRIPTION_URL is missing', () => {
    expect(() => loadConfig()).toThrow('SUBSCRIPTION_URL is required');
  });

  it('loads config with defaults', () => {
    process.env['SUBSCRIPTION_URL'] = 'https://example.com/sub';
    const cfg = loadConfig();
    expect(cfg.subscriptionUrl).toBe('https://example.com/sub');
    expect(cfg.checkIntervalSeconds).toBe(30);
    expect(cfg.maxConcurrency).toBe(10);
    expect(cfg.refreshThreshold).toBe(0.1);
    expect(cfg.nodeTtlSeconds).toBe(172800);
    expect(cfg.deathThreshold).toBe(20);
    expect(cfg.revivalSeconds).toBe(86400);
    expect(cfg.singboxBasePort).toBe(30000);
    expect(cfg.singboxBin).toBe('src/sing-box/sing-box');
    expect(cfg.redisUrl).toBe('redis://127.0.0.1:6379');
  });

  it('overrides defaults from env', () => {
    process.env['SUBSCRIPTION_URL'] = 'https://example.com/sub';
    process.env['CHECK_INTERVAL_SECONDS'] = '60';
    process.env['MAX_CONCURRENCY'] = '5';
    process.env['DEATH_THRESHOLD'] = '10';
    const cfg = loadConfig();
    expect(cfg.checkIntervalSeconds).toBe(60);
    expect(cfg.maxConcurrency).toBe(5);
    expect(cfg.deathThreshold).toBe(10);
  });
});

describe('nodeKey', () => {
  it('generates a 16-char hex key', () => {
    const key = nodeKey({ protocol: 'trojan', server: 'example.com', port: 443, credential: 'secret', transportParams: '' });
    expect(key).toHaveLength(16);
    expect(/^[0-9a-f]+$/.test(key)).toBe(true);
  });

  it('is stable for the same input', () => {
    const params = { protocol: 'vmess', server: '1.2.3.4', port: 8080, credential: 'uuid-xxx', transportParams: 'ws' };
    expect(nodeKey(params)).toBe(nodeKey(params));
  });

  it('differs for different inputs', () => {
    const a = nodeKey({ protocol: 'trojan', server: 'a.com', port: 443, credential: 'x', transportParams: '' });
    const b = nodeKey({ protocol: 'trojan', server: 'b.com', port: 443, credential: 'x', transportParams: '' });
    expect(a).not.toBe(b);
  });

  it('ignores name in key computation (name not passed)', () => {
    // same connection params → same key regardless of what name would be
    const k1 = nodeKey({ protocol: 'ss', server: 's.com', port: 8388, credential: 'pass', transportParams: '' });
    const k2 = nodeKey({ protocol: 'ss', server: 's.com', port: 8388, credential: 'pass', transportParams: '' });
    expect(k1).toBe(k2);
  });
});
