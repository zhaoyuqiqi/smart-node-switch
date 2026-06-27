import { describe, it, expect } from 'bun:test';
import { buildConfig } from './config.ts';
import type { Node } from '../types.ts';

function node(key: string): Node {
  return {
    key, name: `N-${key}`, protocol: 'trojan', server: 'h.com', port: 443,
    raw: { password: 'p', sni: 'h.com' }, originalUri: `trojan://p@h.com:443#${key}`,
  };
}

describe('buildConfig', () => {
  it('allocates a check inbound per node and records portMap', async () => {
    const nodes = [node('a'), node('b')];
    const r = await buildConfig({
      nodes, basePort: 41000, proxyInboundOffset: 0, clashPort: 41900, clashSecret: 's',
    });
    expect(r.portMap.get('a')).toBeGreaterThanOrEqual(41000);
    expect(r.portMap.get('b')).toBeGreaterThanOrEqual(41000);
    expect(r.portMap.get('a')).not.toBe(r.portMap.get('b'));
    expect(r.config.inbounds.some((i) => i['tag'] === 'in-a')).toBe(true);
    expect(r.config.inbounds.some((i) => i['tag'] === 'in-b')).toBe(true);
  });

  it('adds a fixed in-proxy mixed inbound and reports its port', async () => {
    const r = await buildConfig({
      nodes: [node('a')], basePort: 41100, proxyInboundOffset: 0, clashPort: 41950, clashSecret: 's',
    });
    const inProxy = r.config.inbounds.find((i) => i['tag'] === 'in-proxy');
    expect(inProxy).toBeDefined();
    expect(inProxy!['type']).toBe('mixed');
    expect(inProxy!['listen']).toBe('127.0.0.1');
    expect(inProxy!['listen_port']).toBe(r.proxyInboundPort);
  });

  it('adds a selector over all node outbounds with interrupt_exist_connections false', async () => {
    const r = await buildConfig({
      nodes: [node('a'), node('b')], basePort: 41200, proxyInboundOffset: 0, clashPort: 41960, clashSecret: 's',
    });
    const sel = r.config.outbounds.find((o) => o['tag'] === 'proxy-select');
    expect(sel).toBeDefined();
    expect(sel!['type']).toBe('selector');
    expect(sel!['outbounds']).toEqual(['out-a', 'out-b']);
    expect(sel!['interrupt_exist_connections']).toBe(false);
  });

  it('adds a block outbound and routes in-proxy to the selector', async () => {
    const r = await buildConfig({
      nodes: [node('a')], basePort: 41300, proxyInboundOffset: 0, clashPort: 41970, clashSecret: 's',
    });
    expect(r.config.outbounds.some((o) => o['type'] === 'block' && o['tag'] === 'block')).toBe(true);
    expect(r.config.route.rules.some(
      (rule) => Array.isArray(rule['inbound']) && (rule['inbound'] as string[]).includes('in-proxy') && rule['outbound'] === 'proxy-select',
    )).toBe(true);
    expect(r.config.route.rules.some(
      (rule) => Array.isArray(rule['inbound']) && (rule['inbound'] as string[]).includes('in-a') && rule['outbound'] === 'out-a',
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

  it('excludes ports in the exclude set from allocation', async () => {
    const exclude = new Set([41500, 41501]);
    const r = await buildConfig({
      nodes: [node('a')], basePort: 41500, proxyInboundOffset: 0, clashPort: 41990, clashSecret: 's', exclude,
    });
    for (const p of r.usedPorts) {
      expect(exclude.has(p)).toBe(false);
    }
  });
});
