/**
 * Port availability probing and exclusion-aware allocation for sing-box.
 */

/** True if a TCP listen on host:port succeeds (port is free). */
export async function isPortFree(port: number, host = '127.0.0.1'): Promise<boolean> {
  try {
    const server = Bun.listen({ hostname: host, port, socket: { data() {} } });
    server.stop(true);
    return true;
  } catch {
    return false;
  }
}

/**
 * Collect `count` free ports starting at `startPort`, skipping any port in
 * `exclude` or already in use. Scans a bounded range to avoid infinite loops.
 */
export async function allocatePorts(
  count: number,
  startPort: number,
  exclude: Set<number> = new Set(),
): Promise<number[]> {
  const result: number[] = [];
  const maxScan = count * 50 + 200; // bounded headroom for occupied/excluded ports
  let port = startPort;
  let scanned = 0;
  while (result.length < count && scanned < maxScan) {
    if (!exclude.has(port) && (await isPortFree(port))) {
      result.push(port);
    }
    port++;
    scanned++;
  }
  if (result.length < count) {
    throw new Error(
      `allocatePorts: only found ${result.length}/${count} free ports from ${startPort}`,
    );
  }
  return result;
}
