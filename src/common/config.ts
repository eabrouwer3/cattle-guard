/** Shared configuration: the gated hostname list and how URLs are matched against it. */

export const STORAGE_KEY = 'hostnames';

export const DEFAULT_HOSTNAMES: readonly string[] = ['youtube.com', 'reddit.com'];

/**
 * Reduces user input to a bare hostname: `https://www.Reddit.com/r/x` -> `www.reddit.com`.
 * Returns null for anything that cannot be read as a hostname.
 */
export function normalizeHostname(input: string): string | null {
  let value = input.trim().toLowerCase();
  if (!value || value.startsWith('#')) return null;

  value = value.replace(/^[a-z][a-z0-9+.-]*:\/\//, ''); // scheme
  value = value.replace(/^[^/@]*@/, ''); // credentials
  value = value.split('/')[0] ?? '';
  value = value.split('?')[0] ?? '';
  value = value.split('#')[0] ?? '';
  value = value.replace(/:\d+$/, ''); // port
  value = value.replace(/^\.+|\.+$/g, '');
  value = value.replace(/^\*\./, ''); // subdomains already match implicitly

  if (!value || !/^[a-z0-9.-]+$/.test(value) || !value.includes('.')) return null;
  return value;
}

/** Parses the options-page textarea (one hostname per line) into a deduped list. */
export function parseHostnameList(text: string): string[] {
  const seen = new Set<string>();
  for (const line of text.split('\n')) {
    const host = normalizeHostname(line);
    if (host) seen.add(host);
  }
  return [...seen];
}

/** True when `hostname` is a configured host or a subdomain of one. */
export function hostnameMatches(hostname: string, hostnames: readonly string[]): boolean {
  const host = hostname.toLowerCase().replace(/\.$/, '');
  return hostnames.some((entry) => host === entry || host.endsWith(`.${entry}`));
}

/** True when `url` is an http(s) URL whose host is gated. */
export function urlMatches(url: string, hostnames: readonly string[]): boolean {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return false;
  }
  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') return false;
  return hostnameMatches(parsed.hostname, hostnames);
}

/**
 * Chrome match pattern for a configured host. `*://*.reddit.com/*` covers both
 * `reddit.com` and every subdomain, so one pattern per entry is enough.
 */
export function matchPattern(hostname: string): string {
  return `*://*.${hostname}/*`;
}

export function matchPatterns(hostnames: readonly string[]): string[] {
  return hostnames.map(matchPattern);
}

export async function getHostnames(): Promise<string[]> {
  try {
    const stored = await chrome.storage.sync.get(STORAGE_KEY);
    const value = stored[STORAGE_KEY];
    if (Array.isArray(value)) {
      const cleaned = value
        .map((entry) => (typeof entry === 'string' ? normalizeHostname(entry) : null))
        .filter((entry): entry is string => entry !== null);
      return [...new Set(cleaned)];
    }
  } catch (error) {
    console.warn('[cattle-guard] could not read settings; using defaults', error);
  }
  return [...DEFAULT_HOSTNAMES];
}

export async function setHostnames(hostnames: readonly string[]): Promise<void> {
  await chrome.storage.sync.set({ [STORAGE_KEY]: [...hostnames] });
}

/** Calls `listener` whenever the hostname list changes in any window. */
export function onHostnamesChanged(listener: (hostnames: string[]) => void): void {
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== 'sync' || !(STORAGE_KEY in changes)) return;
    void getHostnames().then(listener);
  });
}
