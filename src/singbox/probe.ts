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
    const ok = res.status > 0 && res.status < 400;
    if (!ok) {
      console.log(`[probe] port=${port} status=${res.status} (not ok)`);
    }
    return { ok, latencyMs };
  } catch (err) {
    const latencyMs = Date.now() - start;
    console.log(`[probe] port=${port} error: ${(err as Error)?.message ?? err}`);
    return { ok: false, latencyMs };
  }
}
