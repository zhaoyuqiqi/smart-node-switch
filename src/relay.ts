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
  private accepting = true;

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

  setAccepting(accepting: boolean): void {
    this.accepting = accepting;
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
          if (!self.accepting) {
            try { client.end(); } catch {}
            return;
          }
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
          if (pair.upstreamReady) {
            pair.upstream!.write(chunk);
          } else {
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
            if (!self.conns.has(pair)) {
              try { up.end(); } catch {}
              return;
            }
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
