import { describe, it, expect } from 'bun:test';
import { parseVmess } from './vmess.ts';

// Helper: build a vmess URI from config object
function makeVmess(cfg: object): string {
  return 'vmess://' + btoa(JSON.stringify(cfg));
}

describe('parseVmess', () => {
  it('parses basic vmess config', () => {
    const uri = makeVmess({ v: '2', ps: 'TestNode', add: '1.2.3.4', port: 8080, id: 'uuid-1234', aid: 0, net: 'tcp', tls: '' });
    const node = parseVmess(uri);
    expect(node).not.toBeNull();
    expect(node!.protocol).toBe('vmess');
    expect(node!.server).toBe('1.2.3.4');
    expect(node!.port).toBe(8080);
    expect(node!.raw['uuid']).toBe('uuid-1234');
    expect(node!.name).toBe('TestNode');
  });

  it('parses vmess with ws transport', () => {
    const uri = makeVmess({ add: '2.2.2.2', port: 443, id: 'uuid-ws', net: 'ws', host: 'cdn.example.com', path: '/ws', tls: 'tls' });
    const node = parseVmess(uri);
    expect(node).not.toBeNull();
    expect(node!.raw['network']).toBe('ws');
    expect(node!.raw['tls']).toBe(true);
    expect(node!.raw['wsPath']).toBe('/ws');
  });

  it('returns null for non-vmess URI', () => {
    expect(parseVmess('trojan://xxx')).toBeNull();
  });

  it('returns null for invalid base64', () => {
    expect(parseVmess('vmess://!!!!')).toBeNull();
  });

  it('returns null for missing required fields', () => {
    const uri = makeVmess({ ps: 'no-addr' });
    expect(parseVmess(uri)).toBeNull();
  });

  it('generates stable key', () => {
    const uri = makeVmess({ add: 'x.com', port: 1234, id: 'uuid', net: 'tcp' });
    const a = parseVmess(uri);
    const b = parseVmess(uri);
    expect(a!.key).toBe(b!.key);
  });
});
