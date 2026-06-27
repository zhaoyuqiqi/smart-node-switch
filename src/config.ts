import type { Config } from './types.ts';

export function loadConfig(): Config {
  const subscriptionUrl = process.env['SUBSCRIPTION_URL'];
  if (!subscriptionUrl) {
    throw new Error('SUBSCRIPTION_URL is required but not set');
  }

  return {
    subscriptionUrl,
    checkIntervalSeconds: Number(process.env['CHECK_INTERVAL_SECONDS'] ?? 30),
    maxConcurrency: Number(process.env['MAX_CONCURRENCY'] ?? 10),
    refreshThreshold: Number(process.env['REFRESH_THRESHOLD'] ?? 0.1),
    refreshCooldownSeconds: Number(process.env['REFRESH_COOLDOWN_SECONDS'] ?? 300),
    nodeTtlSeconds: Number(process.env['NODE_TTL_SECONDS'] ?? 172800),
    deathThreshold: Number(process.env['DEATH_THRESHOLD'] ?? 20),
    revivalSeconds: Number(process.env['REVIVAL_SECONDS'] ?? 86400),
    testUrl: process.env['TEST_URL'] ?? 'http://www.gstatic.com/generate_204',
    probeTimeoutMs: Number(process.env['PROBE_TIMEOUT_MS'] ?? 5000),
    singboxBasePort: Number(process.env['SINGBOX_BASE_PORT'] ?? 30000),
    singboxBin: process.env['SINGBOX_BIN'] ?? 'src/sing-box/sing-box',
    redisUrl: process.env['REDIS_URL'] ?? 'redis://127.0.0.1:6379',
    proxyPort: Number(process.env['PROXY_PORT'] ?? 8080),
    proxyBindAddress: process.env['PROXY_BIND_ADDRESS'] ?? '0.0.0.0',
    proxyPublicHost: process.env['PROXY_PUBLIC_HOST'] ?? '',
    clashApiBasePort: Number(process.env['CLASH_API_BASE_PORT'] ?? 9090),
    clashApiSecret:
      process.env['CLASH_API_SECRET'] ?? crypto.randomUUID().replace(/-/g, ''),
    singboxInstancePortStride: Number(process.env['SINGBOX_INSTANCE_PORT_STRIDE'] ?? 1000),
    singboxProxyInboundOffset: Number(process.env['SINGBOX_PROXY_INBOUND_OFFSET'] ?? 0),
    maxDrainSeconds: Number(process.env['MAX_DRAIN_SECONDS'] ?? 300),
    instanceReadyTimeoutMs: Number(process.env['INSTANCE_READY_TIMEOUT_MS'] ?? 8000),
  };
}
