import type { Node } from '../types.ts';
import { toOutbound } from './outbound.ts';
import { allocatePorts } from './ports.ts';

export interface SingBoxConfig {
  log: { level: string };
  inbounds: Record<string, unknown>[];
  outbounds: Record<string, unknown>[];
  route: { rules: Record<string, unknown>[] };
  experimental: { clash_api: { external_controller: string; secret: string } };
}

export interface BuildConfigParams {
  nodes: Node[];
  basePort: number;
  proxyInboundOffset: number;
  clashPort: number;
  clashSecret: string;
  exclude?: Set<number>;
}

export interface BuildConfigResult {
  config: SingBoxConfig;
  portMap: Map<string, number>;
  proxyInboundPort: number;
  clashPort: number;
  usedPorts: number[];
}

/**
 * Build sing-box config for one instance:
 * - per-node check inbound (mixed) + outbound, routed in-<key> -> out-<key>
 * - fixed in-proxy mixed inbound -> selector (proxy-select) over all node outbounds
 * - block outbound; clash_api enabled for runtime selector control
 * Ports are allocated by availability, skipping `exclude` and occupied ports.
 */
export async function buildConfig(params: BuildConfigParams): Promise<BuildConfigResult> {
  const { nodes, basePort, proxyInboundOffset, clashPort, clashSecret, exclude } = params;
  const excludeSet = new Set(exclude ?? []);

  // 1 port per node check inbound + 1 in-proxy port
  const needed = nodes.length + 1;
  const ports = await allocatePorts(needed, basePort, excludeSet);

  const portMap = new Map<string, number>();
  const inbounds: Record<string, unknown>[] = [];
  const outbounds: Record<string, unknown>[] = [];
  const rules: Record<string, unknown>[] = [];
  const usedPorts: number[] = [clashPort];

  nodes.forEach((node, i) => {
    const port = ports[i]!;
    portMap.set(node.key, port);
    usedPorts.push(port);

    inbounds.push({
      type: 'mixed',
      tag: `in-${node.key}`,
      listen: '127.0.0.1',
      listen_port: port,
    });
    outbounds.push(toOutbound(node));
    rules.push({ inbound: [`in-${node.key}`], outbound: `out-${node.key}` });
  });

  // in-proxy: last allocated port + configurable offset
  const proxyInboundPort = ports[nodes.length]! + proxyInboundOffset;
  usedPorts.push(proxyInboundPort);

  inbounds.push({
    type: 'mixed',
    tag: 'in-proxy',
    listen: '127.0.0.1',
    listen_port: proxyInboundPort,
  });

  outbounds.push({
    type: 'selector',
    tag: 'proxy-select',
    outbounds: nodes.map((n) => `out-${n.key}`),
    interrupt_exist_connections: false,
  });
  outbounds.push({ type: 'block', tag: 'block' });

  rules.push({ inbound: ['in-proxy'], outbound: 'proxy-select' });

  const config: SingBoxConfig = {
    log: { level: 'warn' },
    inbounds,
    outbounds,
    route: { rules },
    experimental: {
      clash_api: { external_controller: `127.0.0.1:${clashPort}`, secret: clashSecret },
    },
  };

  return { config, portMap, proxyInboundPort, clashPort, usedPorts };
}
