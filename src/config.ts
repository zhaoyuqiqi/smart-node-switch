import type { Config } from './types.ts';

// Generated once per process; stable across multiple loadConfig() calls.
const DEFAULT_CLASH_SECRET = crypto.randomUUID().replace(/-/g, '');
const DEFAULT_SINGBOX_BIN =
  process.platform === 'darwin' ? 'src/sing-box/sing-box-mac' : 'src/sing-box/sing-box-linux';

export function loadConfig(): Config {
  const subscriptionUrl = process.env['SUBSCRIPTION_URL'];
  if (!subscriptionUrl) {
    throw new Error('SUBSCRIPTION_URL is required but not set');
  }

  const debugMonitor = process.env['DEBUG_MONITOR'] === '1' || process.env['DEBUG_MONITOR'] === 'true';

  return {
    subscriptionUrl,
    checkIntervalSeconds: Number(process.env['CHECK_INTERVAL_SECONDS'] ?? 60),
    refreshThreshold: Number(process.env['REFRESH_THRESHOLD'] ?? 0.1),
    refreshCooldownSeconds: Number(process.env['REFRESH_COOLDOWN_SECONDS'] ?? 300),
    testUrl: process.env['TEST_URL'] ?? 'https://cp.cloudflare.com',
    urltestInterval: process.env['URLTEST_INTERVAL'] ?? '3m',
    singboxBasePort: Number(process.env['SINGBOX_BASE_PORT'] ?? 30000),
    singboxBin: process.env['SINGBOX_BIN'] ?? DEFAULT_SINGBOX_BIN,
    proxyPort: Number(process.env['PROXY_PORT'] ?? 8080),
    proxyBindAddress: process.env['PROXY_BIND_ADDRESS'] ?? '0.0.0.0',
    proxyPublicHost: process.env['PROXY_PUBLIC_HOST'] ?? '',
    clashApiBasePort: Number(process.env['CLASH_API_BASE_PORT'] ?? 9090),
    clashApiBindAddress: process.env['CLASH_API_BIND_ADDRESS'] ?? '127.0.0.1',
    clashApiSecret: process.env['CLASH_API_SECRET'] ?? DEFAULT_CLASH_SECRET,
    singboxInstancePortStride: Number(process.env['SINGBOX_INSTANCE_PORT_STRIDE'] ?? 1000),
    singboxProxyInboundOffset: Number(process.env['SINGBOX_PROXY_INBOUND_OFFSET'] ?? 0),
    maxDrainSeconds: Number(process.env['MAX_DRAIN_SECONDS'] ?? 300),
    instanceReadyTimeoutMs: Number(process.env['INSTANCE_READY_TIMEOUT_MS'] ?? 8000),
    proxyAuthUser: process.env['PROXY_AUTH_USER'] ?? '',
    proxyAuthPass: process.env['PROXY_AUTH_PASS'] ?? '',
    debugMonitor,
  };
}
