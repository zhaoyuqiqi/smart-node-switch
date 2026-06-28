import { describe, it, expect } from 'bun:test';
import { Monitor } from './monitor.ts';
import type { Node } from './types.ts';

function makeNode(key: string): Node {
  return {
    key,
    name: `Node-${key}`,
    protocol: 'trojan',
    server: 'h.com',
    port: 443,
    raw: {},
    originalUri: `trojan://x@h.com:443#${key}`,
  };
}

describe('Monitor(urltest)', () => {
  it('syncs best key from clash urltest group', async () => {
    const a = makeNode('aaa');
    const b = makeNode('bbb');
    const changed: Array<string | null> = [];
    const monitor = new Monitor({
      refresh: async () => [a, b],
      nodes: [a, b],
      intervalSeconds: 9999,
      refreshThreshold: 0.1,
      refreshCooldownSeconds: 9999,
      clash: {
        async getCurrentOutbound() { return 'out-bbb'; },
        async getNodeLatencies() { return { aaa: 210, bbb: 95 }; },
      },
      onBestChange: (k) => changed.push(k),
    });

    await monitor.runRound();
    expect(monitor.getBestKey()).toBe('bbb');
    expect(monitor.getBestNode()?.key).toBe('bbb');
    expect(monitor.getLatency('aaa')).toBe(210);
    expect(monitor.getLatency('bbb')).toBe(95);
    expect(changed.at(-1)).toBe('bbb');
  });

  it('accepts plain node key from clash as current outbound', async () => {
    const a = makeNode('aaa');
    const b = makeNode('bbb');
    const monitor = new Monitor({
      refresh: async () => [a, b],
      nodes: [a, b],
      intervalSeconds: 9999,
      refreshThreshold: 0.1,
      refreshCooldownSeconds: 9999,
      clash: { async getCurrentOutbound() { return 'bbb'; } },
    });

    await monitor.runRound();
    expect(monitor.getBestKey()).toBe('bbb');
    expect(monitor.getBestNode()?.key).toBe('bbb');
  });

  it('accepts node name from clash as current outbound', async () => {
    const a = makeNode('aaa');
    const b = makeNode('bbb');
    const monitor = new Monitor({
      refresh: async () => [a, b],
      nodes: [a, b],
      intervalSeconds: 9999,
      refreshThreshold: 0.1,
      refreshCooldownSeconds: 9999,
      clash: { async getCurrentOutbound() { return 'Node-bbb'; } },
    });

    await monitor.runRound();
    expect(monitor.getBestKey()).toBe('bbb');
    expect(monitor.getBestNode()?.key).toBe('bbb');
  });

  it('sets best null when urltest returns unknown outbound', async () => {
    const a = makeNode('aaa');
    const monitor = new Monitor({
      refresh: async () => [a],
      nodes: [a],
      intervalSeconds: 9999,
      refreshThreshold: 0.1,
      refreshCooldownSeconds: 9999,
      clash: { async getCurrentOutbound() { return 'out-not-exist'; } },
    });

    await monitor.runRound();
    expect(monitor.getBestKey()).toBeNull();
    expect(monitor.getBestNode()).toBeNull();
  });

  it('triggers refresh when no best and threshold is breached', async () => {
    const oldNodes = [makeNode('old')];
    const newNodes = [makeNode('new')];
    let refreshCalled = false;
    const monitor = new Monitor({
      refresh: async () => {
        refreshCalled = true;
        return newNodes;
      },
      nodes: oldNodes,
      intervalSeconds: 9999,
      refreshThreshold: 0.5,
      refreshCooldownSeconds: 0,
      clash: {
        async getCurrentOutbound() {
          // first sync: no best; after refresh still no best for this test
          return null;
        },
      },
    });

    await monitor.runRound();
    expect(refreshCalled).toBe(true);
    expect(monitor.getNodes().map((n) => n.key)).toEqual(['new']);
  });

  it('calls blueGreenSwap when refreshed node set changes', async () => {
    const oldNodes = [makeNode('o1'), makeNode('o2')];
    const newNodes = [makeNode('n1'), makeNode('n2')];
    let swappedWith: Node[] | null = null;

    const monitor = new Monitor({
      refresh: async () => newNodes,
      nodes: oldNodes,
      intervalSeconds: 9999,
      refreshThreshold: 0.5,
      refreshCooldownSeconds: 0,
      clash: { async getCurrentOutbound() { return null; } },
      orchestrator: {
        async blueGreenSwap(nodes) {
          swappedWith = nodes;
          return true;
        },
      },
    });

    await monitor.runRound();
    expect(swappedWith).not.toBeNull();
    const swappedKeys = (swappedWith ?? []).map((n: Node) => n.key).sort();
    expect(swappedKeys).toEqual(['n1', 'n2']);
    expect(monitor.getNodes().map((n) => n.key).sort()).toEqual(['n1', 'n2']);
  });

  it('keeps old nodes when blueGreenSwap fails', async () => {
    const oldNodes = [makeNode('o1'), makeNode('o2')];
    const newNodes = [makeNode('n1'), makeNode('n2')];

    const monitor = new Monitor({
      refresh: async () => newNodes,
      nodes: oldNodes,
      intervalSeconds: 9999,
      refreshThreshold: 0.5,
      refreshCooldownSeconds: 0,
      clash: { async getCurrentOutbound() { return null; } },
      orchestrator: {
        async blueGreenSwap() {
          return false;
        },
      },
    });

    await monitor.runRound();
    expect(monitor.getNodes().map((n) => n.key).sort()).toEqual(['o1', 'o2']);
  });

  it('warm-up sync gets best quickly even when first probe is null', async () => {
    const a = makeNode('aaa');
    const b = makeNode('bbb');
    let calls = 0;
    const monitor = new Monitor({
      refresh: async () => [a, b],
      nodes: [a, b],
      intervalSeconds: 9999,
      refreshThreshold: 0.1,
      refreshCooldownSeconds: 9999,
      clash: {
        async getCurrentOutbound() {
          calls += 1;
          if (calls === 1) return null;
          return 'out-bbb';
        },
      },
    });

    await monitor.start();
    monitor.stop();
    expect(monitor.getBestKey()).toBe('bbb');
    expect(calls).toBeGreaterThanOrEqual(2);
  });
});
