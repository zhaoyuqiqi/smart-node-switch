import { describe, it, expect } from 'bun:test';
import { SingBoxInstance, type SpawnHandle } from './instance.ts';
import type { Node } from '../types.ts';

function node(key: string): Node {
  return { key, name: key, protocol: 'trojan', server: 'h.com', port: 443, raw: { password: 'p' }, originalUri: `trojan://p@h.com:443#${key}` };
}

// fake spawn that stays "running" (exitCode null)
function runningSpawn(): { fn: (cmd: string[]) => SpawnHandle; killed: () => boolean } {
  let killed = false;
  return {
    killed: () => killed,
    fn: () => ({ exitCode: null, kill() { killed = true; }, exited: Promise.resolve(0) }),
  };
}

describe('SingBoxInstance.start', () => {
  it('builds config and records ports without throwing when process stays up', async () => {
    const s = runningSpawn();
    const inst = new SingBoxInstance({
      binPath: 'fake', nodes: [node('a'), node('b')], basePort: 42000,
      proxyInboundOffset: 0, clashPort: 42900, clashSecret: 's',
      readyTimeoutMs: 500, spawn: s.fn,
    });
    await inst.start();
    expect(inst.portMap.size).toBe(0);
    expect(inst.proxyInboundPort).toBeGreaterThanOrEqual(42000);
    expect(inst.clashPort).toBe(42900);
    await inst.stop();
    expect(s.killed()).toBe(true);
  });

  it('retries on a higher port range when the first spawn exits immediately', async () => {
    let calls = 0;
    const spawn = (_cmd: string[]): SpawnHandle => {
      calls++;
      const dies = calls === 1; // first attempt "loses port race"
      return { exitCode: dies ? 1 : null, kill() {}, exited: Promise.resolve(dies ? 1 : 0) };
    };
    const inst = new SingBoxInstance({
      binPath: 'fake', nodes: [node('a')], basePort: 43000,
      proxyInboundOffset: 0, clashPort: 43900, clashSecret: 's',
      readyTimeoutMs: 300, spawn, maxStartRetries: 1, portStride: 1000,
    });
    await inst.start();
    expect(calls).toBe(2);
    expect(inst.clashPort).toBe(44900); // bumped by stride on retry
  });

  it('throws after exhausting retries', async () => {
    const spawn = (_cmd: string[]): SpawnHandle => ({ exitCode: 1, kill() {}, exited: Promise.resolve(1) });
    const inst = new SingBoxInstance({
      binPath: 'fake', nodes: [node('a')], basePort: 45000,
      proxyInboundOffset: 0, clashPort: 45900, clashSecret: 's',
      readyTimeoutMs: 100, spawn, maxStartRetries: 1,
    });
    await expect(inst.start()).rejects.toThrow();
  });
});

describe('SingBoxInstance.ready', () => {
  it('returns false when clash never becomes ready', async () => {
    const spawn = (_cmd: string[]): SpawnHandle => ({ exitCode: null, kill() {}, exited: Promise.resolve(0) });
    const inst = new SingBoxInstance({
      binPath: 'fake', nodes: [node('a')], basePort: 46000,
      proxyInboundOffset: 0, clashPort: 46900, clashSecret: 's',
      readyTimeoutMs: 300, spawn,
    });
    await inst.start();
    // nothing is listening on clash/in-proxy ports -> not ready
    expect(await inst.ready()).toBe(false);
    await inst.stop();
  });
});
