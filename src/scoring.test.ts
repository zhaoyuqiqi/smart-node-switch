import { describe, it, expect } from 'bun:test';
import { score } from './scoring.ts';
import type { NodeState } from './types.ts';

function makeState(overrides: Partial<NodeState> = {}): NodeState {
  return {
    latency: 100,
    failCount: 0,
    successCount: 1,
    lastCheck: 1000000,
    name: 'test',
    protocol: 'trojan',
    server: 's.com',
    port: 443,
    ...overrides,
  };
}

describe('score', () => {
  it('computes correct formula value', () => {
    const state = makeState({ latency: 100, failCount: 0, lastCheck: 1000000 });
    const now = 1001000; // 1s later
    const expected = 100 * 0.7 + 0 * 100 + 1000 * 0.001;
    expect(score(state, now)).toBeCloseTo(expected);
  });

  it('failCount dominates latency at high count', () => {
    // good: latency=500, failCount=0 → 500*0.7=350
    // bad:  latency=10,  failCount=4 → 10*0.7+4*100=407  > 350
    const good = makeState({ latency: 500, failCount: 0, lastCheck: 1000000 });
    const bad = makeState({ latency: 10, failCount: 4, lastCheck: 1000000 });
    const now = 1000000;
    expect(score(bad, now)).toBeGreaterThan(score(good, now));
  });

  it('returns 0 for perfect state at check time', () => {
    const state = makeState({ latency: 0, failCount: 0, lastCheck: 1000 });
    expect(score(state, 1000)).toBe(0);
  });

  it('higher latency gives higher score', () => {
    const fast = makeState({ latency: 50, failCount: 0, lastCheck: 1000 });
    const slow = makeState({ latency: 200, failCount: 0, lastCheck: 1000 });
    const now = 1000;
    expect(score(slow, now)).toBeGreaterThan(score(fast, now));
  });

  it('older lastCheck gives higher score', () => {
    const recent = makeState({ latency: 100, failCount: 0, lastCheck: 900 });
    const old = makeState({ latency: 100, failCount: 0, lastCheck: 0 });
    const now = 1000;
    expect(score(old, now)).toBeGreaterThan(score(recent, now));
  });
});
