import { describe, it, expect, beforeEach } from 'bun:test';
import { Monitor } from './monitor.ts';
import type { StateStore } from './store/state-store.ts';
import type { NodeState } from './types.ts';
import type { Node } from './types.ts';

// ---- In-memory StateStore (same as store test) ----
class MemoryStateStore implements StateStore {
  private states = new Map<string, NodeState>();
  private deadKeys = new Map<string, number>();

  async getState(key: string): Promise<NodeState | null> {
    return this.states.get(key) ?? null;
  }
  async setState(key: string, state: NodeState, _ttl: number): Promise<void> {
    this.states.set(key, { ...state });
  }
  async renewTtl(_key: string, _ttl: number): Promise<void> {}
  async isDead(key: string): Promise<boolean> {
    const exp = this.deadKeys.get(key);
    if (exp === undefined) return false;
    if (Date.now() > exp) { this.deadKeys.delete(key); return false; }
    return true;
  }
  async markDead(key: string, ttlSeconds: number): Promise<void> {
    this.deadKeys.set(key, Date.now() + ttlSeconds * 1000);
  }
  async clearDead(key: string): Promise<void> { this.deadKeys.delete(key); }
  expireDead(key: string) { this.deadKeys.set(key, Date.now() - 1); }
}

// ---- Test fixtures ----
function makeNode(key: string): Node {
  return { key, name: `Node-${key}`, protocol: 'trojan', server: 'h.com', port: 443, raw: {}, originalUri: '' };
}

function makePortMap(nodes: Node[], basePort = 30000): Map<string, number> {
  const m = new Map<string, number>();
  nodes.forEach((n, i) => m.set(n.key, basePort + i));
  return m;
}

function makeMonitor(
  nodes: Node[],
  store: MemoryStateStore,
  probeFn: (port: number) => Promise<{ ok: boolean; latencyMs: number }>,
  refreshFn?: () => Promise<Node[]>,
) {
  const portMap = makePortMap(nodes);
  return new Monitor({
    store,
    probe: (port, _url, _timeout) => probeFn(port),
    refresh: refreshFn ?? (async () => nodes),
    nodes,
    portMap,
    intervalSeconds: 9999,
    maxConcurrency: 10,
    refreshThreshold: 0.1,
    refreshCooldownSeconds: 9999, // disable auto-refresh for most tests
    nodeTtlSeconds: 172800,
    deathThreshold: 20,
    revivalSeconds: 86400,
    testUrl: 'http://test',
    probeTimeoutMs: 5000,
  });
}

describe('Monitor', () => {
  let store: MemoryStateStore;

  beforeEach(() => {
    store = new MemoryStateStore();
  });

  // Task 5.1: runs round and updates state
  it('successful probe updates latency and resets failCount', async () => {
    const node = makeNode('aaa');
    // Pre-set failCount=3
    await store.setState('aaa', { latency: 0, failCount: 3, successCount: 0, lastCheck: 0, name: 'x', protocol: 'trojan', server: 'h.com', port: 443 }, 172800);
    const monitor = makeMonitor([node], store, async () => ({ ok: true, latencyMs: 120 }));
    await monitor.runRound();
    const state = await store.getState('aaa');
    expect(state!.failCount).toBe(0);
    expect(state!.latency).toBe(120);
    expect(state!.successCount).toBe(1);
    expect(state!.lastCheck).toBeGreaterThan(0);
  });

  it('failed probe increments failCount', async () => {
    const node = makeNode('bbb');
    const monitor = makeMonitor([node], store, async () => ({ ok: false, latencyMs: 5000 }));
    await monitor.runRound();
    const state = await store.getState('bbb');
    expect(state!.failCount).toBe(1);
  });

  // Task 5.2: skip dead nodes
  it('skips dead nodes during check', async () => {
    const node = makeNode('ccc');
    await store.markDead('ccc', 86400);
    let probeCallCount = 0;
    const monitor = makeMonitor([node], store, async () => { probeCallCount++; return { ok: true, latencyMs: 50 }; });
    await monitor.runRound();
    expect(probeCallCount).toBe(0);
  });

  // Task 4.4 via monitor: 20 failures → mark dead
  it('marks node dead after deathThreshold failures', async () => {
    const node = makeNode('ddd');
    // Pre-load failCount=19
    await store.setState('ddd', { latency: 0, failCount: 19, successCount: 0, lastCheck: 0, name: 'x', protocol: 'trojan', server: 'h.com', port: 443 }, 172800);

    const monitor = new Monitor({
      store,
      probe: async () => ({ ok: false, latencyMs: 100 }),
      refresh: async () => [node],
      nodes: [node],
      portMap: makePortMap([node]),
      intervalSeconds: 9999,
      maxConcurrency: 10,
      refreshThreshold: 0.1,
      refreshCooldownSeconds: 0,
      nodeTtlSeconds: 172800,
      deathThreshold: 20,
      revivalSeconds: 86400,
      testUrl: 'http://test',
      probeTimeoutMs: 5000,
    });
    await monitor.runRound();
    expect(await store.isDead('ddd')).toBe(true);
  });

  // Task 5.3: p-queue concurrency (verify no more than maxConcurrency concurrent)
  it('respects maxConcurrency limit', async () => {
    const nodes = Array.from({ length: 5 }, (_, i) => makeNode(`n${i}`));
    let concurrent = 0;
    let maxConcurrent = 0;
    const monitor = new Monitor({
      store,
      probe: async () => {
        concurrent++;
        maxConcurrent = Math.max(maxConcurrent, concurrent);
        await Bun.sleep(10);
        concurrent--;
        return { ok: true, latencyMs: 10 };
      },
      refresh: async () => nodes,
      nodes,
      portMap: makePortMap(nodes),
      intervalSeconds: 9999,
      maxConcurrency: 2,
      refreshThreshold: 0.1,
      refreshCooldownSeconds: 0,
      nodeTtlSeconds: 172800,
      deathThreshold: 20,
      revivalSeconds: 86400,
      testUrl: 'http://test',
      probeTimeoutMs: 5000,
    });
    await monitor.runRound();
    expect(maxConcurrent).toBeLessThanOrEqual(2);
  });

  // Task 5.4: refresh when available < total * 10%
  it('triggers refresh when available nodes fall below threshold', async () => {
    const nodes = Array.from({ length: 10 }, (_, i) => makeNode(`r${i}`));
    // All fail → 0 available out of 10 → below 10% threshold
    let refreshCalled = false;
    const monitor = new Monitor({
      store,
      probe: async () => ({ ok: false, latencyMs: 5000 }),
      refresh: async () => { refreshCalled = true; return nodes; },
      nodes,
      portMap: makePortMap(nodes),
      intervalSeconds: 9999,
      maxConcurrency: 10,
      refreshThreshold: 0.1,
      refreshCooldownSeconds: 0, // no cooldown for test
      nodeTtlSeconds: 172800,
      deathThreshold: 100, // high threshold so nodes don't die immediately
      revivalSeconds: 86400,
      testUrl: 'http://test',
      probeTimeoutMs: 5000,
    });
    await monitor.runRound();
    expect(refreshCalled).toBe(true);
  });
});
