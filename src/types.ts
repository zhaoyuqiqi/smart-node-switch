export interface Node {
  key: string;
  name: string;
  protocol: 'trojan' | 'vmess' | 'ss' | 'vless';
  server: string;
  port: number;
  raw: Record<string, unknown>;
  originalUri: string;
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
  isBest: boolean;
  raw: Record<string, unknown>;
  originalUri: string;
}

export interface Config {
  subscriptionUrl: string;
  checkIntervalSeconds: number;
  refreshThreshold: number;
  refreshCooldownSeconds: number;
  testUrl: string;
  singboxBasePort: number;
  singboxBin: string;
  proxyPort: number;
  proxyBindAddress: string;
  proxyPublicHost: string;
  clashApiBasePort: number;
  clashApiSecret: string;
  singboxInstancePortStride: number;
  singboxProxyInboundOffset: number;
  maxDrainSeconds: number;
  instanceReadyTimeoutMs: number;
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
