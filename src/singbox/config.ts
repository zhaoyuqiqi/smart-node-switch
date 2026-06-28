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
  testUrl?: string;
  exclude?: Set<number>;
  proxyAuthUser?: string;
  proxyAuthPass?: string;
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
 * - fixed in-proxy mixed inbound
 * - proxy-auto(urltest) over all node outbounds
 * - route in-proxy -> proxy-auto
 */
export async function buildConfig(params: BuildConfigParams): Promise<BuildConfigResult> {
  const {
    nodes,
    basePort,
    proxyInboundOffset,
    clashPort,
    clashSecret,
    testUrl,
    exclude,
    proxyAuthUser,
    proxyAuthPass,
  } = params;
  const excludeSet = new Set(exclude ?? []);

  const ports = await allocatePorts(1, basePort, excludeSet);
  const proxyInboundPort = ports[0]! + proxyInboundOffset;

  const hasAuth = Boolean(proxyAuthUser && proxyAuthPass);
  const inbounds: Record<string, unknown>[] = [
    {
      type: 'mixed',
      tag: 'in-proxy',
      listen: '127.0.0.1',
      listen_port: proxyInboundPort,
      ...(hasAuth ? { users: [{ username: proxyAuthUser, password: proxyAuthPass }] } : {}),
    },
  ];

  const nodeOutbounds = nodes.map((n) => `out-${n.key}`);
  const outbounds: Record<string, unknown>[] = [
    ...nodes.map((n) => toOutbound(n)),
    {
      type: 'urltest',
      tag: 'proxy-auto',
      outbounds: nodeOutbounds.length > 0 ? nodeOutbounds : ['block'],
      url: testUrl ?? 'https://www.google.com',
      interval: '3m',
      tolerance: 50,
      idle_timeout: '30m',
      interrupt_exist_connections: false,
    },
    { type: 'block', tag: 'block' },
  ];

  const rules: Record<string, unknown>[] = [
    { inbound: ['in-proxy'], outbound: 'proxy-auto' },
  ];

  const config: SingBoxConfig = {
    log: { level: 'warn' },
    inbounds,
    outbounds,
    route: { rules },
    experimental: {
      clash_api: { external_controller: `127.0.0.1:${clashPort}`, secret: clashSecret },
    },
  };

  const usedPorts = [proxyInboundPort, clashPort];
  return { config, portMap: new Map(), proxyInboundPort, clashPort, usedPorts };
}
