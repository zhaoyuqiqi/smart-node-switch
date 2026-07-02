import type { NodeStatistics } from './types.ts';

function clamp(v: number, min = 0, max = 100): number {
  return Math.max(min, Math.min(max, v));
}

function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return -1;
  const idx = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1));
  return sorted[idx] ?? -1;
}

function median(sorted: number[]): number {
  if (sorted.length === 0) return -1;
  const mid = Math.floor(sorted.length / 2);
  if (sorted.length % 2 === 1) return sorted[mid] ?? -1;
  const left = sorted[mid - 1] ?? -1;
  const right = sorted[mid] ?? -1;
  return (left + right) / 2;
}

function calcJitter(values: number[]): number {
  if (values.length === 0) return 0;
  const avg = values.reduce((s, v) => s + v, 0) / values.length;
  const variance = values.reduce((s, v) => s + (v - avg) ** 2, 0) / values.length;
  return Math.sqrt(variance);
}

function rttScore(rtt: number): number {
  if (rtt < 250) return 100;
  if (rtt < 350) return 90;
  if (rtt < 450) return 75;
  if (rtt < 600) return 55;
  return 30;
}

function jitterScore(jitter: number): number {
  if (jitter < 20) return 100;
  if (jitter < 50) return 85;
  if (jitter < 100) return 65;
  return 40;
}

function successScore(rate: number): number {
  if (rate >= 99) return 100;
  if (rate >= 97) return 90;
  if (rate >= 95) return 80;
  if (rate >= 90) return 60;
  return 30;
}

function p95Score(p95: number): number {
  if (p95 < 300) return 100;
  if (p95 < 400) return 85;
  if (p95 < 600) return 65;
  return 40;
}

function calcBaseScore(n: NodeStatistics): number {
  if (n.consecutiveFailure >= 5) return 0;
  if (n.successRate < 85) return 20;
  if (n.sampleCount < 5) return 50;

  const rtt = rttScore(n.medianRtt);
  const jitter = jitterScore(n.jitter);
  const success = successScore(n.successRate);
  const p95 = p95Score(n.p95Rtt);

  let score = rtt * 0.4 + jitter * 0.2 + success * 0.3 + p95 * 0.1;
  score -= n.consecutiveFailure * 5;
  return clamp(score);
}

function round2(n: number): number {
  return Number(n.toFixed(2));
}

export function computeNodeStatistics(samples: number[]): NodeStatistics {
  const currentRtt = samples.at(-1) ?? -1;
  const successful = samples.filter((v) => v >= 0).sort((a, b) => a - b);
  const sampleCount = samples.length;
  const successCount = successful.length;
  const successRate = sampleCount === 0 ? 0 : (successCount / sampleCount) * 100;

  let consecutiveFailure = 0;
  for (let i = samples.length - 1; i >= 0; i -= 1) {
    if ((samples[i] ?? -1) >= 0) break;
    consecutiveFailure += 1;
  }

  const avgRtt = successCount === 0 ? -1 : round2(successful.reduce((s, v) => s + v, 0) / successCount);
  const medianRtt = successCount === 0 ? -1 : round2(median(successful));
  const p95Rtt = successCount === 0 ? -1 : round2(percentile(successful, 95));
  const jitter = round2(calcJitter(successful));

  return {
    currentRtt,
    avgRtt,
    medianRtt,
    p95Rtt,
    jitter,
    successRate: round2(successRate),
    consecutiveFailure,
    sampleCount,
  };
}

export function calculateNodeScore(stats: NodeStatistics, samples: number[]): number {
  if (samples.length === 0) return 0;

  const current = samples.at(-1) ?? -1;
  if (current < 0) return 0;

  if (stats.successRate < 90) return 0;

  let score = calcBaseScore(stats);
  if (score <= 0) return 0;

  const prev = samples.at(-2);
  if (prev === -1 && current >= 0) {
    score -= 30;
  }

  return round2(clamp(score));
}
