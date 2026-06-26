/**
 * Fetch subscription URL and decode base64 content into raw lines.
 */
export async function fetchSubscription(url: string): Promise<string[]> {
  const resp = await fetch(url);
  if (!resp.ok) {
    throw new Error(`Failed to fetch subscription: ${resp.status} ${resp.statusText}`);
  }
  const text = (await resp.text()).trim();
  // Try base64 decode; if it contains protocol schemes it's plain text
  try {
    const decoded = atob(text);
    return decoded.split(/\r?\n/).filter(Boolean);
  } catch {
    return text.split(/\r?\n/).filter(Boolean);
  }
}
