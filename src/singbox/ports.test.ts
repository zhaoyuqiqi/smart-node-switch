import { describe, it, expect, afterEach } from 'bun:test';
import { isPortFree, allocatePorts } from './ports.ts';

describe('isPortFree', () => {
  const servers: Array<{ stop: () => void }> = [];
  afterEach(() => { servers.forEach((s) => s.stop()); servers.length = 0; });

  it('returns true for a free port', async () => {
    // pick a high port unlikely to be used
    expect(await isPortFree(54011)).toBe(true);
  });

  it('returns false for an occupied port', async () => {
    const srv = Bun.listen({ hostname: '127.0.0.1', port: 54012, socket: { data() {} } });
    servers.push(srv);
    expect(await isPortFree(54012)).toBe(false);
  });
});

describe('allocatePorts', () => {
  const servers: Array<{ stop: () => void }> = [];
  afterEach(() => { servers.forEach((s) => s.stop()); servers.length = 0; });

  it('allocates count free ports from startPort', async () => {
    const ports = await allocatePorts(3, 54020);
    expect(ports.length).toBe(3);
    expect(new Set(ports).size).toBe(3);
    for (const p of ports) expect(p).toBeGreaterThanOrEqual(54020);
  });

  it('skips occupied ports', async () => {
    const srv = Bun.listen({ hostname: '127.0.0.1', port: 54030, socket: { data() {} } });
    servers.push(srv);
    const ports = await allocatePorts(2, 54030);
    expect(ports).not.toContain(54030);
    expect(ports.length).toBe(2);
  });

  it('skips ports in the exclude set', async () => {
    const ports = await allocatePorts(2, 54040, new Set([54040, 54041]));
    expect(ports).not.toContain(54040);
    expect(ports).not.toContain(54041);
    expect(ports.length).toBe(2);
  });
});
