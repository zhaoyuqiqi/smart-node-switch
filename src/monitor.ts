import type { Node } from './types.ts';

export type RefreshFn = () => Promise<Node[]>;

export interface MonitorOptions {
  refresh: RefreshFn;
  nodes: Node[];
  intervalSeconds: number;
  refreshThreshold: number;
  refreshCooldownSeconds: number;
  clash: { getCurrentOutbound(groupTag: string): Promise<string | null> };
  orchestrator?: { blueGreenSwap(newNodes: Node[]): Promise<boolean> };
  onBestChange?: (bestKey: string | null) => void;
}

export class Monitor {
  private nodes: Node[];
  private timer: ReturnType<typeof setInterval> | null = null;
  private lastRefreshAt = Date.now() / 1000;
  private stopped = false;
  private isRunning = false;
  private bestKey: string | null = null;

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
    this.timer = setInterval(() => {
      void this.runRound();
    }, this.opts.intervalSeconds * 1000);
  }

  stop() {
    this.stopped = true;
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  async runRound(skipRefreshCheck = false): Promise<void> {
    if (this.stopped) return;
    if (this.isRunning && !skipRefreshCheck) return;
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
    const outbound = await this.opts.clash.getCurrentOutbound('proxy-auto');
    const parsed = this.parseBestKey(outbound);
    if (parsed !== this.bestKey) {
      this.bestKey = parsed;
      this.opts.onBestChange?.(this.bestKey);
    }
  }

  private parseBestKey(outboundTag: string | null): string | null {
    if (!outboundTag || !outboundTag.startsWith('out-')) return null;
    const key = outboundTag.slice(4);
    return this.nodes.some((n) => n.key === key) ? key : null;
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

  getBestNode(): Node | null {
    if (!this.bestKey) return null;
    return this.nodes.find((n) => n.key === this.bestKey) ?? null;
  }

  getBestKey(): string | null {
    return this.bestKey;
  }
}
