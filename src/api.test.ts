import { describe, it, expect } from 'bun:test';
import { Elysia } from 'elysia';
import { registerRoutes } from './api.ts';
import type { Monitor } from './monitor.ts';
import type { Node, NodeStatistics } from './types.ts';

function makeNode(key: string): Node {
  return {
    key, name: `N-${key}`, protocol: 'trojan', server: 'h.com', port: 443,
    raw: { password: `pw-${key}`, sni: 'sni.com' },
    originalUri: `trojan://pw-${key}@h.com:443#N-${key}`,
  };
}

function fakeStats(latency: number | null): NodeStatistics {
  return {
    currentRtt: latency ?? -1,
    avgRtt: latency ?? -1,
    medianRtt: latency ?? -1,
    p95Rtt: latency ?? -1,
    jitter: 0,
    successRate: latency === null ? 0 : 100,
    consecutiveFailure: latency === null ? 1 : 0,
    sampleCount: 1,
    lastSyncAt: new Date().toISOString(),
  };
}

function fakeMonitor(nodes: Node[], bestKey: string | null, latencies: Record<string, number | null> = {}): Monitor {
  return {
    getNodes: () => nodes,
    getBestKey: () => bestKey,
    getBestNode: () => (bestKey ? nodes.find((n) => n.key === bestKey) ?? null : null),
    getLatency: (key: string) => latencies[key] ?? null,
    getScore: (key: string) => (latencies[key] === null ? 0 : 80),
    getStatistics: (key: string) => fakeStats(latencies[key] ?? null),
  } as unknown as Monitor;
}

async function get(app: Elysia, path: string): Promise<Response> {
  return app.handle(new Request(`http://localhost${path}`));
}

describe('GET /nodes', () => {
  it('returns all nodes with isBest marker and score/statistics', async () => {
    const a = makeNode('aaa');
    const b = makeNode('bbb');
    const app = registerRoutes(new Elysia(), fakeMonitor([a, b], 'bbb', { aaa: 220, bbb: 88 }));
    const res = await get(app, '/nodes');
    const body = await res.json() as any;
    expect(body.count).toBe(2);
    expect(body.nodes.find((n: any) => n.key === 'aaa').isBest).toBe(false);
    expect(body.nodes.find((n: any) => n.key === 'bbb').isBest).toBe(true);
    expect(body.nodes.find((n: any) => n.key === 'aaa').latencyMs).toBe(220);
    expect(body.nodes.find((n: any) => n.key === 'bbb').latencyMs).toBe(88);
    expect(typeof body.nodes.find((n: any) => n.key === 'bbb').score).toBe('number');
    expect(body.nodes.find((n: any) => n.key === 'bbb').statistics.sampleCount).toBe(1);
    expect(typeof body.nodes.find((n: any) => n.key === 'bbb').statistics.lastSyncAt).toBe('string');
  });
});

describe('GET /nodes/available', () => {
  it('returns only nodes with non-null latency in /nodes shape', async () => {
    const a = makeNode('aaa');
    const b = makeNode('bbb');
    const c = makeNode('ccc');
    const app = registerRoutes(new Elysia(), fakeMonitor([a, b, c], 'bbb', { aaa: null, bbb: 88, ccc: 180 }));
    const res = await get(app, '/nodes/available');
    const body = await res.json() as any;

    expect(body.count).toBe(2);
    expect(Array.isArray(body.nodes)).toBe(true);
    expect(body.nodes.map((n: any) => n.key).sort()).toEqual(['bbb', 'ccc']);
    expect(body.nodes.find((n: any) => n.key === 'bbb').isBest).toBe(true);
    expect(body.nodes.find((n: any) => n.key === 'bbb').latencyMs).toBe(88);
  });

  it('returns empty list when all latencies are null', async () => {
    const a = makeNode('aaa');
    const b = makeNode('bbb');
    const app = registerRoutes(new Elysia(), fakeMonitor([a, b], null, { aaa: null, bbb: null }));
    const res = await get(app, '/nodes/available');
    const body = await res.json() as any;

    expect(body.count).toBe(0);
    expect(body.nodes).toEqual([]);
  });
});

describe('GET /nodes/best', () => {
  it('returns the current best node', async () => {
    const b = makeNode('bbb');
    const app = registerRoutes(new Elysia(), fakeMonitor([b], 'bbb', { bbb: 90 }));
    const res = await get(app, '/nodes/best');
    const body = await res.json() as any;
    expect(body.best.key).toBe('bbb');
    expect(body.best.raw.password).toBe('pw-bbb');
    expect(body.best.statistics.currentRtt).toBe(90);
  });

  it('returns null when no best node exists', async () => {
    const a = makeNode('aaa');
    const app = registerRoutes(new Elysia(), fakeMonitor([a], null));
    const res = await get(app, '/nodes/best');
    const body = await res.json() as any;
    expect(body.best).toBeNull();
  });
});

describe('GET /proxy', () => {
  it('returns fixed proxy address and best node', async () => {
    const best = makeNode('best1');
    const app = registerRoutes(
      new Elysia(),
      fakeMonitor([best], 'best1', { best1: 80 }),
      { publicHost: 'gw.example.com', port: 8080 },
    );
    const res = await get(app, '/proxy');
    const body = await res.json() as any;
    expect(res.status).toBe(200);
    expect(body.proxy).toBe('http://gw.example.com:8080');
    expect(body.node.key).toBe('best1');
    expect(typeof body.node.score).toBe('number');
  });

  it('returns 503 with reason when no node is available', async () => {
    const dead = makeNode('dead1');
    const app = registerRoutes(
      new Elysia(),
      fakeMonitor([dead], null),
      { publicHost: 'gw.example.com', port: 8080 },
    );
    const res = await get(app, '/proxy');
    const body = await res.json() as any;
    expect(res.status).toBe(503);
    expect(body.proxy).toBeNull();
    expect(body.node).toBeNull();
    expect(body.reason).toContain('no available node');
  });

  it('falls back to request host when publicHost is empty', async () => {
    const best = makeNode('best2');
    const app = registerRoutes(
      new Elysia(),
      fakeMonitor([best], 'best2', { best2: 95 }),
      { publicHost: '', port: 9000 },
    );
    const res = await app.handle(new Request('http://my-host:1234/proxy'));
    const body = await res.json() as any;
    expect(body.proxy).toBe('http://my-host:9000');
  });
});
