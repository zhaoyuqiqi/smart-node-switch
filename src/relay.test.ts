import { describe, it, expect, afterEach } from 'bun:test';
import { TcpRelay } from './relay.ts';

// echo server that prefixes each reply with a label, so we can tell A from B
function startEcho(label: string) {
  return Bun.listen({
    hostname: '127.0.0.1',
    port: 0,
    socket: {
      data(socket, data) { socket.write(`${label}:` + data.toString()); },
      open() {},
    },
  });
}

async function sendAndRead(port: number, msg: string, waitMs = 150): Promise<string> {
  let buf = '';
  const conn = await Bun.connect({
    hostname: '127.0.0.1', port,
    socket: { data(_s, d) { buf += d.toString(); }, open(s) { s.write(msg); } },
  });
  await Bun.sleep(waitMs);
  conn.end();
  return buf;
}

const cleanups: Array<() => void> = [];
afterEach(() => { cleanups.forEach((c) => c()); cleanups.length = 0; });

describe('TcpRelay', () => {
  it('transparently forwards to the active upstream', async () => {
    const a = startEcho('A');
    cleanups.push(() => a.stop(true));
    const relay = new TcpRelay({ bindAddress: '127.0.0.1', port: 0, initialUpstreamPort: a.port });
    relay.start();
    cleanups.push(() => relay.stop());
    const reply = await sendAndRead(relay.port, 'hello');
    expect(reply).toBe('A:hello');
  });

  it('new connections use the new upstream after setUpstream', async () => {
    const a = startEcho('A');
    const b = startEcho('B');
    cleanups.push(() => a.stop(true), () => b.stop(true));
    const relay = new TcpRelay({ bindAddress: '127.0.0.1', port: 0, initialUpstreamPort: a.port });
    relay.start();
    cleanups.push(() => relay.stop());
    expect(await sendAndRead(relay.port, 'x')).toBe('A:x');
    relay.setUpstream(b.port);
    expect(await sendAndRead(relay.port, 'y')).toBe('B:y');
  });

  it('keeps an established connection pinned to its original upstream', async () => {
    const a = startEcho('A');
    const b = startEcho('B');
    cleanups.push(() => a.stop(true), () => b.stop(true));
    const relay = new TcpRelay({ bindAddress: '127.0.0.1', port: 0, initialUpstreamPort: a.port });
    relay.start();
    cleanups.push(() => relay.stop());

    let buf = '';
    const conn = await Bun.connect({
      hostname: '127.0.0.1', port: relay.port,
      socket: { data(_s, d) { buf += d.toString(); }, open(s) { s.write('first'); } },
    });
    await Bun.sleep(120);
    expect(buf).toBe('A:first');

    relay.setUpstream(b.port); // switch upstream while conn is open
    buf = '';
    conn.write('second');
    await Bun.sleep(120);
    expect(buf).toBe('A:second'); // still A, not B
    conn.end();
  });

  it('reports active connection counts per upstream', async () => {
    const a = startEcho('A');
    cleanups.push(() => a.stop(true));
    const relay = new TcpRelay({ bindAddress: '127.0.0.1', port: 0, initialUpstreamPort: a.port });
    relay.start();
    cleanups.push(() => relay.stop());
    const conn = await Bun.connect({
      hostname: '127.0.0.1', port: relay.port,
      socket: { data() {}, open(s) { s.write('keepopen'); } },
    });
    await Bun.sleep(80);
    expect(relay.countConnectionsTo(a.port)).toBeGreaterThanOrEqual(1);
    conn.end();
    await Bun.sleep(80);
    expect(relay.countConnectionsTo(a.port)).toBe(0);
  });
});
