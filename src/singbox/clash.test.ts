import { describe, it, expect, afterEach } from 'bun:test';
import { ClashClient, clashBaseUrl } from './clash.ts';

let server: ReturnType<typeof Bun.serve> | null = null;
afterEach(() => { server?.stop(true); server = null; });

describe('ClashClient.setSelector', () => {
  it('PUTs the selector name with bearer auth', async () => {
    const seen: { method?: string; path?: string; auth?: string; body?: any } = {};
    server = Bun.serve({
      port: 0,
      async fetch(req) {
        const url = new URL(req.url);
        seen.method = req.method;
        seen.path = url.pathname;
        seen.auth = req.headers.get('authorization') ?? undefined;
        seen.body = await req.json();
        return new Response('', { status: 204 });
      },
    });
    const client = new ClashClient(`http://127.0.0.1:${server.port}`, 'sekret');
    await client.setSelector('out-abc');
    expect(seen.method).toBe('PUT');
    expect(seen.path).toBe('/proxies/proxy-select');
    expect(seen.auth).toBe('Bearer sekret');
    expect(seen.body).toEqual({ name: 'out-abc' });
  });

  it('throws on non-2xx response', async () => {
    server = Bun.serve({ port: 0, fetch() { return new Response('nope', { status: 500 }); } });
    const client = new ClashClient(`http://127.0.0.1:${server.port}`, 's');
    await expect(client.setSelector('out-x')).rejects.toThrow();
  });
});

describe('ClashClient.getCurrentOutbound', () => {
  it('returns now field from proxy group response', async () => {
    server = Bun.serve({
      port: 0,
      fetch(req) {
        const url = new URL(req.url);
        if (url.pathname === '/proxies/proxy-auto') {
          return new Response(JSON.stringify({ now: 'out-abc' }), { status: 200 });
        }
        return new Response('not found', { status: 404 });
      },
    });
    const client = new ClashClient(`http://127.0.0.1:${server.port}`, 's');
    expect(await client.getCurrentOutbound('proxy-auto')).toBe('out-abc');
  });

  it('retries with Token auth when Bearer auth is rejected', async () => {
    server = Bun.serve({
      port: 0,
      fetch(req) {
        const auth = req.headers.get('authorization');
        const url = new URL(req.url);
        if (url.pathname !== '/proxies/proxy-auto') {
          return new Response('not found', { status: 404 });
        }
        if (auth === 'Token s') {
          return new Response(JSON.stringify({ now: 'out-token' }), { status: 200 });
        }
        return new Response(JSON.stringify({ message: 'Unauthorized' }), { status: 401 });
      },
    });
    const client = new ClashClient(`http://127.0.0.1:${server.port}`, 's');
    expect(await client.getCurrentOutbound('proxy-auto')).toBe('out-token');
  });

  it('falls back to GET /proxies map when /proxies/{group} is unavailable', async () => {
    server = Bun.serve({
      port: 0,
      fetch(req) {
        const url = new URL(req.url);
        if (url.pathname === '/proxies/proxy-auto') {
          return new Response('not found', { status: 404 });
        }
        if (url.pathname === '/proxies') {
          return new Response(JSON.stringify({
            proxies: {
              'proxy-auto': { now: 'out-fallback' },
            },
          }), { status: 200 });
        }
        return new Response('not found', { status: 404 });
      },
    });
    const client = new ClashClient(`http://127.0.0.1:${server.port}`, 's');
    expect(await client.getCurrentOutbound('proxy-auto')).toBe('out-fallback');
  });

  it('supports selected field as current outbound', async () => {
    server = Bun.serve({
      port: 0,
      fetch(req) {
        const url = new URL(req.url);
        if (url.pathname === '/proxies/proxy-auto') {
          return new Response(JSON.stringify({ selected: 'out-selected' }), { status: 200 });
        }
        return new Response('not found', { status: 404 });
      },
    });
    const client = new ClashClient(`http://127.0.0.1:${server.port}`, 's');
    expect(await client.getCurrentOutbound('proxy-auto')).toBe('out-selected');
  });
});

describe('ClashClient.getNodeLatencies', () => {
  it('returns latest delay for out-* proxies keyed by node key', async () => {
    server = Bun.serve({
      port: 0,
      fetch(req) {
        const url = new URL(req.url);
        if (url.pathname !== '/proxies') {
          return new Response('not found', { status: 404 });
        }
        return new Response(JSON.stringify({
          proxies: {
            'proxy-auto': { now: 'out-aaa' },
            'out-aaa': {
              history: [
                { time: '2026-06-28T15:00:00+08:00', delay: 300 },
                { time: '2026-06-28T15:00:05+08:00', delay: 120 },
              ],
            },
            'out-bbb': {
              history: [
                { time: '2026-06-28T15:00:00+08:00', delay: 250 },
              ],
            },
            'direct': {
              history: [
                { time: '2026-06-28T15:00:00+08:00', delay: 1 },
              ],
            },
          },
        }), { status: 200 });
      },
    });
    const client = new ClashClient(`http://127.0.0.1:${server.port}`, 's');
    expect(await client.getNodeLatencies()).toEqual({ aaa: 120, bbb: 250 });
  });
});

describe('ClashClient.waitReady', () => {
  it('returns true once GET / responds 2xx', async () => {
    server = Bun.serve({ port: 0, fetch() { return new Response('{}', { status: 200 }); } });
    const client = new ClashClient(`http://127.0.0.1:${server.port}`, 's');
    expect(await client.waitReady(2000)).toBe(true);
  });

  it('returns false when never ready before timeout', async () => {
    // point at a port with nothing listening
    const client = new ClashClient('http://127.0.0.1:6', 's');
    expect(await client.waitReady(300)).toBe(false);
  });
});

describe('clashBaseUrl', () => {
  it('builds a loopback url', () => {
    expect(clashBaseUrl(9090)).toBe('http://127.0.0.1:9090');
  });
});
