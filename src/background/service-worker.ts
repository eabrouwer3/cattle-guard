/**
 * Service worker: keeps the gate content scripts registered for the configured
 * hosts, and relays webNavigation events to them as a second, independent
 * trigger. The content script is the primary mechanism; this is the safety net
 * that also repairs tabs where the script never ran.
 */
import { getHostnames, matchPatterns, onHostnamesChanged, urlMatches } from '../common/config';
import type { PingResponse, ToBackgroundMessage } from '../common/messages';

const GATE_SCRIPT_ID = 'cattle-guard-gate';
const HOOK_SCRIPT_ID = 'cattle-guard-history-hook';

const GATE_FILE = 'gate.js';
const HOOK_FILE = 'history-hook.js';

/** How long to give a freshly committed document before checking it is gated, in ms. */
const VERIFY_DELAY_MS = 600;

/**
 * How long a confirmation made on the fallback page lets that tab reach that
 * URL, in ms. Without it the fallback page would bounce the tab straight back
 * to itself; keeping it short and URL-specific means the next navigation gates.
 */
const ALLOWANCE_MS = 30_000;

/* ------------------------------------------------------------------ *
 * Content script registration
 * ------------------------------------------------------------------ */

async function grantedPatterns(): Promise<string[]> {
  const patterns = matchPatterns(await getHostnames());
  const checks = await Promise.all(
    patterns.map(async (pattern) => {
      try {
        return (await chrome.permissions.contains({ origins: [pattern] })) ? pattern : null;
      } catch {
        return null;
      }
    }),
  );
  return checks.filter((pattern): pattern is string => pattern !== null);
}

/**
 * Registers both halves of the gate for the configured hosts:
 * `gate.js` in the isolated world (UI + state) and `history-hook.js` in the
 * page's own world (so the pushState patch is visible to the site's code).
 * Registration is persistent, so it survives browser restarts and is in place
 * before the first navigation of a session.
 */
async function syncContentScripts(): Promise<void> {
  const matches = await grantedPatterns();

  let existing: chrome.scripting.RegisteredContentScript[] = [];
  try {
    existing = await chrome.scripting.getRegisteredContentScripts({
      ids: [GATE_SCRIPT_ID, HOOK_SCRIPT_ID],
    });
  } catch {
    existing = [];
  }
  const registered = new Set(existing.map((script) => script.id));

  if (matches.length === 0) {
    if (registered.size > 0) {
      await chrome.scripting.unregisterContentScripts({ ids: [...registered] }).catch(() => undefined);
    }
    return;
  }

  const scripts: chrome.scripting.RegisteredContentScript[] = [
    {
      id: GATE_SCRIPT_ID,
      js: [GATE_FILE],
      matches,
      runAt: 'document_start',
      allFrames: false,
      world: 'ISOLATED',
      persistAcrossSessions: true,
    },
    {
      id: HOOK_SCRIPT_ID,
      js: [HOOK_FILE],
      matches,
      runAt: 'document_start',
      allFrames: false,
      world: 'MAIN',
      persistAcrossSessions: true,
    },
  ];

  const toUpdate = scripts.filter((script) => registered.has(script.id));
  const toRegister = scripts.filter((script) => !registered.has(script.id));

  try {
    if (toUpdate.length > 0) await chrome.scripting.updateContentScripts(toUpdate);
    if (toRegister.length > 0) await chrome.scripting.registerContentScripts(toRegister);
  } catch (error) {
    console.error('[cattle-guard] could not register content scripts', error);
  }
}

/* ------------------------------------------------------------------ *
 * Fallback-page allowances
 * ------------------------------------------------------------------ */

interface Allowance {
  url: string;
  at: number;
}

function allowanceKey(tabId: number): string {
  return `allow:${tabId}`;
}

async function grantAllowance(tabId: number, url: string): Promise<void> {
  await chrome.storage.session
    .set({ [allowanceKey(tabId)]: { url, at: Date.now() } satisfies Allowance })
    .catch(() => undefined);
}

async function hasAllowance(tabId: number, url: string): Promise<boolean> {
  try {
    const key = allowanceKey(tabId);
    const stored = (await chrome.storage.session.get(key))[key] as Allowance | undefined;
    if (!stored) return false;
    if (Date.now() - stored.at > ALLOWANCE_MS) {
      await chrome.storage.session.remove(key);
      return false;
    }
    return stored.url === url;
  } catch {
    return false;
  }
}

chrome.tabs.onRemoved.addListener((tabId) => {
  void chrome.storage.session.remove(allowanceKey(tabId)).catch(() => undefined);
});

/* ------------------------------------------------------------------ *
 * Gate delivery
 * ------------------------------------------------------------------ */

async function pingGate(tabId: number): Promise<PingResponse | null> {
  try {
    const response = (await chrome.tabs.sendMessage(tabId, { kind: 'ping' }, { frameId: 0 })) as
      | PingResponse
      | undefined;
    return response ?? null;
  } catch {
    return null; // no content script in that tab
  }
}

async function injectGate(tabId: number): Promise<boolean> {
  try {
    await chrome.scripting.executeScript({
      target: { tabId, frameIds: [0] },
      files: [HOOK_FILE],
      world: 'MAIN',
    });
  } catch {
    // The page's CSP or a restricted URL can block the MAIN-world half; the
    // isolated-world gate still works, backed by its poll.
  }
  try {
    await chrome.scripting.executeScript({
      target: { tabId, frameIds: [0] },
      files: [GATE_FILE],
      world: 'ISOLATED',
    });
    return true;
  } catch (error) {
    console.warn('[cattle-guard] could not inject the gate', error);
    return false;
  }
}

/** Last resort when nothing can be injected: navigate to an extension page. */
async function redirectToBlockedPage(tabId: number, url: string): Promise<void> {
  const target = `${chrome.runtime.getURL('blocked.html')}?url=${encodeURIComponent(url)}`;
  await chrome.tabs.update(tabId, { url: target }).catch(() => undefined);
}

/** Tells the tab's gate about a URL change, repairing the tab if it has none. */
async function relayNavigation(tabId: number, url: string): Promise<void> {
  try {
    await chrome.tabs.sendMessage(tabId, { kind: 'navigated', url }, { frameId: 0 });
    return;
  } catch {
    // Falls through to injection: either the script never ran, or the document
    // is younger than the message.
  }

  if (await injectGate(tabId)) {
    await chrome.tabs.sendMessage(tabId, { kind: 'navigated', url }, { frameId: 0 }).catch(() => undefined);
    return;
  }
  await redirectToBlockedPage(tabId, url);
}

/** Confirms a freshly loaded document actually has a gate, and repairs it if not. */
function verifyGated(tabId: number, url: string): void {
  setTimeout(() => {
    void (async () => {
      if (!(await isStillAt(tabId, url))) return;
      if (await hasAllowance(tabId, url)) return;
      if (await pingGate(tabId)) return;
      if (await injectGate(tabId)) {
        await chrome.tabs
          .sendMessage(tabId, { kind: 'navigated', url }, { frameId: 0 })
          .catch(() => undefined);
        return;
      }
      await redirectToBlockedPage(tabId, url);
    })();
  }, VERIFY_DELAY_MS);
}

async function isStillAt(tabId: number, url: string): Promise<boolean> {
  try {
    const tab = await chrome.tabs.get(tabId);
    return tab.url === url || tab.pendingUrl === url;
  } catch {
    return false;
  }
}

/* ------------------------------------------------------------------ *
 * Navigation events
 * ------------------------------------------------------------------ */

/**
 * Listeners are registered unfiltered and synchronously at the top level: an
 * MV3 service worker is torn down between events, and a `filters` argument
 * built from `chrome.storage` would need an await that can lose the very event
 * that woke the worker. The equivalent filtering — configured hostnames, main
 * frame only — happens in `shouldGate` below.
 */
async function shouldGate(details: { frameId: number; url: string; tabId: number }): Promise<boolean> {
  if (details.frameId !== 0) return false;
  if (details.tabId < 0) return false;
  if (!urlMatches(details.url, await getHostnames())) return false;
  return !(await hasAllowance(details.tabId, details.url));
}

// Full document loads. The content script gates these itself at document_start;
// this only repairs tabs where it could not run.
chrome.webNavigation.onCommitted.addListener((details) => {
  void (async () => {
    if (!(await shouldGate(details))) return;
    verifyGated(details.tabId, details.url);
  })();
});

// Earliest signal for a full load, used to repair tabs that are already open
// with no gate (for example right after the extension is installed or updated).
chrome.webNavigation.onBeforeNavigate.addListener((details) => {
  void (async () => {
    if (!(await shouldGate(details))) return;
    verifyGated(details.tabId, details.url);
  })();
});

// SPA navigations: YouTube's recommended videos, Reddit's post and subreddit
// links. No document is created, so the running content script must be told.
chrome.webNavigation.onHistoryStateUpdated.addListener((details) => {
  void (async () => {
    if (!(await shouldGate(details))) return;
    await relayNavigation(details.tabId, details.url);
  })();
});

/* ------------------------------------------------------------------ *
 * Wiring
 * ------------------------------------------------------------------ */

chrome.runtime.onMessage.addListener((message: ToBackgroundMessage, sender, sendResponse) => {
  const tabId = sender.tab?.id;
  if (message?.kind === 'closeTab' && tabId !== undefined) {
    void chrome.tabs.remove(tabId).catch(() => undefined);
    return false;
  }
  if (message?.kind === 'allowOnce' && tabId !== undefined) {
    void grantAllowance(tabId, message.url).then(() => sendResponse({ ok: true }));
    return true; // responding asynchronously
  }
  return false;
});

chrome.runtime.onInstalled.addListener((details) => {
  void syncContentScripts();
  if (details.reason === 'install') void chrome.runtime.openOptionsPage().catch(() => undefined);
});
chrome.runtime.onStartup.addListener(() => void syncContentScripts());
chrome.permissions.onAdded.addListener(() => void syncContentScripts());
chrome.permissions.onRemoved.addListener(() => void syncContentScripts());
onHostnamesChanged(() => void syncContentScripts());

chrome.action.onClicked.addListener(() => void chrome.runtime.openOptionsPage().catch(() => undefined));

// Also runs on every worker wake, which keeps registration self-healing.
void syncContentScripts();
