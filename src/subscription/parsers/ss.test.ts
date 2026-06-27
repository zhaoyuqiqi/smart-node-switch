import { describe, it, expect } from 'bun:test';
import { parseSs } from './ss.ts';

describe('parseSs', () => {
  it('parses SIP002 format', () => {
    // ss://base64(aes-256-gcm:password)@host:8388#Name
    const userB64 = btoa('aes-256-gcm:mypassword');
    const uri = `ss://${userB64}@example.com:8388#SIP002Node`;
    const node = parseSs(uri);
    expect(node).not.toBeNull();
    expect(node!.protocol).toBe('ss');
    expect(node!.server).toBe('example.com');
    expect(node!.port).toBe(8388);
    expect(node!.raw['method']).toBe('aes-256-gcm');
    expect(node!.raw['password']).toBe('mypassword');
    expect(node!.name).toBe('SIP002Node');
  });

  it('parses legacy base64 format', () => {
    // ss://base64(aes-128-gcm:pass@host:1080)#Name
    const content = btoa('aes-128-gcm:pass@legacy.host:1080');
    const uri = `ss://${content}#LegacyNode`;
    const node = parseSs(uri);
    expect(node).not.toBeNull();
    expect(node!.server).toBe('legacy.host');
    expect(node!.port).toBe(1080);
    expect(node!.raw['method']).toBe('aes-128-gcm');
  });

  it('returns null for non-ss URI', () => {
    expect(parseSs('trojan://xxx')).toBeNull();
  });

  it('returns null for invalid URI', () => {
    expect(parseSs('ss://!!!')).toBeNull();
  });

  it('generates stable key', () => {
    const userB64 = btoa('chacha20:pass');
    const uri = `ss://${userB64}@h.com:443`;
    const a = parseSs(uri);
    const b = parseSs(uri);
    expect(a!.key).toBe(b!.key);
  });

  it('stores the original URI', () => {
    const uri = 'ss://' + btoa('aes-256-gcm:pass') + '@1.2.3.4:8388#SS';
    const node = parseSs(uri);
    expect(node!.originalUri).toBe(uri);
  });
});
