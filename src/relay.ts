/**
 * Always-on transparent TCP relay. Listens on a fixed public port and pipes
 * each new connection to a mutable upstream port. Switching the upstream does
 * NOT affect connections already established (they stay pinned to their
 * original upstream), enabling graceful blue-green drain.
 */
type TcpSocket = import('bun').Socket;
type TcpServer = import('bun').TCPSocketListener<undefined>;

/**
 * Maximum number of bytes we will buffer from the client while the upstream
 * connection is still being established. If a client sends more than this
 * before upstream is ready, we tear the connection down rather than risk
 * unbounded memory growth (OOM). 1 MiB.
 */
const MAX_PENDING_BYTES = 1024 * 1024;

interface ConnPair {
  upstreamPort: number;
  client: TcpSocket;
  upstream: TcpSocket | null;
  clientBuffer: Uint8Array[]; // bytes received before upstream connected
  pendingBytes: number; // total bytes currently held in clientBuffer
  upstreamReady: boolean;
}

export interface RelayOptions {
  bindAddress: string;
  port: number;
  initialUpstreamPort: number;
  upstreamHost?: string;
}

export class TcpRelay {
  private server: TcpServer | null = null;
  private upstreamPort: number;
  private readonly upstreamHost: string;
  private readonly conns = new Set<ConnPair>();

  constructor(private readonly opts: RelayOptions) {
    this.upstreamPort = opts.initialUpstreamPort;
    this.upstreamHost = opts.upstreamHost ?? '127.0.0.1';
  }

  get port(): number {
    return this.server?.port ?? this.opts.port;
  }

  get activeUpstreamPort(): number {
    return this.upstreamPort;
  }

  get activeConnectionCount(): number {
    return this.conns.size;
  }

  countConnectionsTo(port: number): number {
    let n = 0;
    for (const c of this.conns) if (c.upstreamPort === port) n++;
    return n;
  }

  setUpstream(port: number): void {
    this.upstreamPort = port;
  }

  start(): void {
    const self = this;
    this.server = Bun.listen({
      hostname: this.opts.bindAddress,
      port: this.opts.port,
      socket: {
        open(client) {
          const pair: ConnPair = {
            upstreamPort: self.upstreamPort, // snapshot at accept time
            client,
            upstream: null,
            clientBuffer: [],
            pendingBytes: 0,
            upstreamReady: false,
          };
          (client as unknown as { data: ConnPair }).data = pair;
          self.conns.add(pair);
          void self.connectUpstream(pair);
        },
        data(client, chunk) {
          const pair = (client as unknown as { data: ConnPair }).data;
          // Single readiness signal: once `upstreamReady` is true the upstream
          // socket is assigned (set together inside upstream `open`), so there
          // is no window where ready is true but `upstream` is still null.
          // NOTE: backpressure on the established client<->upstream pipe is not
          // yet handled here (writes ignore the socket's writability / drain).
          if (pair.upstreamReady) {
            pair.upstream!.write(chunk);
          } else {
            // Bound the pre-ready buffer: never grow it without limit while the
            // upstream is still connecting.
            pair.pendingBytes += chunk.byteLength;
            if (pair.pendingBytes > MAX_PENDING_BYTES) {
              self.teardown(pair);
              return;
            }
            pair.clientBuffer.push(new Uint8Array(chunk));
          }
        },
        close(client) {
          const pair = (client as unknown as { data: ConnPair }).data;
          if (pair) self.teardown(pair);
        },
        error(client) {
          const pair = (client as unknown as { data: ConnPair }).data;
          if (pair) self.teardown(pair);
        },
      },
    });
  }

  private async connectUpstream(pair: ConnPair): Promise<void> {
    const self = this;
    try {
      const upstream = await Bun.connect({
        hostname: this.upstreamHost,
        port: pair.upstreamPort,
        socket: {
          open(up) {
            // The client may have already disconnected while this upstream
            // connection was still pending. In that case the pair was torn
            // down and removed from `conns`; close this orphaned upstream now.
            if (!self.conns.has(pair)) {
              try { up.end(); } catch {}
              return;
            }
            // Assign the upstream socket and flip readiness HERE, atomically,
            // using the local `up` socket. In Bun this `open` callback can fire
            // BEFORE the surrounding `await Bun.connect(...)` resolves, so we
            // must NOT wait for the await to assign `pair.upstream` -- doing so
            // leaves a window where `upstreamReady` is true but `pair.upstream`
            // is still null, in which any client chunk would be buffered and
            // never re-flushed (first-byte loss). Single-sourcing readiness on
            // `upstreamReady` (set together with `pair.upstream`) closes that
            // race: bytes buffered before this point are flushed exactly once
            // and in order, and bytes arriving after go straight through.
            pair.upstream = up;
            pair.upstreamReady = true;
            for (const buffered of pair.clientBuffer) up.write(buffered);
            pair.clientBuffer = [];
            pair.pendingBytes = 0;
          },
          data(_up, chunk) {
            pair.client.write(chunk);
          },
          close() {
            self.teardown(pair);
          },
          error() {
            self.teardown(pair);
          },
        },
      });
      // If the pair was torn down before connect resolved (and `open` never
      // ran, so it could not close the socket itself), ensure the freshly
      // resolved socket is closed rather than orphaned.
      if (!this.conns.has(pair)) {
        try { upstream.end(); } catch {}
        return;
      }
    } catch {
      this.teardown(pair);
    }
  }

  private teardown(pair: ConnPair): void {
    if (!this.conns.has(pair)) return;
    this.conns.delete(pair);
    try { pair.client.end(); } catch {}
    try { pair.upstream?.end(); } catch {}
  }

  stop(): void {
    this.server?.stop(true);
    this.server = null;
    for (const pair of [...this.conns]) this.teardown(pair);
  }
}
