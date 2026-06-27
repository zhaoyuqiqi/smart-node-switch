import PQueue from "p-queue";
import type { Node, NodeState } from "./types.ts";
import type { StateStore } from "./store/state-store.ts";
import type { ProbeResult } from "./singbox/probe.ts";
import { score } from "./scoring.ts";

export type ProbeFn = (
  port: number,
  testUrl: string,
  timeoutMs: number
) => Promise<ProbeResult>;
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
  clash?: { setSelector(outboundTag: string): Promise<void> };
  orchestrator?: { blueGreenSwap(newNodes: Node[]): Promise<boolean> };
  onActiveInstance?: (
    portMap: Map<string, number>,
    clash: { setSelector(t: string): Promise<void> }
  ) => void;
}

export class Monitor {
  private nodes: Node[];
  private portMap: Map<string, number>;
  private timer: ReturnType<typeof setInterval> | null = null;
  private lastRefreshAt = Date.now() / 1000; // initialize to now so first check respects cooldown
  private readonly queue: PQueue;
  private lastSelector: string | null = null;

  constructor(private opts: MonitorOptions) {
    this.nodes = opts.nodes;
    this.portMap = opts.portMap;
    this.queue = new PQueue({ concurrency: opts.maxConcurrency });
  }

  updateNodes(nodes: Node[], portMap: Map<string, number>) {
    this.nodes = nodes;
    this.portMap = portMap;
  }

  setOrchestrator(o: { blueGreenSwap(newNodes: Node[]): Promise<boolean> }) {
    this.opts.orchestrator = o;
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
    const {
      store,
      probe,
      testUrl,
      probeTimeoutMs,
      nodeTtlSeconds,
      deathThreshold,
      revivalSeconds,
    } = this.opts;
    const now = Date.now();

    console.log(
      `[monitor] runRound: ${this.nodes.length} nodes, portMap size=${this.portMap.size}`
    );

    const checkTasks = this.nodes.map((node) => async () => {
      // Skip dead nodes
      if (await store.isDead(node.key)) {
        console.log(`[monitor] skip dead: ${node.name}`);
        return;
      }

      const port = this.portMap.get(node.key);
      if (port === undefined) {
        console.log(`[monitor] no port for: ${node.name} (key=${node.key})`);
        return;
      }

      const result = await probe(port, testUrl, probeTimeoutMs);
      if (result.ok) {
        console.log(
          `[monitor] ✅ AVAILABLE: ${node.server} ${node.name} port=${port} latency=${result.latencyMs}ms`
        );
      } else {
        console.log(
          `[monitor] ❌ failed: ${node.server} ${node.name} port=${port} latency=${result.latencyMs}ms`
        );
      }
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

    await this.applyBestSelector();

    // Evaluate refresh threshold (skip when already triggered by a refresh)
    if (!skipRefreshCheck) {
      await this.maybeRefresh();
    }
  }

  private async computeBestKey(): Promise<string | null> {
    const { store } = this.opts;
    const now = Date.now();
    let bestKey: string | null = null;
    let bestScore = Infinity;
    for (const node of this.nodes) {
      if (await store.isDead(node.key)) continue;
      const state = await store.getState(node.key);
      if (!state || state.lastCheck === 0 || state.failCount !== 0) continue;
      const s = score(state, now);
      if (s < bestScore) {
        bestScore = s;
        bestKey = node.key;
      }
    }
    return bestKey;
  }

  private async applyBestSelector(): Promise<void> {
    const clash = this.opts.clash;
    if (!clash) return;
    const bestKey = await this.computeBestKey();
    const target = bestKey ? `out-${bestKey}` : "block";
    if (target === this.lastSelector) return;
    this.lastSelector = target;
    try {
      await clash.setSelector(target);
    } catch (e) {
      console.error("[monitor] setSelector failed", e);
    }
  }

  private async maybeRefresh(): Promise<void> {
    const { store, refresh, refreshThreshold, refreshCooldownSeconds } =
      this.opts;
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
      const changed = !this.sameNodeSet(this.nodes, newNodes);
      if (changed && this.opts.orchestrator) {
        const ok = await this.opts.orchestrator.blueGreenSwap(newNodes);
        if (ok) {
          // Swap succeeded: adopt the new node set. onActiveChange has already
          // re-pointed portMap at the new instance.
          this.nodes = newNodes;
        } else {
          // Swap failed: old instance kept running, so keep the previous node
          // set and portMap to stay consistent with the live instance.
          console.error(
            "[monitor] blueGreenSwap failed; keeping old instance"
          );
        }
      } else {
        // No orchestrator (or unchanged set): adopt newNodes directly.
        this.nodes = newNodes;
      }
      // After refresh, run another round immediately (skip nested refresh check)
      await this.runRound(true);
    }
  }

  private sameNodeSet(a: Node[], b: Node[]): boolean {
    if (a.length !== b.length) return false;
    const sa = new Set(a.map((n) => n.key));
    for (const n of b) if (!sa.has(n.key)) return false;
    return true;
  }

  getNodes(): Node[] {
    return this.nodes;
  }
}
