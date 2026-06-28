import type { Node } from './types.ts';

export type RefreshFn = () => Promise<Node[]>;

export interface MonitorOptions {
  refresh: RefreshFn;
  nodes: Node[];
  intervalSeconds: number;
  refreshThreshold: number;
  refreshCooldownSeconds: number;
  clash: {
    getCurrentOutbound(groupTag: string): Promise<string | null>;
    getNodeLatencies?(): Promise<Record<string, number | null>>;
  };
  orchestrator?: { blueGreenSwap(newNodes: Node[]): Promise<boolean> };
  onBestChange?: (bestKey: string | null) => void;
}

export class Monitor {
  private nodes: Node[];
  private timer: ReturnType<typeof setInterval> | null = null;
  private bestSyncTimer: ReturnType<typeof setInterval> | null = null;
  private lastRefreshAt = Date.now() / 1000;
  private stopped = false;
  private isRunning = false;
  private bestKey: string | null = null;
  private latencyByKey = new Map<string, number | null>();

  constructor(private opts: MonitorOptions) {
    this.nodes = opts.nodes;
  }

  updateNodes(nodes: Node[]) {
    this.nodes = nodes;
  }

  setOrchestrator(o: { blueGreenSwap(newNodes: Node[]): Promise<boolean> }) {
    this.opts.orchestrator = o;
  }

  async start() {
    await this.runRound();

    // Warm-up: urltest may need a few seconds before exposing the first `now` value.
    if (!this.bestKey) {
      const maxAttempts = 15;
      for (let i = 0; i < maxAttempts && !this.bestKey && !this.stopped; i++) {
        await Bun.sleep(1000);
        await this.runRound(true);
      }
    }

    this.timer = setInterval(() => {
      void this.runRound();
    }, this.opts.intervalSeconds * 1000);

    const bestSyncMs = Math.min(5000, this.opts.intervalSeconds * 1000);
    if (bestSyncMs < this.opts.intervalSeconds * 1000) {
      this.bestSyncTimer = setInterval(() => {
        void this.runRound(true);
      }, bestSyncMs);
    }
  }

  stop() {
    this.stopped = true;
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    if (this.bestSyncTimer) {
      clearInterval(this.bestSyncTimer);
      this.bestSyncTimer = null;
    }
  }

  async runRound(skipRefreshCheck = false): Promise<void> {
    if (this.stopped || this.isRunning) return;
    this.isRunning = true;
    try {
      await this.syncBestFromUrltest();
      if (!skipRefreshCheck) {
        await this.maybeRefresh();
      }
    } catch (e) {
      console.error('[monitor] runRound failed', e);
    } finally {
      this.isRunning = false;
    }
  }

  private async syncBestFromUrltest(): Promise<void> {
    const [outbound, latencies] = await Promise.all([
      this.opts.clash.getCurrentOutbound('proxy-auto'),
      this.opts.clash.getNodeLatencies ? this.opts.clash.getNodeLatencies() : Promise.resolve<Record<string, number | null>>({}),
    ]);

    this.latencyByKey = new Map(Object.entries(latencies));

    const parsed = this.parseBestKey(outbound);
    if (parsed !== this.bestKey) {
      this.bestKey = parsed;
      this.opts.onBestChange?.(this.bestKey);
    }
  }

  private parseBestKey(outboundTag: string | null): string | null {
    if (!outboundTag) return null;

    const candidate = outboundTag.startsWith('out-') ? outboundTag.slice(4) : outboundTag;
    const byKey = this.nodes.find((n) => n.key === candidate);
    if (byKey) return byKey.key;

    const byName = this.nodes.find((n) => n.name === candidate || n.name === outboundTag);
    if (byName) return byName.key;

    return null;
  }

  private async maybeRefresh(): Promise<void> {
    const { refresh, refreshThreshold, refreshCooldownSeconds } = this.opts;
    const total = this.nodes.length;
    if (total === 0) return;

    const nowSec = Date.now() / 1000;
    if (nowSec - this.lastRefreshAt < refreshCooldownSeconds) return;

    const availabilityRatio = this.bestKey ? 1 : 0;
    if (availabilityRatio < refreshThreshold) {
      this.lastRefreshAt = nowSec;
      const newNodes = await refresh();
      const changed = !this.sameNodeSet(this.nodes, newNodes);
      if (changed && this.opts.orchestrator) {
        const ok = await this.opts.orchestrator.blueGreenSwap(newNodes);
        if (ok) {
          this.nodes = newNodes;
          this.bestKey = null;
          this.opts.onBestChange?.(null);
        } else {
          console.error('[monitor] blueGreenSwap failed; keeping old instance');
        }
      } else {
        this.nodes = newNodes;
      }
      await this.syncBestFromUrltest();
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

  getBestNode(): Node | null {
    if (!this.bestKey) return null;
    return this.nodes.find((n) => n.key === this.bestKey) ?? null;
  }

  getBestKey(): string | null {
    return this.bestKey;
  }

  getLatency(key: string): number | null {
    return this.latencyByKey.get(key) ?? null;
  }
}
