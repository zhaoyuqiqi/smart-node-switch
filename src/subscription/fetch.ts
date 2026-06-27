/**
 * Fetch subscription URL and decode base64 content into raw lines.
 */
export async function fetchSubscription(url: string): Promise<string[]> {
  const resp = await fetch(url);
  if (!resp.ok) {
    throw new Error(`Failed to fetch subscription: ${resp.status} ${resp.statusText}`);
  }
  const text = (await resp.text()).trim();
  // Detect plain-text subscription (starts with a known protocol scheme).
  const PROTOCOL_RE = /^(trojan|vmess|ss|vless|ssr|hysteria2?|tuic):\/\//m;
  if (PROTOCOL_RE.test(text)) {
    return text.split(/\r?\n/).filter(Boolean);
  }
  // Otherwise assume base64-encoded; fall back to raw text if decode fails
  // or the decoded content doesn't look like a subscription.
  try {
    const decoded = atob(text);
    if (PROTOCOL_RE.test(decoded)) {
      return decoded.split(/\r?\n/).filter(Boolean);
    }
  } catch {
    // not valid base64
  }
  return text.split(/\r?\n/).filter(Boolean);
}
