import { writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Node } from '../types.ts';
import { buildConfig } from './config.ts';

export class SingBoxProcess {
  private proc: ReturnType<typeof Bun.spawn> | null = null;
  private readonly configPath: string;

  constructor(
    private readonly binPath: string,
    private readonly basePort: number,
  ) {
    this.configPath = join(tmpdir(), 'singbox-config.json');
  }

  async start(nodes: Node[]): Promise<Map<string, number>> {
    const { config, portMap } = await buildConfig({
      nodes,
      basePort: this.basePort,
      proxyInboundOffset: 0,
      clashPort: this.basePort + 9000,
      clashSecret: 'legacy',
    });

    // Overwrite fixed config file
    await writeFile(this.configPath, JSON.stringify(config, null, 2));

    this.proc = Bun.spawn([this.binPath, 'run', '-c', this.configPath], {
      stdout: 'pipe',
      stderr: 'pipe',
    });

    // Collect stderr for error reporting
    let stderrOutput = '';
    const stderr = this.proc.stderr;
    if (stderr && typeof stderr !== 'number') {
      void (async () => {
        const reader = (stderr as ReadableStream<Uint8Array>).getReader();
        const decoder = new TextDecoder();
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          const chunk = decoder.decode(value);
          stderrOutput += chunk;
          process.stderr.write('[sing-box] ' + chunk);
        }
      })();
    }
    void stderrOutput; // captured for error reporting below

    // Wait for sing-box to initialize, then verify it's still running
    await Bun.sleep(1500);
    if (this.proc.exitCode !== null) {
      throw new Error(`sing-box exited (code ${this.proc.exitCode}):\n${stderrOutput.trim()}`);
    }

    return portMap;
  }

  async restart(nodes: Node[]): Promise<Map<string, number>> {
    await this.stop();
    return this.start(nodes);
  }

  async stop(): Promise<void> {
    if (this.proc) {
      this.proc.kill();
      await this.proc.exited;
      this.proc = null;
    }
  }
}
