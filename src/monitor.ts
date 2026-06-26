import PQueue from 'p-queue';
import type { Node, NodeState } from './types.ts';
import type { StateStore } from './store/state-store.ts';
import type { ProbeResult } from './singbox/probe.ts';

export type ProbeFn = (port: number, testUrl: string, timeoutMs: number) => Promise<ProbeResult>;
export type RefreshFn = () => Promise<Node[]>;

export interface MonitorOptions {
  store: StateStore;
  probe: ProbeFn;
  refresh: RefreshFn;
  nodes: Node[];
  portMap: Map<string, number>;
  intervalSeconds: number;
  maxConcurrency: number;
  refreshThreshold: number;
  refreshCooldownSeconds: number;
  nodeTtlSeconds: number;
  deathThreshold: number;
  revivalSeconds: number;
  testUrl: string;
  probeTimeoutMs: number;
}

export class Monitor {
  private nodes: Node[];
  private portMap: Map<string, number>;
  private timer: ReturnType<typeof setInterval> | null = null;
  private lastRefreshAt = Date.now() / 1000; // initialize to now so first check respects cooldown
  private readonly queue: PQueue;

  constructor(private readonly opts: MonitorOptions) {
    this.nodes = opts.nodes;
    this.portMap = opts.portMap;
    this.queue = new PQueue({ concurrency: opts.maxConcurrency });
  }

  updateNodes(nodes: Node[], portMap: Map<string, number>) {
    this.nodes = nodes;
    this.portMap = portMap;
  }

  async start() {
    await this.runRound();
    this.timer = setInterval(() => {
      void this.runRound();
    }, this.opts.intervalSeconds * 1000);
  }

  stop() {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    this.queue.clear();
  }

  async runRound(skipRefreshCheck = false): Promise<void> {
    const { store, probe, testUrl, probeTimeoutMs, nodeTtlSeconds, deathThreshold, revivalSeconds } = this.opts;
    const now = Date.now();

    const checkTasks = this.nodes.map(node => async () => {
      // Skip dead nodes
      if (await store.isDead(node.key)) return;

      const port = this.portMap.get(node.key);
      if (port === undefined) return;

      const result = await probe(port, testUrl, probeTimeoutMs);
      const existing = await store.getState(node.key);

      const state: NodeState = {
        latency: existing?.latency ?? 0,
        failCount: existing?.failCount ?? 0,
        successCount: existing?.successCount ?? 0,
        lastCheck: Date.now(),
        name: node.name,
        protocol: node.protocol,
        server: node.server,
        port: node.port,
      };

      if (result.ok) {
        state.latency = result.latencyMs;
        state.failCount = 0;
        state.successCount++;
      } else {
        state.failCount++;
        // Mark dead if threshold reached
        if (state.failCount >= deathThreshold) {
          await store.setState(node.key, state, nodeTtlSeconds);
          await store.markDead(node.key, revivalSeconds);
          return;
        }
      }

      await store.setState(node.key, state, nodeTtlSeconds);
    });

    await this.queue.addAll(checkTasks);

    // Evaluate refresh threshold (skip when already triggered by a refresh)
    if (!skipRefreshCheck) {
      await this.maybeRefresh();
    }
  }

  private async maybeRefresh(): Promise<void> {
    const { store, refresh, refreshThreshold, refreshCooldownSeconds } = this.opts;
    const total = this.nodes.length;
    if (total === 0) return;

    const nowSec = Date.now() / 1000;
    if (nowSec - this.lastRefreshAt < refreshCooldownSeconds) return;

    // Count available: lastCheck > 0 && failCount === 0 && not dead
    let available = 0;
    for (const node of this.nodes) {
      if (await store.isDead(node.key)) continue;
      const state = await store.getState(node.key);
      if (state && state.lastCheck > 0 && state.failCount === 0) {
        available++;
      }
    }

    if (available < total * refreshThreshold) {
      this.lastRefreshAt = nowSec;
      const newNodes = await refresh();
      this.nodes = newNodes;
      // After refresh, run another round immediately (skip nested refresh check)
      await this.runRound(true);
    }
  }

  getNodes(): Node[] {
    return this.nodes;
  }
}
