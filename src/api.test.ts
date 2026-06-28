import { describe, it, expect } from 'bun:test';
import { Elysia } from 'elysia';
import { registerRoutes } from './api.ts';
import type { Monitor } from './monitor.ts';
import type { Node } from './types.ts';

function makeNode(key: string): Node {
  return {
    key, name: `N-${key}`, protocol: 'trojan', server: 'h.com', port: 443,
    raw: { password: `pw-${key}`, sni: 'sni.com' },
    originalUri: `trojan://pw-${key}@h.com:443#N-${key}`,
  };
}

function fakeMonitor(nodes: Node[], bestKey: string | null, latencies: Record<string, number | null> = {}): Monitor {
  return {
    getNodes: () => nodes,
    getBestKey: () => bestKey,
    getBestNode: () => (bestKey ? nodes.find((n) => n.key === bestKey) ?? null : null),
    getLatency: (key: string) => latencies[key] ?? null,
  } as unknown as Monitor;
}

async function get(app: Elysia, path: string): Promise<Response> {
  return app.handle(new Request(`http://localhost${path}`));
}

describe('GET /nodes', () => {
  it('returns all nodes with isBest marker', async () => {
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
  });
});

describe('GET /nodes/best', () => {
  it('returns the current best node', async () => {
    const b = makeNode('bbb');
    const app = registerRoutes(new Elysia(), fakeMonitor([b], 'bbb'));
    const res = await get(app, '/nodes/best');
    const body = await res.json() as any;
    expect(body.best.key).toBe('bbb');
    expect(body.best.raw.password).toBe('pw-bbb');
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
      fakeMonitor([best], 'best1'),
      { publicHost: 'gw.example.com', port: 8080 },
    );
    const res = await get(app, '/proxy');
    const body = await res.json() as any;
    expect(res.status).toBe(200);
    expect(body.proxy).toBe('http://gw.example.com:8080');
    expect(body.node.key).toBe('best1');
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
      fakeMonitor([best], 'best2'),
      { publicHost: '', port: 9000 },
    );
    const res = await app.handle(new Request('http://my-host:1234/proxy'));
    const body = await res.json() as any;
    expect(body.proxy).toBe('http://my-host:9000');
  });
});
