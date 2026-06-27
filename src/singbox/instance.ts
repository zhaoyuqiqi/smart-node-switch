import { writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Node } from '../types.ts';
import { buildConfig } from './config.ts';
import { ClashClient, clashBaseUrl } from './clash.ts';

export interface SpawnHandle {
  exitCode: number | null;
  kill(): void;
  exited: Promise<number>;
}
export type SpawnFn = (cmd: string[]) => SpawnHandle;

export interface InstanceParams {
  binPath: string;
  nodes: Node[];
  basePort: number;
  proxyInboundOffset: number;
  clashPort: number;
  clashSecret: string;
  readyTimeoutMs: number;
  exclude?: Set<number>;
  spawn?: SpawnFn;
  maxStartRetries?: number;
  portStride?: number;
}

function defaultSpawn(cmd: string[]): SpawnHandle {
  const proc = Bun.spawn(cmd, { stdout: 'pipe', stderr: 'pipe' });
  return {
    get exitCode() {
      return proc.exitCode;
    },
    kill() {
      proc.kill();
    },
    exited: proc.exited,
  };
}

async function tcpReachable(port: number, _timeoutMs: number): Promise<boolean> {
  try {
    const conn = await Bun.connect({
      hostname: '127.0.0.1',
      port,
      socket: { data() {}, open() {} },
    });
    conn.end();
    return true;
  } catch {
    return false;
  }
}

export class SingBoxInstance {
  private proc: SpawnHandle | null = null;
  private readonly configPath: string;
  private _portMap = new Map<string, number>();
  private _proxyInboundPort = 0;
  private _clashPort: number;
  private _usedPorts: number[] = [];
  public clash: ClashClient;

  constructor(private readonly params: InstanceParams) {
    this._clashPort = params.clashPort;
    this.configPath = join(tmpdir(), `singbox-${params.basePort}-${Date.now()}.json`);
    this.clash = new ClashClient(clashBaseUrl(params.clashPort), params.clashSecret);
  }

  get portMap() {
    return this._portMap;
  }
  get proxyInboundPort() {
    return this._proxyInboundPort;
  }
  get clashPort() {
    return this._clashPort;
  }
  get usedPorts() {
    return this._usedPorts;
  }

  async start(): Promise<void> {
    const spawn = this.params.spawn ?? defaultSpawn;
    const stride = this.params.portStride ?? 1000;
    const maxRetries = this.params.maxStartRetries ?? 1;

    let basePort = this.params.basePort;
    let clashPort = this.params.clashPort;
    let lastErr: unknown = null;

    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      const built = await buildConfig({
        nodes: this.params.nodes,
        basePort,
        proxyInboundOffset: this.params.proxyInboundOffset,
        clashPort,
        clashSecret: this.params.clashSecret,
        exclude: this.params.exclude,
      });
      await writeFile(this.configPath, JSON.stringify(built.config, null, 2));
      const proc = spawn([this.params.binPath, 'run', '-c', this.configPath]);

      await Bun.sleep(1500); // let sing-box bind ports
      if (proc.exitCode === null) {
        // running
        this.proc = proc;
        this._portMap = built.portMap;
        this._proxyInboundPort = built.proxyInboundPort;
        this._clashPort = clashPort;
        this._usedPorts = built.usedPorts;
        this.clash = new ClashClient(clashBaseUrl(clashPort), this.params.clashSecret);
        return;
      }
      lastErr = new Error(`sing-box exited (code ${proc.exitCode}) on attempt ${attempt + 1}`);
      basePort += stride;
      clashPort += stride;
    }
    throw lastErr ?? new Error('sing-box failed to start');
  }

  async ready(): Promise<boolean> {
    const clashOk = await this.clash.waitReady(this.params.readyTimeoutMs);
    if (!clashOk) return false;
    return tcpReachable(this._proxyInboundPort, this.params.readyTimeoutMs);
  }

  async stop(): Promise<void> {
    if (this.proc) {
      this.proc.kill();
      await this.proc.exited;
      this.proc = null;
    }
  }
}
