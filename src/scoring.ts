import type { NodeState } from './types.ts';

/**
 * Score a node state. Lower is better.
 * Formula: latency * 0.7 + failCount * 100 + (now - lastCheck) * 0.001
 */
export function score(state: NodeState, now: number): number {
  return state.latency * 0.7 + state.failCount * 100 + (now - state.lastCheck) * 0.001;
}
