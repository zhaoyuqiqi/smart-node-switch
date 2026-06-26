export interface Node {
  key: string;
  name: string;
  protocol: 'trojan' | 'vmess' | 'ss' | 'vless';
  server: string;
  port: number;
  raw: Record<string, unknown>;
}

export interface NodeState {
  latency: number;
  failCount: number;
  successCount: number;
  lastCheck: number;
  // display redundancy
  name: string;
  protocol: string;
  server: string;
  port: number;
}

export interface NodeView {
  key: string;
  name: string;
  protocol: string;
  server: string;
  port: number;
  latency: number;
  failCount: number;
  lastCheck: number;
  score: number;
}

export interface Config {
  subscriptionUrl: string;
  checkIntervalSeconds: number;
  maxConcurrency: number;
  refreshThreshold: number;
  refreshCooldownSeconds: number;
  nodeTtlSeconds: number;
  deathThreshold: number;
  revivalSeconds: number;
  testUrl: string;
  probeTimeoutMs: number;
  singboxBasePort: number;
  singboxBin: string;
  redisUrl: string;
}

// Redis key helpers
export const stateKey = (key: string) => `node:${key}`;
export const deadKey = (key: string) => `dead:${key}`;

// Generate node identity key: sha1(protocol|server|port|credential|transportParams).slice(0,16)
export function nodeKey(params: {
  protocol: string;
  server: string;
  port: number;
  credential: string;
  transportParams: string;
}): string {
  const raw = `${params.protocol}|${params.server}|${params.port}|${params.credential}|${params.transportParams}`;
  const hasher = new Bun.CryptoHasher('sha1');
  hasher.update(raw);
  return hasher.digest('hex').slice(0, 16);
}
