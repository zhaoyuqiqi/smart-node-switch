import type { Node } from '../types.ts';

/**
 * Map internal Node to sing-box outbound JSON object.
 */
export function toOutbound(node: Node): Record<string, unknown> {
  const tag = `out-${node.key}`;

  switch (node.protocol) {
    case 'trojan': {
      const raw = node.raw;
      const out: Record<string, unknown> = {
        type: 'trojan',
        tag,
        server: node.server,
        server_port: node.port,
        password: raw['password'],
        tls: {
          enabled: true,
          server_name: raw['sni'] ?? node.server,
          insecure: raw['allowInsecure'] === true,
          ...(raw['fp'] ? { utls: { enabled: true, fingerprint: raw['fp'] } } : {}),
        },
      };

      // WebSocket transport
      if (raw['type'] === 'ws') {
        out['transport'] = {
          type: 'ws',
          path: raw['path'] || '/',
          headers: raw['host'] ? { Host: raw['host'] } : undefined,
        };
      } else if (raw['type'] === 'grpc') {
        out['transport'] = { type: 'grpc' };
      }

      return out;
    }

    case 'vmess': {
      const raw = node.raw;
      const transport: Record<string, unknown> = {};
      if (raw['network'] === 'ws') {
        transport['type'] = 'ws';
        if (raw['wsPath']) transport['path'] = raw['wsPath'];
        if (raw['wsHost']) transport['headers'] = { Host: raw['wsHost'] };
      } else if (raw['network'] === 'grpc') {
        transport['type'] = 'grpc';
      }

      const out: Record<string, unknown> = {
        type: 'vmess',
        tag,
        server: node.server,
        server_port: node.port,
        uuid: raw['uuid'],
        alter_id: raw['alterId'] ?? 0,
        security: 'auto',
      };

      if (raw['tls']) {
        out['tls'] = {
          enabled: true,
          server_name: raw['sni'] ?? node.server,
        };
      }

      if (Object.keys(transport).length > 0) {
        out['transport'] = transport;
      }

      return out;
    }

    case 'ss': {
      const raw = node.raw;
      return {
        type: 'shadowsocks',
        tag,
        server: node.server,
        server_port: node.port,
        method: raw['method'],
        password: raw['password'],
      };
    }

    case 'vless': {
      const raw = node.raw;
      const out: Record<string, unknown> = {
        type: 'vless',
        tag,
        server: node.server,
        server_port: node.port,
        uuid: raw['uuid'],
        flow: raw['flow'] || undefined,
      };

      const security = raw['security'];
      if (security === 'tls' || security === 'reality') {
        const tls: Record<string, unknown> = {
          enabled: true,
          server_name: raw['sni'] ?? node.server,
        };
        if (security === 'reality') {
          tls['reality'] = {
            enabled: true,
            public_key: raw['pbk'],
            short_id: raw['sid'],
          };
          if (raw['fp']) tls['utls'] = { enabled: true, fingerprint: raw['fp'] };
        }
        out['tls'] = tls;
      }

      const netType = raw['type'];
      if (netType === 'ws') {
        out['transport'] = {
          type: 'ws',
          path: raw['wsPath'] || '/',
          headers: raw['wsHost'] ? { Host: raw['wsHost'] } : undefined,
        };
      } else if (netType === 'grpc') {
        out['transport'] = { type: 'grpc' };
      }

      return out;
    }
  }
}
