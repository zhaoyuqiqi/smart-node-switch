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

    // Parallel fetch: isDead + getState for all nodes simultaneously
    const entries = await Promise.all(
      nodes.map(async (node) => {
        const [dead, state] = await Promise.all([store.isDead(node.key), store.getState(node.key)]);
        return { node, dead, state };
      }),
    );

    const result: NodeView[] = entries
      .filter(({ dead, state }) => !dead && state && state.lastCheck > 0 && state.failCount === 0)
      .map(({ node, state }) => ({
        key: node.key,
        name: node.name,
        protocol: node.protocol,
        server: node.server,
        port: node.port,
        latency: state!.latency,
        failCount: state!.failCount,
        lastCheck: state!.lastCheck,
        score: score(state!, now),
      }));

    return { count: result.length, nodes: result };
  });

  // GET /nodes/best — return the node with the lowest score
  app.get('/nodes/best', async () => {
    const nodes = monitor.getNodes();
    const now = Date.now();

    // Parallel fetch all node states
    const entries = await Promise.all(
      nodes.map(async (node) => {
        const [dead, state] = await Promise.all([store.isDead(node.key), store.getState(node.key)]);
        return { node, dead, state };
      }),
    );

    let best: NodeView | null = null;
    let bestScore = Infinity;
    for (const { node, dead, state } of entries) {
      if (dead || !state || state.lastCheck === 0 || state.failCount !== 0) continue;
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
