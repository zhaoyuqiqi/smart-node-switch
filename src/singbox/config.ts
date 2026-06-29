import type { Node } from "../types.ts";
import { toOutbound } from "./outbound.ts";
import { allocatePorts } from "./ports.ts";

export interface SingBoxConfig {
  log: { level: string, disabled: boolean,output: string, timestamp: boolean };
  inbounds: Record<string, unknown>[];
  outbounds: Record<string, unknown>[];
  route: { rules: Record<string, unknown>[] };
  experimental: {
    clash_api: {
      external_controller: string;
      secret: string;
      access_control_allow_private_network: boolean;
    };
  };
}

export interface BuildConfigParams {
  nodes: Node[];
  basePort: number;
  proxyInboundOffset: number;
  clashPort: number;
  clashBindAddress?: string;
  clashSecret: string;
  testUrl?: string;
  urltestInterval?: string;
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
export async function buildConfig(
  params: BuildConfigParams,
): Promise<BuildConfigResult> {
  const {
    nodes,
    basePort,
    proxyInboundOffset,
    clashPort,
    clashBindAddress,
    clashSecret,
    testUrl,
    urltestInterval,
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
      type: "mixed",
      tag: "in-proxy",
      listen: "127.0.0.1",
      listen_port: proxyInboundPort,
      ...(hasAuth
        ? { users: [{ username: proxyAuthUser, password: proxyAuthPass }] }
        : {}),
    },
  ];

  const nodeOutbounds = nodes.map((n) => `out-${n.key}`);
  const outbounds: Record<string, unknown>[] = [
    {
      type: "urltest",
      tag: "proxy-auto",
      outbounds: nodeOutbounds.length > 0 ? nodeOutbounds : ["block"],
      url: testUrl ?? "https://cp.cloudflare.com",
      interval: urltestInterval ?? "3m",
      tolerance: 50,
      idle_timeout: "30m",
      interrupt_exist_connections: false,
    },
    { type: "block", tag: "block" },
    ...nodes.map((n) => toOutbound(n)),
  ];

  const rules: Record<string, unknown>[] = [
    { inbound: ["in-proxy"], outbound: "proxy-auto" },
  ];

  const config: SingBoxConfig = {
    log: { disabled: true, level: "debug", timestamp: true, output: "a.log" },
    inbounds,
    outbounds,
    route: { rules },
    experimental: {
      clash_api: {
        external_controller: `${clashBindAddress ?? "127.0.0.1"}:${clashPort}`,
        secret: clashSecret,
        access_control_allow_private_network: true,
      },
    },
  };

  const usedPorts = [proxyInboundPort, clashPort];
  return { config, portMap: new Map(), proxyInboundPort, clashPort, usedPorts };
}
