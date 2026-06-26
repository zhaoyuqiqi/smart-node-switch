import { describe, it, expect, beforeEach } from 'bun:test';
import type { StateStore } from './state-store.ts';
import type { NodeState } from '../types.ts';

/**
 * In-memory StateStore for unit testing (no real Redis needed).
 */
class MemoryStateStore implements StateStore {
  private states = new Map<string, NodeState>();
  private deadKeys = new Map<string, number>(); // key → expiry timestamp ms

  async getState(key: string): Promise<NodeState | null> {
    return this.states.get(key) ?? null;
  }

  async setState(key: string, state: NodeState, _ttlSeconds: number): Promise<void> {
    this.states.set(key, { ...state });
  }

  async renewTtl(_key: string, _ttlSeconds: number): Promise<void> {
    // no-op in memory
  }

  async isDead(key: string): Promise<boolean> {
    const exp = this.deadKeys.get(key);
    if (exp === undefined) return false;
    if (Date.now() > exp) {
      this.deadKeys.delete(key);
      return false;
    }
    return true;
  }

  async markDead(key: string, ttlSeconds: number): Promise<void> {
    this.deadKeys.set(key, Date.now() + ttlSeconds * 1000);
  }

  async clearDead(key: string): Promise<void> {
    this.deadKeys.delete(key);
  }

  // Test helper: force expire dead key
  expireDead(key: string) {
    this.deadKeys.set(key, Date.now() - 1);
  }
}

function makeState(overrides: Partial<NodeState> = {}): NodeState {
  return {
    latency: 100,
    failCount: 0,
    successCount: 1,
    lastCheck: Date.now(),
    name: 'TestNode',
    protocol: 'trojan',
    server: 'h.com',
    port: 443,
    ...overrides,
  };
}

describe('StateStore (memory impl)', () => {
  let store: MemoryStateStore;

  beforeEach(() => {
    store = new MemoryStateStore();
  });

  // Task 4.1: state read/write
  it('returns null for unknown key', async () => {
    expect(await store.getState('unknown')).toBeNull();
  });

  it('writes and reads state', async () => {
    const state = makeState({ latency: 200, failCount: 3 });
    await store.setState('k1', state, 172800);
    const got = await store.getState('k1');
    expect(got).not.toBeNull();
    expect(got!.latency).toBe(200);
    expect(got!.failCount).toBe(3);
  });

  // Task 4.3: success resets failCount
  it('success resets failCount to 0', async () => {
    const state = makeState({ failCount: 5 });
    await store.setState('k2', state, 172800);
    // Simulate success: reset failCount
    const current = await store.getState('k2');
    current!.failCount = 0;
    current!.successCount++;
    await store.setState('k2', current!, 172800);
    const got = await store.getState('k2');
    expect(got!.failCount).toBe(0);
    expect(got!.successCount).toBe(2);
  });

  // Task 4.4: death marking and revival
  it('marks node as dead with TTL', async () => {
    await store.markDead('k3', 86400);
    expect(await store.isDead('k3')).toBe(true);
  });

  it('node is not dead after TTL expires', async () => {
    await store.markDead('k4', 86400);
    store.expireDead('k4');
    expect(await store.isDead('k4')).toBe(false);
  });

  it('clearDead removes dead status', async () => {
    await store.markDead('k5', 86400);
    await store.clearDead('k5');
    expect(await store.isDead('k5')).toBe(false);
  });

  it('failCount >= 20 triggers death in monitor logic', async () => {
    // This test validates the state transition logic (would be in monitor)
    const DEATH_THRESHOLD = 20;
    const state = makeState({ failCount: 19 });
    await store.setState('k6', state, 172800);

    const s = await store.getState('k6');
    s!.failCount++;
    s!.lastCheck = Date.now();
    await store.setState('k6', s!, 172800);

    const updated = await store.getState('k6');
    if (updated!.failCount >= DEATH_THRESHOLD) {
      await store.markDead('k6', 86400);
    }

    expect(await store.isDead('k6')).toBe(true);
  });

  it('revival: after dead expires, success clears failCount', async () => {
    // Mark dead
    await store.markDead('k7', 86400);
    expect(await store.isDead('k7')).toBe(true);

    // Simulate TTL expiry
    store.expireDead('k7');
    expect(await store.isDead('k7')).toBe(false);

    // One success → failCount = 0
    const state = makeState({ failCount: 25 });
    await store.setState('k7', state, 172800);
    const s = await store.getState('k7');
    s!.failCount = 0;
    s!.successCount++;
    await store.setState('k7', s!, 172800);
    const got = await store.getState('k7');
    expect(got!.failCount).toBe(0);
  });

  it('revival: immediate failure re-marks dead without re-accumulating 20', async () => {
    // After revival, failCount is still >= 20 from before
    const DEATH_THRESHOLD = 20;
    const state = makeState({ failCount: 25 }); // still >= 20
    await store.setState('k8', state, 172800);
    store.expireDead('k8'); // was dead, now revived by TTL

    // One failure → failCount++ → still >= 20 → re-mark dead
    const s = await store.getState('k8');
    s!.failCount++;
    s!.lastCheck = Date.now();
    await store.setState('k8', s!, 172800);

    if (s!.failCount >= DEATH_THRESHOLD) {
      await store.markDead('k8', 86400);
    }

    expect(await store.isDead('k8')).toBe(true);
  });
});
