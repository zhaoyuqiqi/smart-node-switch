import { describe, it, expect, mock, beforeEach } from 'bun:test';

describe('probe', () => {
  beforeEach(() => {
    // Reset fetch mock before each test
    mock.restore();
  });

  it('returns ok=true and latency on successful fetch', async () => {
    // Mock global fetch
    const originalFetch = global.fetch;
    global.fetch = mock(() =>
      Promise.resolve(new Response(null, { status: 204 }))
    ) as unknown as typeof fetch;

    const { probe } = await import('./probe.ts');
    const result = await probe(30000, 'https://www.google.com', 5000);

    expect(result.ok).toBe(true);
    expect(result.latencyMs).toBeGreaterThanOrEqual(0);

    global.fetch = originalFetch;
  });

  it('returns ok=false on network error', async () => {
    const originalFetch = global.fetch;
    global.fetch = mock(() => Promise.reject(new Error('connection refused'))) as unknown as typeof fetch;

    const { probe } = await import('./probe.ts');
    const result = await probe(30001, 'https://www.google.com', 5000);

    expect(result.ok).toBe(false);
    expect(result.latencyMs).toBeGreaterThanOrEqual(0);

    global.fetch = originalFetch;
  });

  it('returns ok=false for 4xx status', async () => {
    const originalFetch = global.fetch;
    global.fetch = mock(() =>
      Promise.resolve(new Response(null, { status: 404 }))
    ) as unknown as typeof fetch;

    const { probe } = await import('./probe.ts');
    const result = await probe(30002, 'http://example.com', 5000);

    expect(result.ok).toBe(false);

    global.fetch = originalFetch;
  });
});
