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
