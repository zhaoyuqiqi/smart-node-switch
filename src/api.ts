import { Elysia } from 'elysia';
import type { Monitor } from './monitor.ts';
import type { StateStore } from './store/state-store.ts';
import { score } from './scoring.ts';
import type { NodeView } from './types.ts';

export function registerRoutes(app: Elysia, monitor: Monitor, store: StateStore): Elysia {
  // GET /nodes — return all available nodes (failCount===0 && lastCheck>0 && not dead)
  app.get('/nodes', async () => {
    const nodes = monitor.getNodes();
    const now = Date.now();
    const result: NodeView[] = [];

    for (const node of nodes) {
      if (await store.isDead(node.key)) continue;
      const state = await store.getState(node.key);
      if (!state || state.lastCheck === 0 || state.failCount !== 0) continue;

      result.push({
        key: node.key,
        name: node.name,
        protocol: node.protocol,
        server: node.server,
        port: node.port,
        latency: state.latency,
        failCount: state.failCount,
        lastCheck: state.lastCheck,
        score: score(state, now),
      });
    }

    return { count: result.length, nodes: result };
  });

  // GET /nodes/best — return the node with the lowest score
  app.get('/nodes/best', async () => {
    const nodes = monitor.getNodes();
    const now = Date.now();
    let best: NodeView | null = null;
    let bestScore = Infinity;

    for (const node of nodes) {
      if (await store.isDead(node.key)) continue;
      const state = await store.getState(node.key);
      if (!state || state.lastCheck === 0 || state.failCount !== 0) continue;

      const s = score(state, now);
      if (s < bestScore) {
        bestScore = s;
        best = {
          key: node.key,
          name: node.name,
          protocol: node.protocol,
          server: node.server,
          port: node.port,
          latency: state.latency,
          failCount: state.failCount,
          lastCheck: state.lastCheck,
          score: s,
        };
      }
    }

    return { best };
  });

  return app;
}
