import type { Node } from '../../types.ts';
import { nodeKey } from '../../types.ts';

/**
 * Parse ss:// URI into internal Node.
 * Supports SIP002: ss://base64(method:password)@host:port#name
 * and legacy base64: ss://base64(method:password@host:port)#name
 */
export function parseSs(uri: string): Node | null {
  if (!uri.startsWith('ss://')) return null;
  try {
    // Strip fragment for name
    const hashIdx = uri.lastIndexOf('#');
    const name = hashIdx !== -1 ? decodeURIComponent(uri.slice(hashIdx + 1)) : '';
    const uriNoHash = hashIdx !== -1 ? uri.slice(0, hashIdx) : uri;

    // Try SIP002 format first: ss://userinfo@host:port
    const sip002Match = uriNoHash.match(/^ss:\/\/([A-Za-z0-9+/=]+)@([^:]+):(\d+)/);
    if (sip002Match) {
      const [, userB64, server, portStr] = sip002Match;
      const port = Number(portStr);
      const userDecoded = atob(userB64!);
      const colonIdx = userDecoded.indexOf(':');
      if (colonIdx === -1 || !server || !port) return null;
      const method = userDecoded.slice(0, colonIdx);
      const password = userDecoded.slice(colonIdx + 1);
      const key = nodeKey({ protocol: 'ss', server, port, credential: `${method}:${password}`, transportParams: '' });
      return {
        key,
        name: name || `${server}:${port}`,
        protocol: 'ss',
        server,
        port,
        raw: { method, password },
      };
    }

    // Legacy base64: ss://base64(method:password@host:port)
    const legacyMatch = uriNoHash.match(/^ss:\/\/([A-Za-z0-9+/=]+)$/);
    if (legacyMatch) {
      const decoded = atob(legacyMatch[1]!);
      // format: method:password@host:port
      const atIdx = decoded.lastIndexOf('@');
      if (atIdx === -1) return null;
      const userPart = decoded.slice(0, atIdx);
      const hostPart = decoded.slice(atIdx + 1);
      const colonIdx = userPart.indexOf(':');
      const lastColon = hostPart.lastIndexOf(':');
      if (colonIdx === -1 || lastColon === -1) return null;
      const method = userPart.slice(0, colonIdx);
      const password = userPart.slice(colonIdx + 1);
      const server = hostPart.slice(0, lastColon);
      const port = Number(hostPart.slice(lastColon + 1));
      if (!server || !port) return null;
      const key = nodeKey({ protocol: 'ss', server, port, credential: `${method}:${password}`, transportParams: '' });
      return {
        key,
        name: name || `${server}:${port}`,
        protocol: 'ss',
        server,
        port,
        raw: { method, password },
      };
    }

    return null;
  } catch {
    return null;
  }
}
