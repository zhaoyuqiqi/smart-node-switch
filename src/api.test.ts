import { describe, it, expect } from 'bun:test';
import { Elysia } from 'elysia';
import { registerRoutes } from './api.ts';
import type { Monitor } from './monitor.ts';
import type { StateStore } from './store/state-store.ts';
import type { Node, NodeState } from './types.ts';

function makeNode(key: string): Node {
  return {
    key, name: `N-${key}`, protocol: 'trojan', server: 'h.com', port: 443,
    raw: { password: `pw-${key}`, sni: 'sni.com' },
    originalUri: `trojan://pw-${key}@h.com:443#N-${key}`,
  };
}

function makeState(over: Partial<NodeState> = {}): NodeState {
  return {
    latency: 50, failCount: 0, successCount: 1, lastCheck: Date.now(),
    name: 'N', protocol: 'trojan', server: 'h.com', port: 443, ...over,
  };
}

function fakeStore(states: Record<string, NodeState>, dead: Set<string> = new Set()): StateStore {
  return {
    async getState(k) { return states[k] ?? null; },
    async setState() {},
    async renewTtl() {},
    async isDead(k) { return dead.has(k); },
    async markDead() {},
    async clearDead() {},
  };
}

function fakeMonitor(nodes: Node[]): Monitor {
  return { getNodes: () => nodes } as unknown as Monitor;
}

async function getJson(app: Elysia, path: string): Promise<any> {
  const res = await app.handle(new Request(`http://localhost${path}`));
  return res.json();
}

describe('GET /nodes raw+originalUri', () => {
  it('returns raw and originalUri for available nodes', async () => {
    const node = makeNode('aaa');
    const app = registerRoutes(new Elysia(), fakeMonitor([node]), fakeStore({ aaa: makeState() }));
    const body = await getJson(app, '/nodes');
    expect(body.nodes.length).toBe(1);
    expect(body.nodes[0].raw.password).toBe('pw-aaa');
    expect(body.nodes[0].originalUri).toBe('trojan://pw-aaa@h.com:443#N-aaa');
  });
});

describe('GET /nodes/best raw+originalUri', () => {
  it('best node carries raw and originalUri', async () => {
    const node = makeNode('bbb');
    const app = registerRoutes(new Elysia(), fakeMonitor([node]), fakeStore({ bbb: makeState() }));
    const body = await getJson(app, '/nodes/best');
    expect(body.best.raw.password).toBe('pw-bbb');
    expect(body.best.originalUri).toBe('trojan://pw-bbb@h.com:443#N-bbb');
  });
});

describe('GET /proxy', () => {
  it('returns the fixed proxy address and best node when a node is available', async () => {
    const node = makeNode('best1');
    const app = registerRoutes(
      new Elysia(), fakeMonitor([node]), fakeStore({ best1: makeState({ latency: 5 }) }),
      { publicHost: 'gw.example.com', port: 8080 },
    );
    const body = await getJson(app, '/proxy');
    expect(body.proxy).toBe('http://gw.example.com:8080');
    expect(body.node.key).toBe('best1');
    expect(body.node.raw.password).toBe('pw-best1');
    expect(body.node.originalUri).toBe('trojan://pw-best1@h.com:443#N-best1');
  });

  it('returns nulls when no node is available', async () => {
    const node = makeNode('dead1');
    const app = registerRoutes(
      new Elysia(), fakeMonitor([node]),
      fakeStore({ dead1: makeState({ failCount: 3 }) }), // failCount!=0 -> unavailable
      { publicHost: 'gw.example.com', port: 8080 },
    );
    const body = await getJson(app, '/proxy');
    expect(body.proxy).toBeNull();
    expect(body.node).toBeNull();
  });

  it('falls back to the request Host when publicHost is empty', async () => {
    const node = makeNode('best2');
    const app = registerRoutes(
      new Elysia(), fakeMonitor([node]), fakeStore({ best2: makeState() }),
      { publicHost: '', port: 9000 },
    );
    const res = await app.handle(new Request('http://my-host:1234/proxy'));
    const body = await res.json() as any;
    expect(body.proxy).toBe('http://my-host:9000');
  });
});
