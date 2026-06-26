import { describe, it, expect } from 'bun:test';
import { toOutbound } from './outbound.ts';
import type { Node } from '../types.ts';

function makeNode(overrides: Partial<Node> & Pick<Node, 'protocol' | 'server' | 'port' | 'raw'>): Node {
  return { key: 'testkey12345678', name: 'TestNode', ...overrides };
}

describe('toOutbound - trojan', () => {
  it('produces correct trojan outbound', () => {
    const node = makeNode({
      protocol: 'trojan', server: 't.com', port: 443,
      raw: { password: 'secret', sni: 'sni.com', allowInsecure: false, type: 'tcp' },
    });
    const out = toOutbound(node);
    expect(out['type']).toBe('trojan');
    expect(out['server']).toBe('t.com');
    expect(out['server_port']).toBe(443);
    expect(out['password']).toBe('secret');
    expect((out['tls'] as Record<string, unknown>)['server_name']).toBe('sni.com');
    expect(out['tag']).toBe('out-testkey12345678');
  });
});

describe('toOutbound - vmess', () => {
  it('produces correct vmess tcp outbound', () => {
    const node = makeNode({
      protocol: 'vmess', server: 'v.com', port: 8080,
      raw: { uuid: 'uuid-123', alterId: 0, network: 'tcp', tls: false, sni: '' },
    });
    const out = toOutbound(node);
    expect(out['type']).toBe('vmess');
    expect(out['uuid']).toBe('uuid-123');
    expect(out['tls']).toBeUndefined();
    expect(out['transport']).toBeUndefined();
  });

  it('produces vmess ws+tls outbound', () => {
    const node = makeNode({
      protocol: 'vmess', server: 'v.com', port: 443,
      raw: { uuid: 'uuid-ws', alterId: 0, network: 'ws', tls: true, sni: 'cdn.com', wsPath: '/path', wsHost: 'cdn.com' },
    });
    const out = toOutbound(node);
    expect((out['tls'] as Record<string, unknown>)['enabled']).toBe(true);
    const transport = out['transport'] as Record<string, unknown>;
    expect(transport['type']).toBe('ws');
    expect(transport['path']).toBe('/path');
  });
});

describe('toOutbound - ss', () => {
  it('produces correct shadowsocks outbound', () => {
    const node = makeNode({
      protocol: 'ss', server: 's.com', port: 8388,
      raw: { method: 'aes-256-gcm', password: 'pass' },
    });
    const out = toOutbound(node);
    expect(out['type']).toBe('shadowsocks');
    expect(out['method']).toBe('aes-256-gcm');
    expect(out['password']).toBe('pass');
  });
});

describe('toOutbound - vless', () => {
  it('produces correct vless+reality outbound', () => {
    const node = makeNode({
      protocol: 'vless', server: 'vl.com', port: 443,
      raw: { uuid: 'uuid-vl', flow: 'xtls-rprx-vision', security: 'reality', sni: 'sni.com', pbk: 'pubkey', sid: 'sid1', fp: 'chrome', type: 'tcp', wsPath: '', wsHost: '', encryption: 'none' },
    });
    const out = toOutbound(node);
    expect(out['type']).toBe('vless');
    expect(out['flow']).toBe('xtls-rprx-vision');
    const tls = out['tls'] as Record<string, unknown>;
    expect(tls['enabled']).toBe(true);
    const reality = tls['reality'] as Record<string, unknown>;
    expect(reality['public_key']).toBe('pubkey');
  });
});
