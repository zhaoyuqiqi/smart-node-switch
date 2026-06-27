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

  it('does not orphan an upstream when the client disconnects before upstream connects', async () => {
    // Slow-accepting upstream: it does not call open() until after the client
    // has already disconnected, so the relay's Bun.connect resolves AFTER the
    // pair has been torn down. The fixed relay must .end() that late upstream.
    let upstreamOpened = 0;
    let upstreamClosed = 0;
    const slow = Bun.listen({
      hostname: '127.0.0.1',
      port: 0,
      socket: {
        open() { upstreamOpened++; },
        close() { upstreamClosed++; },
        data() {},
      },
    });
    cleanups.push(() => slow.stop(true));

    const relay = new TcpRelay({ bindAddress: '127.0.0.1', port: 0, initialUpstreamPort: slow.port });
    relay.start();
    cleanups.push(() => relay.stop());

    // Connect then immediately disconnect, before the upstream connection settles.
    const conn = await Bun.connect({
      hostname: '127.0.0.1', port: relay.port,
      socket: { data() {}, open(s) { s.end(); } },
    });
    conn.end();

    await Bun.sleep(120);

    // No lingering relay pairs, and any upstream that did connect was closed.
    expect(relay.activeConnectionCount).toBe(0);
    expect(relay.countConnectionsTo(slow.port)).toBe(0);
    expect(upstreamClosed).toBe(upstreamOpened);
  });

  it('delivers first bytes written immediately on connect (no upstream-connect race)', async () => {
    // Regression for the C1 upstream-connect race. The buggy relay gated
    // forwarding on `pair.upstream && pair.upstreamReady` while assigning
    // `pair.upstream` only AFTER `await Bun.connect(...)` resolved -- one turn
    // later than the upstream `open` callback that flips `upstreamReady` and
    // flushes the buffer. Any client chunk observed while ready=true but
    // upstream=null is buffered-and-forgotten -> first-byte loss. The fix
    // assigns `pair.upstream` INSIDE `open` and single-sources readiness on
    // `upstreamReady`, so this contract holds: bytes written synchronously on
    // connect (with NO sleep before the first write, unlike the older tests)
    // must be delivered to upstream and echoed back, exactly and in order.
    //
    // We open many connections concurrently to maximise interleaving pressure
    // and poll (no fixed sleep) for every byte to come back.
    const a = startEcho('A');
    cleanups.push(() => a.stop(true));
    const relay = new TcpRelay({ bindAddress: '127.0.0.1', port: 0, initialUpstreamPort: a.port });
    relay.start();
    cleanups.push(() => relay.stop());

    const N = 50;
    const bufs: string[] = new Array(N).fill('');
    const conns = await Promise.all(
      Array.from({ length: N }, (_, i) =>
        Bun.connect({
          hostname: '127.0.0.1', port: relay.port,
          socket: {
            data(_s, d) { bufs[i] += d.toString(); },
            open(s) { try { s.write(`FIRST${i};`); } catch {} },
          },
        }),
      ),
    );

    // The labeled echo prefixes each data event with `A:`; assert on the
    // payload (label-stripped) so TCP coalescing does not affect the result.
    const payload = (i: number) => (bufs[i] ?? '').split('A:').join('');
    const expected = (i: number) => `FIRST${i};`;
    const allDone = () => bufs.every((_b, i) => payload(i) === expected(i));
    const deadline = Date.now() + 4000;
    while (!allDone() && Date.now() < deadline) await Bun.sleep(5);
    conns.forEach((c) => c.end());

    for (let i = 0; i < N; i++) expect(payload(i)).toBe(expected(i));
  });

  it('tears down a connection that buffers beyond the pre-ready byte cap', async () => {
    // Keep the upstream connection PENDING (never ready, never fast-failing) by
    // pointing the relay at a non-routable TEST-NET-1 address (192.0.2.1). This
    // guarantees a long pre-ready window: every client byte accumulates in the
    // pre-ready `clientBuffer`. The client floods ~2 MiB, well over the 1 MiB
    // MAX_PENDING_BYTES cap, so the relay must tear the connection down (rather
    // than buffer unbounded / OOM). Because upstream never connects, the ONLY
    // way the relay closes the client here is the byte cap -- isolating it.
    const relay = new TcpRelay({
      bindAddress: '127.0.0.1', port: 0, initialUpstreamPort: 9, upstreamHost: '192.0.2.1',
    });
    relay.start();
    cleanups.push(() => relay.stop());

    let clientClosed = false;
    const big = 'x'.repeat(64 * 1024); // 64 KiB per write
    const conn = await Bun.connect({
      hostname: '127.0.0.1', port: relay.port,
      socket: {
        data() {},
        open(s) {
          // Drip ~2 MiB across macrotask ticks so each write becomes a separate
          // relay `data` event; the running total crosses the 1 MiB cap and the
          // relay tears the (still upstream-pending) connection down.
          for (let k = 0; k < 32; k++) {
            setTimeout(() => { try { s.write(big); } catch {} }, k);
          }
        },
        close() { clientClosed = true; },
        error() { clientClosed = true; },
      },
    });

    // Poll for the cap-triggered teardown rather than a fixed sleep.
    const deadline = Date.now() + 3000;
    while (!clientClosed && Date.now() < deadline) await Bun.sleep(5);
    conn.end();

    expect(clientClosed).toBe(true);
    expect(relay.activeConnectionCount).toBe(0);
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
