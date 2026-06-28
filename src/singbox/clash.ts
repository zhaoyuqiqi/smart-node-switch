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

  private headers(): Record<string, string> {
    const h: Record<string, string> = { 'Content-Type': 'application/json' };
    if (this.secret) h['Authorization'] = `Bearer ${this.secret}`;
    return h;
  }

  /** Switch the `proxy-select` selector to the given outbound tag. */
  async setSelector(outboundTag: string): Promise<void> {
    const res = await fetch(`${this.baseUrl}/proxies/proxy-select`, {
      method: 'PUT',
      headers: this.headers(),
      body: JSON.stringify({ name: outboundTag }),
    });
    if (res.status < 200 || res.status >= 300) {
      throw new Error(`setSelector(${outboundTag}) failed: HTTP ${res.status}`);
    }
  }

  /** Read current selected outbound tag from a selector/urltest proxy group. */
  async getCurrentOutbound(groupTag: string): Promise<string | null> {
    try {
      const res = await fetch(`${this.baseUrl}/proxies/${groupTag}`, {
        headers: this.headers(),
        signal: AbortSignal.timeout(1000),
      });
      if (res.status < 200 || res.status >= 300) return null;
      const body = await res.json() as { now?: unknown };
      return typeof body.now === 'string' ? body.now : null;
    } catch {
      return null;
    }
  }

  /** Poll GET / until a 2xx response or timeout. */
  async waitReady(timeoutMs: number): Promise<boolean> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      try {
        const res = await fetch(`${this.baseUrl}/`, {
          headers: this.headers(),
          signal: AbortSignal.timeout(Math.min(1000, timeoutMs)),
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
