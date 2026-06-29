import { describe, it, expect } from 'bun:test';
import { buildConfig } from './config.ts';
import type { Node } from '../types.ts';

function node(key: string): Node {
  return {
    key, name: `N-${key}`, protocol: 'trojan', server: 'h.com', port: 443,
    raw: { password: 'p', sni: 'h.com' }, originalUri: `trojan://p@h.com:443#${key}`,
  };
}

describe('buildConfig(urltest)', () => {
  it('creates a single in-proxy inbound and reports its port', async () => {
    const r = await buildConfig({
      nodes: [node('a')], basePort: 41100, proxyInboundOffset: 0, clashPort: 41950, clashSecret: 's',
    });
    expect(r.config.inbounds.length).toBe(1);
    const inProxy = r.config.inbounds.find((i) => i['tag'] === 'in-proxy');
    expect(inProxy).toBeDefined();
    expect(inProxy!['type']).toBe('mixed');
    expect(inProxy!['listen_port']).toBe(r.proxyInboundPort);
  });

  it('adds mixed inbound auth users when proxy credentials are provided', async () => {
    const r = await buildConfig({
      nodes: [node('a')],
      basePort: 41120,
      proxyInboundOffset: 0,
      clashPort: 41951,
      clashSecret: 's',
      proxyAuthUser: 'demo-user',
      proxyAuthPass: 'demo-pass',
    });
    const inProxy = r.config.inbounds.find((i) => i['tag'] === 'in-proxy');
    expect(inProxy).toBeDefined();
    expect(inProxy!['users']).toEqual([{ username: 'demo-user', password: 'demo-pass' }]);
  });

  it('adds urltest outbound over all node outbounds', async () => {
    const r = await buildConfig({
      nodes: [node('a'), node('b')], basePort: 41200, proxyInboundOffset: 0, clashPort: 41960, clashSecret: 's', testUrl: 'https://http://cp.cloudflare.com',
    });
    const auto = r.config.outbounds.find((o) => o['tag'] === 'proxy-auto');
    expect(auto).toBeDefined();
    expect(auto!['type']).toBe('urltest');
    expect(auto!['outbounds']).toEqual(['out-a', 'out-b']);
    expect(auto!['url']).toBe('https://http://cp.cloudflare.com');
    expect(auto!['interval']).toBe('3m');
    expect(auto!['interrupt_exist_connections']).toBe(false);
  });

  it('supports custom urltest interval from config', async () => {
    const r = await buildConfig({
      nodes: [node('a'), node('b')],
      basePort: 41220,
      proxyInboundOffset: 0,
      clashPort: 41961,
      clashSecret: 's',
      urltestInterval: '45s',
    });
    const auto = r.config.outbounds.find((o) => o['tag'] === 'proxy-auto');
    expect(auto).toBeDefined();
    expect(auto!['interval']).toBe('45s');
  });

  it('routes in-proxy to proxy-auto', async () => {
    const r = await buildConfig({
      nodes: [node('a')], basePort: 41300, proxyInboundOffset: 0, clashPort: 41970, clashSecret: 's',
    });
    expect(r.config.route.rules.some(
      (rule) => Array.isArray(rule['inbound']) && (rule['inbound'] as string[]).includes('in-proxy') && rule['outbound'] === 'proxy-auto',
    )).toBe(true);
  });

  it('enables clash_api with controller and secret', async () => {
    const r = await buildConfig({
      nodes: [node('a')], basePort: 41400, proxyInboundOffset: 0, clashPort: 41980, clashSecret: 'topsecret',
    });
    expect(r.config.experimental.clash_api.external_controller).toBe('127.0.0.1:41980');
    expect(r.config.experimental.clash_api.secret).toBe('topsecret');
    expect(r.clashPort).toBe(41980);
  });

  it('supports exposing clash_api on all interfaces', async () => {
    const r = await buildConfig({
      nodes: [node('a')],
      basePort: 41420,
      proxyInboundOffset: 0,
      clashPort: 41981,
      clashBindAddress: '0.0.0.0',
      clashSecret: 'topsecret',
    });
    expect(r.config.experimental.clash_api.external_controller).toBe('0.0.0.0:41981');
  });

  it('excludes occupied ports from allocation', async () => {
    const exclude = new Set([41500]);
    const r = await buildConfig({
      nodes: [node('a')], basePort: 41500, proxyInboundOffset: 0, clashPort: 41990, clashSecret: 's', exclude,
    });
    for (const p of r.usedPorts) {
      expect(exclude.has(p)).toBe(false);
    }
  });
});
