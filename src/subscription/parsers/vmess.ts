import type { Node } from '../../types.ts';
import { nodeKey } from '../../types.ts';

interface VmessConfig {
  v?: string;
  ps?: string;
  add?: string;
  port?: string | number;
  id?: string;
  aid?: string | number;
  net?: string;
  type?: string;
  host?: string;
  path?: string;
  tls?: string;
  sni?: string;
}

/**
 * Parse vmess:// URI into internal Node.
 * Format: vmess://base64(json)
 */
export function parseVmess(uri: string): Node | null {
  if (!uri.startsWith('vmess://')) return null;
  try {
    const b64 = uri.slice('vmess://'.length);
    const json = atob(b64);
    const cfg = JSON.parse(json) as VmessConfig;

    const server = cfg.add;
    const port = Number(cfg.port);
    const uuid = cfg.id;
    if (!server || !port || !uuid) return null;

    const net = cfg.net ?? 'tcp';
    const transportParams = [net, cfg.host ?? '', cfg.path ?? ''].join('|');
    const key = nodeKey({ protocol: 'vmess', server, port, credential: uuid, transportParams });
    const name = cfg.ps || `${server}:${port}`;

    return {
      key,
      name,
      protocol: 'vmess',
      server,
      port,
      originalUri: uri,
      raw: {
        uuid,
        alterId: Number(cfg.aid ?? 0),
        network: net,
        tls: cfg.tls === 'tls',
        sni: cfg.sni ?? cfg.host ?? '',
        wsPath: cfg.path ?? '',
        wsHost: cfg.host ?? '',
        type: cfg.type ?? 'none',
      },
    };
  } catch {
    return null;
  }
}
