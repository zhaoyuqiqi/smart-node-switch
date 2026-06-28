/**
 * Minimal Clash API client for sing-box runtime selector/urltest control.
 */
export function clashBaseUrl(port: number): string {
  return `http://127.0.0.1:${port}`;
}

export class ClashClient {
  constructor(
    private readonly baseUrl: string,
    private readonly secret: string,
  ) {}

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
      const groupRes = await this.fetchWithAuth(`/proxies/${encodeURIComponent(groupTag)}`, {
        signal: AbortSignal.timeout(1500),
      });
      if (groupRes.status >= 200 && groupRes.status < 300) {
        const body = await groupRes.json();
        const direct = this.extractCurrentOutbound(body);
        if (direct) return direct;
      }

      // Fallback: some implementations expose the value only in GET /proxies map.
      const allRes = await this.fetchWithAuth('/proxies', {
        signal: AbortSignal.timeout(1500),
      });
      if (allRes.status < 200 || allRes.status >= 300) return null;
      const allBody = await allRes.json() as { proxies?: Record<string, unknown> };
      const group = allBody.proxies?.[groupTag];
      return this.extractCurrentOutbound(group);
    } catch {
      return null;
    }
  }

  async getNodeLatencies(): Promise<Record<string, number | null>> {
    try {
      const res = await this.fetchWithAuth('/proxies', {
        signal: AbortSignal.timeout(1500),
      });
      if (res.status < 200 || res.status >= 300) return {};
      const body = await res.json() as { proxies?: Record<string, unknown> };
      const proxies = body.proxies ?? {};
      const result: Record<string, number | null> = {};
      for (const [tag, payload] of Object.entries(proxies)) {
        if (!tag.startsWith('out-')) continue;
        const key = tag.slice(4);
        result[key] = this.extractLatestDelayMs(payload);
      }
      return result;
    } catch {
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
