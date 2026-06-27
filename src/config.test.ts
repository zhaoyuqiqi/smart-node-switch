import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { loadConfig } from './config.ts';
import { nodeKey } from './types.ts';
import type { Node, NodeView } from './types.ts';

describe('loadConfig', () => {
  const originalEnv = process.env;

  const CONFIG_ENV_KEYS = [
    'SUBSCRIPTION_URL',
    'CHECK_INTERVAL_SECONDS',
    'MAX_CONCURRENCY',
    'REFRESH_THRESHOLD',
    'REFRESH_COOLDOWN_SECONDS',
    'NODE_TTL_SECONDS',
    'DEATH_THRESHOLD',
    'REVIVAL_SECONDS',
    'TEST_URL',
    'PROBE_TIMEOUT_MS',
    'SINGBOX_BASE_PORT',
    'SINGBOX_BIN',
    'REDIS_URL',
    'PROXY_PORT',
    'PROXY_BIND_ADDRESS',
    'PROXY_PUBLIC_HOST',
    'CLASH_API_BASE_PORT',
    'CLASH_API_SECRET',
    'SINGBOX_INSTANCE_PORT_STRIDE',
    'SINGBOX_PROXY_INBOUND_OFFSET',
    'MAX_DRAIN_SECONDS',
    'INSTANCE_READY_TIMEOUT_MS',
  ];

  beforeEach(() => {
    // Start from a clean env so ambient values (e.g. an auto-loaded .env)
    // don't leak into the defaults assertions. Each test sets only what it needs.
    process.env = { ...originalEnv };
    for (const key of CONFIG_ENV_KEYS) delete process.env[key];
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
    expect(cfg.refreshCooldownSeconds).toBe(300);
    expect(cfg.nodeTtlSeconds).toBe(172800);
    expect(cfg.deathThreshold).toBe(20);
    expect(cfg.revivalSeconds).toBe(86400);
    expect(cfg.testUrl).toBe('https://www.google.com');
    expect(cfg.probeTimeoutMs).toBe(5000);
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

  it('loads new proxy/clash defaults', () => {
    process.env['SUBSCRIPTION_URL'] = 'https://example.com/sub';
    const cfg = loadConfig();
    expect(cfg.proxyPort).toBe(8080);
    expect(cfg.proxyBindAddress).toBe('0.0.0.0');
    expect(cfg.proxyPublicHost).toBe('');
    expect(cfg.clashApiBasePort).toBe(9090);
    expect(typeof cfg.clashApiSecret).toBe('string');
    expect(cfg.clashApiSecret.length).toBeGreaterThan(0);
    expect(cfg.singboxInstancePortStride).toBe(1000);
    expect(cfg.singboxProxyInboundOffset).toBe(0);
    expect(cfg.maxDrainSeconds).toBe(300);
    expect(cfg.instanceReadyTimeoutMs).toBe(8000);
  });

  it('overrides new proxy/clash config from env', () => {
    process.env['SUBSCRIPTION_URL'] = 'https://example.com/sub';
    process.env['PROXY_PORT'] = '18080';
    process.env['CLASH_API_SECRET'] = 'fixed-secret';
    process.env['MAX_DRAIN_SECONDS'] = '60';
    const cfg = loadConfig();
    expect(cfg.proxyPort).toBe(18080);
    expect(cfg.clashApiSecret).toBe('fixed-secret');
    expect(cfg.maxDrainSeconds).toBe(60);
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

describe('extended types', () => {
  it('Node carries originalUri', () => {
    const n: Node = { key: 'k', name: 'n', protocol: 'trojan', server: 's', port: 443, raw: {}, originalUri: 'trojan://x' };
    expect(n.originalUri).toBe('trojan://x');
  });

  it('NodeView carries raw and originalUri', () => {
    const v: NodeView = {
      key: 'k', name: 'n', protocol: 'trojan', server: 's', port: 443,
      latency: 1, failCount: 0, lastCheck: 1, score: 1,
      raw: { password: 'p' }, originalUri: 'trojan://x',
    };
    expect(v.raw['password']).toBe('p');
    expect(v.originalUri).toBe('trojan://x');
  });
});
