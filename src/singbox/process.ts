import { writeFile, mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Node } from '../types.ts';
import { buildConfig } from './config.ts';

export class SingBoxProcess {
  private proc: ReturnType<typeof Bun.spawn> | null = null;
  private configPath: string | null = null;

  constructor(
    private readonly binPath: string,
    private readonly basePort: number,
  ) {}

  async start(nodes: Node[]): Promise<Map<string, number>> {
    const { config, portMap } = buildConfig(nodes, this.basePort);

    // Write config to temp file
    const dir = await mkdtemp(join(tmpdir(), 'singbox-'));
    this.configPath = join(dir, 'config.json');
    await writeFile(this.configPath, JSON.stringify(config, null, 2));

    this.proc = Bun.spawn([this.binPath, 'run', '-c', this.configPath], {
      stdout: 'ignore',
      stderr: 'ignore',
    });

    // Brief delay to let sing-box initialize listeners
    await Bun.sleep(500);

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
