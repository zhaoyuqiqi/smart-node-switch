import { describe, it, expect } from 'bun:test';
import { parseTrojan } from './trojan.ts';

describe('parseTrojan', () => {
  it('parses basic trojan URI', () => {
    const node = parseTrojan('trojan://mypassword@example.com:443#MyNode');
    expect(node).not.toBeNull();
    expect(node!.protocol).toBe('trojan');
    expect(node!.server).toBe('example.com');
    expect(node!.port).toBe(443);
    expect(node!.raw['password']).toBe('mypassword');
    expect(node!.name).toBe('MyNode');
  });

  it('parses trojan URI with query params', () => {
    const node = parseTrojan('trojan://pass@host.com:443?sni=sni.host.com&type=ws#ws-node');
    expect(node).not.toBeNull();
    expect(node!.raw['sni']).toBe('sni.host.com');
    expect(node!.raw['type']).toBe('ws');
  });

  it('keeps allowInsecure as boolean for outbound mapping', () => {
    const node = parseTrojan('trojan://pass@host.com:443?allowInsecure=1&sni=sni.host.com#n1');
    expect(node).not.toBeNull();
    expect(node!.raw['allowInsecure']).toBe(true);
  });

  it('returns null for non-trojan URI', () => {
    expect(parseTrojan('vmess://xxx')).toBeNull();
    expect(parseTrojan('ss://xxx')).toBeNull();
  });

  it('returns null for invalid URI', () => {
    expect(parseTrojan('trojan://no-host')).toBeNull();
    expect(parseTrojan('trojan://')).toBeNull();
  });

  it('generates stable key for same connection params', () => {
    const a = parseTrojan('trojan://pass@example.com:443#Name1');
    const b = parseTrojan('trojan://pass@example.com:443#Name2');
    expect(a!.key).toBe(b!.key);
  });

  it('generates different key for different server', () => {
    const a = parseTrojan('trojan://pass@a.com:443');
    const b = parseTrojan('trojan://pass@b.com:443');
    expect(a!.key).not.toBe(b!.key);
  });

  it('stores the original URI', () => {
    const uri = 'trojan://pass@example.com:443#MyNode';
    const node = parseTrojan(uri);
    expect(node!.originalUri).toBe(uri);
  });
});
