import type { Node } from '../types.ts';

export interface InstanceLike {
  start(): Promise<void>;
  ready(): Promise<boolean>;
  stop(): Promise<void>;
  portMap: Map<string, number>;
  proxyInboundPort: number;
  usedPorts: number[];
  clash: { setSelector(tag: string): Promise<void> };
}

export interface RelayLike {
  setUpstream(port: number): void;
  countConnectionsTo(port: number): number;
}

export interface OrchestratorParams {
  relay: RelayLike;
  initial: InstanceLike;
  createInstance: (nodes: Node[], exclude: Set<number>) => InstanceLike;
  maxDrainSeconds: number;
  onActiveChange?: (inst: InstanceLike) => void;
  drainPollMs?: number;
}

export class InstanceOrchestrator {
  private _active: InstanceLike;

  constructor(private readonly params: OrchestratorParams) {
    this._active = params.initial;
  }

  get active(): InstanceLike {
    return this._active;
  }

  /**
   * Blue-green swap to a new instance built from newNodes.
   * Returns true if the upstream was switched; false if the new instance
   * failed readiness (old instance retained).
   */
  async blueGreenSwap(newNodes: Node[]): Promise<boolean> {
    const old = this._active;
    const exclude = new Set(old.usedPorts);
    const next = this.params.createInstance(newNodes, exclude);

    try {
      await next.start();
    } catch {
      try { await next.stop(); } catch {}
      return false;
    }

    const ok = await next.ready();
    if (!ok) {
      try { await next.stop(); } catch {}
      return false;
    }

    this._active = next;
    this.params.onActiveChange?.(next);
    this.params.relay.setUpstream(next.proxyInboundPort);

    // Graceful drain of the old instance in the background.
    void this.drainAndStop(old);
    return true;
  }

  private async drainAndStop(old: InstanceLike): Promise<void> {
    const pollMs = this.params.drainPollMs ?? 1000;
    const deadline = Date.now() + this.params.maxDrainSeconds * 1000;
    while (Date.now() < deadline) {
      if (this.params.relay.countConnectionsTo(old.proxyInboundPort) <= 0) break;
      await Bun.sleep(pollMs);
    }
    try { await old.stop(); } catch {}
  }
}
