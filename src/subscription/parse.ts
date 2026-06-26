import type { Node } from '../types.ts';
import { parseTrojan } from './parsers/trojan.ts';
import { parseVmess } from './parsers/vmess.ts';
import { parseSs } from './parsers/ss.ts';
import { parseVless } from './parsers/vless.ts';

/**
 * Parse subscription lines into Node[].
 * Dispatches to per-protocol parsers, skips invalid/unsupported entries, deduplicates by key.
 */
export function parseSubscription(lines: string[]): Node[] {
  const seen = new Set<string>();
  const nodes: Node[] = [];

  for (const line of lines) {
    const uri = line.trim();
    if (!uri) continue;

    let node: Node | null = null;
    if (uri.startsWith('trojan://')) {
      node = parseTrojan(uri);
    } else if (uri.startsWith('vmess://')) {
      node = parseVmess(uri);
    } else if (uri.startsWith('ss://')) {
      node = parseSs(uri);
    } else if (uri.startsWith('vless://')) {
      node = parseVless(uri);
    }
    // skip unsupported protocols

    if (node && !seen.has(node.key)) {
      seen.add(node.key);
      nodes.push(node);
    }
  }

  return nodes;
}
