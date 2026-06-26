import type { Node } from '../types.ts';
import { toOutbound } from './outbound.ts';

export interface SingBoxConfig {
  log: { level: string };
  inbounds: Record<string, unknown>[];
  outbounds: Record<string, unknown>[];
  route: { rules: Record<string, unknown>[] };
}

export interface BuildConfigResult {
  config: SingBoxConfig;
  portMap: Map<string, number>;
}

/**
 * Build sing-box config: one inbound + one outbound per node, with route rules.
 */
export function buildConfig(nodes: Node[], basePort: number): BuildConfigResult {
  const portMap = new Map<string, number>();
  const inbounds: Record<string, unknown>[] = [];
  const outbounds: Record<string, unknown>[] = [];
  const rules: Record<string, unknown>[] = [];

  nodes.forEach((node, i) => {
    const port = basePort + i;
    portMap.set(node.key, port);

    inbounds.push({
      type: 'mixed',
      tag: `in-${node.key}`,
      listen: '127.0.0.1',
      listen_port: port,
    });

    outbounds.push(toOutbound(node));

    rules.push({
      inbound: [`in-${node.key}`],
      outbound: `out-${node.key}`,
    });
  });

  const config: SingBoxConfig = {
    log: { level: 'warn' },
    inbounds,
    outbounds,
    route: { rules },
  };

  return { config, portMap };
}
