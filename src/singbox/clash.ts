/**
 * Minimal Clash API client for sing-box runtime selector/urltest control.
 */
const DEBUG_CLASH = process.env['DEBUG_MONITOR'] === '1' || process.env['DEBUG_MONITOR'] === 'true';

export function clashBaseUrl(port: number): string {
  return `http://127.0.0.1:${port}`;
}

export class ClashClient {
  constructor(
    private readonly baseUrl: string,
    private readonly secret: string,
  ) {}

  private debug(label: string, payload?: unknown): void {
    if (!DEBUG_CLASH) return;
    if (payload === undefined) {
      console.log('[clash:debug]', label);
      return;
    }
    try {
      const raw = JSON.stringify(payload);
      const truncated = raw.length > 8000 ? `${raw.slice(0, 8000)} ...(truncated)` : raw;
      console.log('[clash:debug]', label, truncated);
    } catch {
      console.log('[clash:debug]', label, payload);
    }
  }

  private authValues(): string[] {
    if (!this.secret) return [''];
    return [
      `Bearer ${this.secret}`,
      `Token ${this.secret}`,
      this.secret,
    ];
  }

  private headers(authValue?: string): Record<string, string> {
    const h: Record<string, string> = { 'Content-Type': 'application/json' };
    if (authValue) h['Authorization'] = authValue;
    return h;
  }

  private async fetchWithAuth(path: string, init: RequestInit = {}): Promise<Response> {
    let lastRes: Response | null = null;
    for (const auth of this.authValues()) {
      const headers = {
        ...this.headers(auth),
        ...(init.headers as Record<string, string> | undefined),
      };
      const res = await fetch(`${this.baseUrl}${path}`, { ...init, headers });
      lastRes = res;
      if (res.status !== 401 && res.status !== 403) return res;
    }
    if (lastRes) return lastRes;
    throw new Error('fetchWithAuth: no response');
  }

  /** Switch the `proxy-select` selector to the given outbound tag. */
  async setSelector(outboundTag: string): Promise<void> {
    const res = await this.fetchWithAuth('/proxies/proxy-select', {
      method: 'PUT',
      body: JSON.stringify({ name: outboundTag }),
    });
    if (res.status < 200 || res.status >= 300) {
      throw new Error(`setSelector(${outboundTag}) failed: HTTP ${res.status}`);
    }
  }

  private extractCurrentOutbound(payload: unknown): string | null {
    if (!payload || typeof payload !== 'object') return null;
    const obj = payload as Record<string, unknown>;
    const direct = obj['now'] ?? obj['current'] ?? obj['selected'];
    if (typeof direct === 'string') return direct;
    return null;
  }

  private extractLatestDelayMs(payload: unknown): number | null {
    if (!payload || typeof payload !== 'object') return null;
    const obj = payload as Record<string, unknown>;
    const history = obj['history'];
    if (!Array.isArray(history)) return null;

    for (let i = history.length - 1; i >= 0; i -= 1) {
      const item = history[i];
      if (!item || typeof item !== 'object') continue;
      const delay = (item as Record<string, unknown>)['delay'];
      if (typeof delay === 'number' && Number.isFinite(delay) && delay >= 0) {
        return delay;
      }
    }
    return null;
  }

  /** Read current selected outbound tag from a selector/urltest proxy group. */
  async getCurrentOutbound(groupTag: string): Promise<string | null> {
    try {
      const groupPath = `/proxies/${encodeURIComponent(groupTag)}`;
      const groupRes = await this.fetchWithAuth(groupPath, {
        signal: AbortSignal.timeout(1500),
      });
      if (groupRes.status >= 200 && groupRes.status < 300) {
        const body = await groupRes.json();
        this.debug(`GET ${groupPath} response`, body);
        const direct = this.extractCurrentOutbound(body);
        this.debug(`GET ${groupPath} parsed outbound`, { outbound: direct });
        if (direct) return direct;
      } else {
        this.debug(`GET ${groupPath} non-2xx`, { status: groupRes.status });
      }

      // Fallback: some implementations expose the value only in GET /proxies map.
      const allRes = await this.fetchWithAuth('/proxies', {
        signal: AbortSignal.timeout(1500),
      });
      if (allRes.status < 200 || allRes.status >= 300) {
        this.debug('GET /proxies non-2xx in getCurrentOutbound', { status: allRes.status });
        return null;
      }
      const allBody = await allRes.json() as { proxies?: Record<string, unknown> };
      this.debug('GET /proxies response (fallback for current outbound)', allBody);
      const group = allBody.proxies?.[groupTag];
      this.debug(`fallback group payload: ${groupTag}`, group ?? null);
      const outbound = this.extractCurrentOutbound(group);
      this.debug(`fallback parsed outbound: ${groupTag}`, { outbound });
      return outbound;
    } catch (error) {
      this.debug(`getCurrentOutbound error: ${groupTag}`, {
        error: error instanceof Error ? error.message : String(error),
      });
      return null;
    }
  }

  async getNodeLatencies(): Promise<Record<string, number | null>> {
    try {
      const res = await this.fetchWithAuth('/proxies', {
        signal: AbortSignal.timeout(1500),
      });
      if (res.status < 200 || res.status >= 300) {
        this.debug('GET /proxies non-2xx in getNodeLatencies', { status: res.status });
        return {};
      }
      const body = await res.json() as { proxies?: Record<string, unknown> };
      this.debug('GET /proxies response (for latencies)', body);
      const proxies = body.proxies ?? {};
      const result: Record<string, number | null> = {};
      for (const [tag, payload] of Object.entries(proxies)) {
        if (!tag.startsWith('out-')) continue;
        const key = tag.slice(4);
        result[key] = this.extractLatestDelayMs(payload);
      }
      const nonNullLatencyCount = Object.values(result).filter((v) => v !== null).length;
      this.debug('parsed latency snapshot', {
        outbounds: Object.keys(result).length,
        nonNullLatencyCount,
        latencies: result,
      });
      return result;
    } catch (error) {
      this.debug('getNodeLatencies error', {
        error: error instanceof Error ? error.message : String(error),
      });
      return {};
    }
  }

  /** Poll GET / until a 2xx response or timeout. */
  async waitReady(timeoutMs: number): Promise<boolean> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      try {
        const left = Math.max(1, deadline - Date.now());
        const res = await this.fetchWithAuth('/', {
          signal: AbortSignal.timeout(Math.min(1000, left)),
        });
        if (res.status >= 200 && res.status < 300) return true;
      } catch {
        // not ready yet
      }
      await Bun.sleep(100);
    }
    return false;
  }
}
