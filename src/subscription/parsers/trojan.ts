import type { Node } from '../../types.ts';
import { nodeKey } from '../../types.ts';

/**
 * Parse trojan:// URI into internal Node.
 * Format: trojan://password@host:port?params#name
 */
export function parseTrojan(uri: string): Node | null {
  if (!uri.startsWith('trojan://')) return null;
  try {
    const url = new URL(uri);
    const password = decodeURIComponent(url.username);
    const server = url.hostname;
    const port = Number(url.port);
    if (!password || !server || !port) return null;

    const transportParams = url.searchParams.toString();
    const key = nodeKey({ protocol: 'trojan', server, port, credential: password, transportParams });
    const name = decodeURIComponent(url.hash.slice(1)) || `${server}:${port}`;

    return {
      key,
      name,
      protocol: 'trojan',
      server,
      port,
      raw: {
        password,
        sni: url.searchParams.get('sni') ?? url.searchParams.get('peer') ?? server,
        allowInsecure: url.searchParams.get('allowInsecure') === '1',
        type: url.searchParams.get('type') ?? 'tcp',
        ...Object.fromEntries(url.searchParams.entries()),
      },
    };
  } catch {
    return null;
  }
}
