/**
 * Always-on transparent TCP relay. Listens on a fixed public port and pipes
 * each new connection to a mutable upstream port. Switching the upstream does
 * NOT affect connections already established (they stay pinned to their
 * original upstream), enabling graceful blue-green drain.
 */
type TcpSocket = import('bun').Socket;
type TcpServer = import('bun').TCPSocketListener<undefined>;

interface ConnPair {
  upstreamPort: number;
  client: TcpSocket;
  upstream: TcpSocket | null;
  clientBuffer: Uint8Array[]; // bytes received before upstream connected
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
            upstreamReady: false,
          };
          (client as unknown as { data: ConnPair }).data = pair;
          self.conns.add(pair);
          void self.connectUpstream(pair);
        },
        data(client, chunk) {
          const pair = (client as unknown as { data: ConnPair }).data;
          if (pair.upstream && pair.upstreamReady) {
            pair.upstream.write(chunk);
          } else {
            pair.clientBuffer.push(new Uint8Array(chunk));
          }
        },
        close(client) {
          const pair = (client as unknown as { data: ConnPair }).data;
          if (pair) self.teardown(pair, 'client');
        },
        error(client) {
          const pair = (client as unknown as { data: ConnPair }).data;
          if (pair) self.teardown(pair, 'client');
        },
      },
    });
  }

  private async connectUpstream(pair: ConnPair): Promise<void> {
    const self = this;
    try {
      pair.upstream = await Bun.connect({
        hostname: this.upstreamHost,
        port: pair.upstreamPort,
        socket: {
          open(up) {
            pair.upstreamReady = true;
            for (const buffered of pair.clientBuffer) up.write(buffered);
            pair.clientBuffer = [];
          },
          data(_up, chunk) {
            pair.client.write(chunk);
          },
          close() {
            self.teardown(pair, 'upstream');
          },
          error() {
            self.teardown(pair, 'upstream');
          },
        },
      });
    } catch {
      this.teardown(pair, 'upstream');
    }
  }

  private teardown(pair: ConnPair, _origin: 'client' | 'upstream'): void {
    if (!this.conns.has(pair)) return;
    this.conns.delete(pair);
    try { pair.client.end(); } catch {}
    try { pair.upstream?.end(); } catch {}
  }

  stop(): void {
    this.server?.stop(true);
    this.server = null;
    for (const pair of [...this.conns]) this.teardown(pair, 'client');
  }
}
