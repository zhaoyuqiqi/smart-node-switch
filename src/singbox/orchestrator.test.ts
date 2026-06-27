import { describe, it, expect } from 'bun:test';
import { InstanceOrchestrator, type InstanceLike, type RelayLike } from './orchestrator.ts';
import type { Node } from '../types.ts';

function node(key: string): Node {
  return { key, name: key, protocol: 'trojan', server: 'h.com', port: 443, raw: {}, originalUri: '' };
}

function fakeInstance(over: Partial<Omit<InstanceLike, 'ready'>> & { proxyInboundPort: number; ready?: boolean }): InstanceLike {
  const setCalls: string[] = [];
  const inst: any = {
    started: false, stopped: false, selectorCalls: setCalls,
    proxyInboundPort: over.proxyInboundPort,
    portMap: over.portMap ?? new Map(),
    usedPorts: over.usedPorts ?? [over.proxyInboundPort],
    async start() { this.started = true; },
    async ready() { return over.ready ?? true; },
    async stop() { this.stopped = true; },
    clash: { async setSelector(t: string) { setCalls.push(t); } },
  };
  return inst;
}

function fakeRelay(): RelayLike & { upstream: number; counts: Map<number, number> } {
  const counts = new Map<number, number>();
  return {
    upstream: 0,
    counts,
    setUpstream(p) { this.upstream = p; },
    countConnectionsTo(p) { return counts.get(p) ?? 0; },
  };
}

describe('InstanceOrchestrator.blueGreenSwap', () => {
  it('switches relay upstream only after the new instance is ready', async () => {
    const relay = fakeRelay();
    const oldInst = fakeInstance({ proxyInboundPort: 5000 });
    relay.setUpstream(oldInst.proxyInboundPort);
    const newInst = fakeInstance({ proxyInboundPort: 6000 });
    const orch = new InstanceOrchestrator({
      relay, initial: oldInst,
      createInstance: () => newInst,
      maxDrainSeconds: 0, drainPollMs: 5,
    });
    const ok = await orch.blueGreenSwap([node('a')]);
    expect(ok).toBe(true);
    expect((newInst as any).started).toBe(true);
    expect(relay.upstream).toBe(6000);
    expect(orch.active).toBe(newInst);
  });

  it('keeps the old instance and returns false when the new one is not ready', async () => {
    const relay = fakeRelay();
    const oldInst = fakeInstance({ proxyInboundPort: 5000 });
    relay.setUpstream(5000);
    const newInst = fakeInstance({ proxyInboundPort: 6000, ready: false });
    const orch = new InstanceOrchestrator({
      relay, initial: oldInst, createInstance: () => newInst,
      maxDrainSeconds: 0, drainPollMs: 5,
    });
    const ok = await orch.blueGreenSwap([node('a')]);
    expect(ok).toBe(false);
    expect(relay.upstream).toBe(5000);        // unchanged
    expect((newInst as any).stopped).toBe(true); // discarded
    expect(orch.active).toBe(oldInst);
  });

  it('drains old connections then stops the old instance', async () => {
    const relay = fakeRelay();
    const oldInst = fakeInstance({ proxyInboundPort: 5000 });
    relay.setUpstream(5000);
    relay.counts.set(5000, 1); // one lingering connection
    const newInst = fakeInstance({ proxyInboundPort: 6000 });
    const orch = new InstanceOrchestrator({
      relay, initial: oldInst, createInstance: () => newInst,
      maxDrainSeconds: 5, drainPollMs: 10,
    });
    await orch.blueGreenSwap([node('a')]);
    expect((oldInst as any).stopped).toBe(false); // still draining
    relay.counts.set(5000, 0);                    // connection closes
    await Bun.sleep(40);
    expect((oldInst as any).stopped).toBe(true);
  });

  it('hard-stops the old instance after maxDrainSeconds even if connections linger', async () => {
    const relay = fakeRelay();
    const oldInst = fakeInstance({ proxyInboundPort: 5000 });
    relay.setUpstream(5000);
    relay.counts.set(5000, 3); // never drains
    const newInst = fakeInstance({ proxyInboundPort: 6000 });
    const orch = new InstanceOrchestrator({
      relay, initial: oldInst, createInstance: () => newInst,
      maxDrainSeconds: 0.05, drainPollMs: 10, // 50ms cap
    });
    await orch.blueGreenSwap([node('a')]);
    await Bun.sleep(120);
    expect((oldInst as any).stopped).toBe(true);
  });

  it('passes old usedPorts as exclude to createInstance', async () => {
    const relay = fakeRelay();
    const oldInst = fakeInstance({ proxyInboundPort: 5000, usedPorts: [5000, 5001, 5900] });
    relay.setUpstream(5000);
    let seenExclude: Set<number> | null = null;
    const newInst = fakeInstance({ proxyInboundPort: 6000 });
    const orch = new InstanceOrchestrator({
      relay, initial: oldInst,
      createInstance: (_n, exclude) => { seenExclude = exclude; return newInst; },
      maxDrainSeconds: 0, drainPollMs: 5,
    });
    await orch.blueGreenSwap([node('a')]);
    expect([...(seenExclude as unknown as Set<number>)]).toEqual([5000, 5001, 5900]);
  });
});
