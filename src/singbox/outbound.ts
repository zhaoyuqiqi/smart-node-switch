import type { Node } from '../types.ts';

function normalizeWsPathAndEarlyData(pathValue: unknown): {
  path: string;
  maxEarlyData: number | null;
} {
  if (typeof pathValue !== 'string' || pathValue.length === 0) {
    return { path: '/', maxEarlyData: null };
  }

  const qIndex = pathValue.indexOf('?');
  const rawPath = qIndex >= 0 ? pathValue.slice(0, qIndex) : pathValue;
  const rawQuery = qIndex >= 0 ? pathValue.slice(qIndex + 1) : '';
  const query = new URLSearchParams(rawQuery);
  const ed = query.get('ed');
  query.delete('ed');

  const pathBase = rawPath.length > 0 ? rawPath : '/';
  const queryLeft = query.toString();
  const normalizedPath = queryLeft ? `${pathBase}?${queryLeft}` : pathBase;

  if (!ed) return { path: normalizedPath, maxEarlyData: null };
  const value = Number(ed);
  if (!Number.isFinite(value) || value <= 0) {
    return { path: normalizedPath, maxEarlyData: null };
  }
  return { path: normalizedPath, maxEarlyData: Math.floor(value) };
}

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
        const ws = normalizeWsPathAndEarlyData(raw['path']);
        out['transport'] = {
          type: 'ws',
          path: ws.path,
          headers: raw['host'] ? { Host: raw['host'] } : undefined,
          ...(ws.maxEarlyData ? {
            max_early_data: ws.maxEarlyData,
            early_data_header_name: 'Sec-WebSocket-Protocol',
          } : {}),
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
        if (raw['wsPath']) {
          const ws = normalizeWsPathAndEarlyData(raw['wsPath']);
          transport['path'] = ws.path;
          if (ws.maxEarlyData) {
            transport['max_early_data'] = ws.maxEarlyData;
            transport['early_data_header_name'] = 'Sec-WebSocket-Protocol';
          }
        }
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
        const ws = normalizeWsPathAndEarlyData(raw['wsPath']);
        out['transport'] = {
          type: 'ws',
          path: ws.path,
          headers: raw['wsHost'] ? { Host: raw['wsHost'] } : undefined,
          ...(ws.maxEarlyData ? {
            max_early_data: ws.maxEarlyData,
            early_data_header_name: 'Sec-WebSocket-Protocol',
          } : {}),
        };
      } else if (netType === 'grpc') {
        out['transport'] = { type: 'grpc' };
      }

      return out;
    }
  }
}
