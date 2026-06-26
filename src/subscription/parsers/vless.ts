import type { Node } from '../../types.ts';
import { nodeKey } from '../../types.ts';

/**
 * Parse vless:// URI into internal Node.
 * Format: vless://uuid@host:port?params#name
 */
export function parseVless(uri: string): Node | null {
  if (!uri.startsWith('vless://')) return null;
  try {
    const url = new URL(uri);
    const uuid = decodeURIComponent(url.username);
    const server = url.hostname;
    const port = Number(url.port);
    if (!uuid || !server || !port) return null;

    const transportParams = url.searchParams.toString();
    const key = nodeKey({ protocol: 'vless', server, port, credential: uuid, transportParams });
    const name = decodeURIComponent(url.hash.slice(1)) || `${server}:${port}`;

    return {
      key,
      name,
      protocol: 'vless',
      server,
      port,
      raw: {
        uuid,
        flow: url.searchParams.get('flow') ?? '',
        encryption: url.searchParams.get('encryption') ?? 'none',
        type: url.searchParams.get('type') ?? 'tcp',
        security: url.searchParams.get('security') ?? '',
        sni: url.searchParams.get('sni') ?? server,
        fp: url.searchParams.get('fp') ?? '',
        pbk: url.searchParams.get('pbk') ?? '',
        sid: url.searchParams.get('sid') ?? '',
        wsPath: url.searchParams.get('path') ?? '',
        wsHost: url.searchParams.get('host') ?? '',
      },
    };
  } catch {
    return null;
  }
}
