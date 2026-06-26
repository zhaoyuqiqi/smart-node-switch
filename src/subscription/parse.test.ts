import { describe, it, expect } from 'bun:test';
import { parseSubscription } from './parse.ts';

describe('parseSubscription', () => {
  it('parses mixed protocol lines', () => {
    const trojanUri = 'trojan://pass@t.com:443#T1';
    const vmessUri = 'vmess://' + btoa(JSON.stringify({ add: 'v.com', port: 8080, id: 'uuid-v', net: 'tcp', ps: 'V1' }));
    const ssUri = 'ss://' + btoa('aes-256-gcm:pwd') + '@s.com:8388#S1';
    const vlessUri = 'vless://uuid-vl@vl.com:443?type=tcp#VL1';

    const nodes = parseSubscription([trojanUri, vmessUri, ssUri, vlessUri]);
    expect(nodes).toHaveLength(4);
    const protocols = nodes.map(n => n.protocol);
    expect(protocols).toContain('trojan');
    expect(protocols).toContain('vmess');
    expect(protocols).toContain('ss');
    expect(protocols).toContain('vless');
  });

  it('skips unsupported protocols', () => {
    const nodes = parseSubscription(['http://proxy.com', 'socks5://proxy.com', 'trojan://pass@h.com:443']);
    expect(nodes).toHaveLength(1);
  });

  it('skips invalid entries', () => {
    const nodes = parseSubscription(['trojan://', 'vmess://!!!invalid!!!', 'trojan://pass@h.com:443']);
    expect(nodes).toHaveLength(1);
  });

  it('deduplicates by key', () => {
    const uri = 'trojan://pass@dup.com:443#Name1';
    const uri2 = 'trojan://pass@dup.com:443#Name2'; // same connection, different name
    const nodes = parseSubscription([uri, uri2]);
    expect(nodes).toHaveLength(1);
  });

  it('handles empty input', () => {
    expect(parseSubscription([])).toHaveLength(0);
  });

  it('handles blank lines', () => {
    const nodes = parseSubscription(['', '   ', 'trojan://pass@h.com:443']);
    expect(nodes).toHaveLength(1);
  });

  it('decodes base64 subscription lines', () => {
    // simulate a base64-encoded subscription with a trojan line
    const plainLine = 'trojan://pass@h2.com:443#B64Node';
    const lines = [plainLine];
    const nodes = parseSubscription(lines);
    expect(nodes).toHaveLength(1);
    expect(nodes[0]!.name).toBe('B64Node');
  });
});
