import { describe, it, expect } from 'bun:test';
import { parseVless } from './vless.ts';

describe('parseVless', () => {
  it('parses basic vless URI', () => {
    const uri = 'vless://uuid-1234@example.com:443?encryption=none&security=tls&sni=example.com#VlessNode';
    const node = parseVless(uri);
    expect(node).not.toBeNull();
    expect(node!.protocol).toBe('vless');
    expect(node!.server).toBe('example.com');
    expect(node!.port).toBe(443);
    expect(node!.raw['uuid']).toBe('uuid-1234');
    expect(node!.name).toBe('VlessNode');
  });

  it('parses vless with reality security', () => {
    const uri = 'vless://uuid-abc@host.com:443?security=reality&sni=sni.com&pbk=pubkey&sid=sid1&fp=chrome&flow=xtls-rprx-vision';
    const node = parseVless(uri);
    expect(node).not.toBeNull();
    expect(node!.raw['security']).toBe('reality');
    expect(node!.raw['flow']).toBe('xtls-rprx-vision');
    expect(node!.raw['pbk']).toBe('pubkey');
  });

  it('returns null for non-vless URI', () => {
    expect(parseVless('trojan://xxx')).toBeNull();
  });

  it('returns null for missing port', () => {
    expect(parseVless('vless://uuid@host.com')).toBeNull();
  });

  it('generates stable key', () => {
    const uri = 'vless://uuid@h.com:443?type=tcp';
    const a = parseVless(uri);
    const b = parseVless(uri);
    expect(a!.key).toBe(b!.key);
  });

  it('differs key for different transport params', () => {
    const a = parseVless('vless://uuid@h.com:443?type=tcp');
    const b = parseVless('vless://uuid@h.com:443?type=ws');
    expect(a!.key).not.toBe(b!.key);
  });
});
