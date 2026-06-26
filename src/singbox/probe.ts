export interface ProbeResult {
  ok: boolean;
  latencyMs: number;
}

/**
 * Probe a node's local proxy port by requesting testUrl through it.
 * Uses Bun fetch with proxy option.
 */
export async function probe(port: number, testUrl: string, timeoutMs: number): Promise<ProbeResult> {
  const start = Date.now();
  try {
    const res = await fetch(testUrl, {
      proxy: `http://127.0.0.1:${port}`,
      signal: AbortSignal.timeout(timeoutMs),
    } as RequestInit);
    const latencyMs = Date.now() - start;
    return { ok: res.status > 0 && res.status < 400, latencyMs };
  } catch {
    return { ok: false, latencyMs: Date.now() - start };
  }
}
