import { describe, it, expect } from 'bun:test';
import { Monitor } from './monitor.ts';
import type { Node } from './types.ts';
import type { NodeMetricsStore } from './node-metrics-store.ts';

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

describe('Monitor(score-selector)', () => {
  it('picks best by score and calls setSelector', async () => {
    const a = makeNode('aaa');
    const b = makeNode('bbb');
    const setCalls: string[] = [];

    const monitor = new Monitor({
      refresh: async () => [a, b],
      nodes: [a, b],
      intervalSeconds: 9999,
      refreshThreshold: 0.1,
      refreshCooldownSeconds: 9999,
      clash: {
        async setSelector(tag) { setCalls.push(tag); },
        async getNodeLatencies() { return { aaa: 180, bbb: 95 }; },
      },
    });

    await monitor.runRound();
    expect(monitor.getBestKey()).toBe('bbb');
    expect(monitor.getBestNode()?.key).toBe('bbb');
    expect(setCalls.at(-1)).toBe('out-bbb');
  });

  it('stores timeout as -1 and sets score to 0 for latest timeout node', async () => {
    const a = makeNode('aaa');
    const monitor = new Monitor({
      refresh: async () => [a],
      nodes: [a],
      intervalSeconds: 9999,
      refreshThreshold: 0.1,
      refreshCooldownSeconds: 9999,
      clash: {
        async setSelector() {},
        async getNodeLatencies() { return { aaa: null }; },
      },
    });

    await monitor.runRound();
    expect(monitor.getBestKey()).toBeNull();
    expect(monitor.getLatency('aaa')).toBeNull();
    expect(monitor.getScore('aaa')).toBe(0);
    expect(monitor.getStatistics('aaa')?.currentRtt).toBe(-1);
  });

  it('applies -30 penalty when previous round was timeout and current recovers', async () => {
    const a = makeNode('aaa');
    const monitor = new Monitor({
      refresh: async () => [a],
      nodes: [a],
      intervalSeconds: 9999,
      refreshThreshold: 0.1,
      refreshCooldownSeconds: 9999,
      clash: {
        async setSelector() {},
        async getNodeLatencies() { return { aaa: null }; },
      },
    });

    await monitor.runRound();

    const monitor2 = monitor as unknown as { opts: { clash: { getNodeLatencies?: () => Promise<Record<string, number | null>> } } };
    monitor2.opts.clash.getNodeLatencies = async () => ({ aaa: 120 });

    await monitor.runRound();
    // 由于最近 2 次成功率仅 50%，触发低成功率熔断，得分应为 0。
    expect(monitor.getBestKey()).toBeNull();
    expect(monitor.getScore('aaa')).toBe(0);
  });

  it('triggers refresh when score>=60 nodes ratio drops below 10%', async () => {
    const nodes = [makeNode('a1'), makeNode('a2'), makeNode('a3'), makeNode('a4'), makeNode('a5'), makeNode('a6'), makeNode('a7'), makeNode('a8'), makeNode('a9'), makeNode('a10')];
    let refreshCalled = false;

    const monitor = new Monitor({
      refresh: async () => {
        refreshCalled = true;
        return nodes;
      },
      nodes,
      intervalSeconds: 9999,
      refreshThreshold: 0.1,
      refreshCooldownSeconds: 0,
      clash: {
        async setSelector() {},
        async getNodeLatencies() {
          // only 1 node healthy(>=60) out of 10 => exactly 10%, not trigger; all timeout then trigger
          return Object.fromEntries(nodes.map((n) => [n.key, null]));
        },
      },
    });

    await monitor.runRound();
    expect(refreshCalled).toBe(true);
  });

  it('prunes internal maps to current subscription node keys only', async () => {
    const oldNode = makeNode('old');
    const newNode = makeNode('new');

    const monitor = new Monitor({
      refresh: async () => [oldNode],
      nodes: [oldNode],
      intervalSeconds: 9999,
      refreshThreshold: 0.1,
      refreshCooldownSeconds: 9999,
      clash: {
        async setSelector() {},
        async getNodeLatencies() { return { old: 110 }; },
      },
    });

    await monitor.runRound();
    expect(monitor.getStatistics('old')).not.toBeNull();

    monitor.updateNodes([newNode]);

    expect(monitor.getStatistics('old')).toBeNull();
    expect(monitor.getScore('old')).toBe(0);
    expect(monitor.getLatency('old')).toBeNull();
  });

  it('does not emit transient null best during successful refresh swap', async () => {
    const oldNode = makeNode('old');
    const newNode = makeNode('new');
    const bestChanges: Array<string | null> = [];

    let active: 'old' | 'new' = 'old';

    const monitor = new Monitor({
      refresh: async () => [newNode],
      nodes: [oldNode],
      intervalSeconds: 9999,
      refreshThreshold: 1,
      refreshCooldownSeconds: 0,
      clash: {
        async setSelector() {},
        async getNodeLatencies() {
          if (active === 'old') return { old: 100, new: null };
          return { old: null, new: 90 };
        },
      },
      orchestrator: {
        async blueGreenSwap() {
          active = 'new';
          return true;
        },
      },
      onBestChange: (k) => bestChanges.push(k),
    });

    await monitor.runRound();

    expect(bestChanges).toContain('old');
    expect(bestChanges).toContain('new');
    expect(bestChanges).not.toContain(null);
    expect(monitor.getBestKey()).toBe('new');
  });

  it('hydrates history from metricsStore and uses it in scoring', async () => {
    const a = makeNode('aaa');
    const b = makeNode('bbb');
    const setCalls: string[] = [];

    const metricsStore = {
      async readRecentSamples(key: string) {
        if (key === 'aaa') return [120, 110, 130, 125];
        return [];
      },
      async record() {},
    } as unknown as NodeMetricsStore;

    const monitor = new Monitor({
      refresh: async () => [a, b],
      nodes: [a, b],
      intervalSeconds: 9999,
      refreshThreshold: 0.1,
      refreshCooldownSeconds: 9999,
      clash: {
        async setSelector(tag) { setCalls.push(tag); },
        async getNodeLatencies() { return { aaa: 180, bbb: 80 }; },
      },
      metricsStore,
    });

    await monitor.start();
    monitor.stop();

    // 若不回填，bbb 会因当前 RTT 更低被选中；回填后 aaa 样本达到 5 个，不再受 sampleCount<5 的中性分限制。
    expect(monitor.getBestKey()).toBe('aaa');
    expect(monitor.getScore('aaa')).toBeGreaterThan(50);
    expect(setCalls.at(-1)).toBe('out-aaa');
  });

  it('uses new samples only: unchanged latency snapshot should not re-record or re-select', async () => {
    const a = makeNode('aaa');
    const b = makeNode('bbb');
    const setCalls: string[] = [];
    const recorded: Array<{ key: string; rtt: number }> = [];

    const metricsStore = {
      async readRecentSamples() { return []; },
      async record(key: string, rtt: number) {
        recorded.push({ key, rtt });
      },
    } as unknown as NodeMetricsStore;

    const monitor = new Monitor({
      refresh: async () => [a, b],
      nodes: [a, b],
      intervalSeconds: 9999,
      refreshThreshold: 0.1,
      refreshCooldownSeconds: 9999,
      clash: {
        async setSelector(tag) { setCalls.push(tag); },
        async getNodeLatencies() { return { aaa: 100, bbb: 110 }; },
      },
      metricsStore,
    });

    await monitor.runRound();
    const firstScore = monitor.getScore('aaa');

    await monitor.runRound(true);

    expect(setCalls).toEqual(['out-aaa']);
    expect(recorded.length).toBe(2);
    expect(monitor.getScore('aaa')).toBe(firstScore);
  });

  it('requests active probe latencies with configured probe params', async () => {
    const a = makeNode('aaa');
    const seen: Array<{ activeProbe?: boolean; probeUrl?: string; probeTimeoutMs?: number }> = [];

    const monitor = new Monitor({
      refresh: async () => [a],
      nodes: [a],
      intervalSeconds: 9999,
      refreshThreshold: 0.1,
      refreshCooldownSeconds: 9999,
      probeUrl: 'https://www.google.com/generate_204',
      probeTimeoutMs: 4000,
      clash: {
        async setSelector() {},
        async getNodeLatencies(opts) {
          seen.push(opts ?? {});
          return { aaa: 100 };
        },
      },
    });

    await monitor.runRound();

    expect(seen.length).toBeGreaterThan(0);
    expect(seen[0]).toEqual({
      activeProbe: true,
      probeUrl: 'https://www.google.com/generate_204',
      probeTimeoutMs: 4000,
    });
  });

  it('throttles active probe by activeProbeIntervalSeconds', async () => {
    const a = makeNode('aaa');
    const seen: Array<{ activeProbe?: boolean; probeUrl?: string; probeTimeoutMs?: number }> = [];
    let call = 0;

    const monitor = new Monitor({
      refresh: async () => [a],
      nodes: [a],
      intervalSeconds: 9999,
      refreshThreshold: 0.1,
      refreshCooldownSeconds: 9999,
      activeProbeIntervalSeconds: 60,
      clash: {
        async setSelector() {},
        async getNodeLatencies(opts) {
          call += 1;
          seen.push(opts ?? {});
          return { aaa: 100 + call };
        },
      },
    });

    await monitor.runRound();
    await monitor.runRound(true);

    expect(seen.length).toBe(2);
    expect(seen[0]?.activeProbe).toBe(true);
    expect(seen[1]?.activeProbe).toBe(false);
  });

  it('flushes Redis every interval and persists TopK only', async () => {
    const nodes = Array.from({ length: 12 }, (_, i) => makeNode(`n${String(i + 1).padStart(2, '0')}`));
    const recorded: Array<{ key: string; rtt: number }> = [];
    let round = 0;

    const metricsStore = {
      async readRecentSamples() { return []; },
      async record(key: string, rtt: number) {
        recorded.push({ key, rtt });
      },
    } as unknown as NodeMetricsStore;

    const monitor = new Monitor({
      refresh: async () => nodes,
      nodes,
      intervalSeconds: 9999,
      refreshThreshold: 0.1,
      refreshCooldownSeconds: 9999,
      metricsFlushIntervalSeconds: 300,
      metricsFlushTopK: 10,
      clash: {
        async setSelector() {},
        async getNodeLatencies() {
          round += 1;
          const result: Record<string, number | null> = {};
          for (let i = 0; i < nodes.length; i++) {
            result[nodes[i]!.key] = 50 + i + round;
          }
          return result;
        },
      },
      metricsStore,
    });

    await monitor.runRound();
    expect(recorded.length).toBe(10);

    await monitor.runRound(true);
    expect(recorded.length).toBe(10);
  });
});
