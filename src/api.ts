import { Elysia } from 'elysia';
import type { Monitor } from './monitor.ts';
import type { NodeView } from './types.ts';

export interface ProxyInfo { publicHost: string; port: number; }

function toView(node: {
  key: string;
  name: string;
  protocol: string;
  server: string;
  port: number;
  raw: Record<string, unknown>;
  originalUri: string;
}, bestKey: string | null): NodeView {
  return {
    key: node.key,
    name: node.name,
    protocol: node.protocol,
    server: node.server,
    port: node.port,
    isBest: bestKey === node.key,
    raw: node.raw,
    originalUri: node.originalUri,
  };
}

export function registerRoutes(
  app: Elysia,
  monitor: Monitor,
  proxyInfo?: ProxyInfo,
): Elysia {
  app.get('/nodes', async () => {
    const nodes = monitor.getNodes();
    const bestKey = monitor.getBestKey();
    const result: NodeView[] = nodes.map((node) => toView(node, bestKey));
    return { count: result.length, nodes: result };
  });

  app.get('/nodes/best', async () => {
    const best = monitor.getBestNode();
    if (!best) return { best: null };
    return { best: toView(best, best.key) };
  });

  app.get('/proxy', async ({ request, set }) => {
    const best = monitor.getBestNode();
    if (!best) {
      set.status = 503;
      return {
        proxy: null,
        node: null,
        reason: 'no available node from urltest',
      };
    }

    const port = proxyInfo?.port ?? 8080;
    let host = proxyInfo?.publicHost ?? '';
    if (!host) {
      try { host = new URL(request.url).hostname || '127.0.0.1'; }
      catch { host = '127.0.0.1'; }
    }
    return { proxy: `http://${host}:${port}`, node: toView(best, best.key) };
  });

  return app;
}
