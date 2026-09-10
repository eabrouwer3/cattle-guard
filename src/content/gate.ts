/**
 * Isolated-world content script, injected at document_start.
 *
 * Owns the gate state machine for one tab: every URL change that lands on a
 * configured host raises the gate, and only a real click on the confirm button
 * lowers it. A confirmation covers exactly that URL; the next change re-gates.
 *
 * URL changes are noticed four independent ways so a missed signal cannot open
 * a hole: the MAIN-world history hook, popstate/hashchange, a cheap poll, and
 * webNavigation events relayed by the service worker.
 */
import { getHostnames, onHostnamesChanged, urlMatches } from '../common/config';
import { isSameNavigation } from '../common/navigation';
import { HISTORY_EVENT, type PingResponse, type ToContentMessage } from '../common/messages';
import { freezePage, type FrozenPage } from './freeze';
import { createGate, type GateHandle } from './overlay';

/** How often to compare location.href as a last-ditch backstop, in ms. */
const POLL_INTERVAL_MS = 250;

/** How long to wait for history.back() to do something before closing the tab, in ms. */
const BACK_TIMEOUT_MS = 700;

const RUN_ONCE_FLAG = '__cattleGuardGateActive';

interface OpenGate {
  handle: GateHandle;
  frozen: FrozenPage;
  url: string;
}

function main(): void {
  /** null until settings load; the content script only runs on matched hosts anyway. */
  let hostnames: string[] | null = null;
  let open: OpenGate | null = null;
  let confirmedUrl: string | null = null;
  let lastHref = location.href;

  function closeGate(): void {
    if (!open) return;
    open.frozen.release();
    open.handle.destroy();
    open = null;
  }

  function goBack(): void {
    const before = location.href;
    if (history.length <= 1) {
      void chrome.runtime.sendMessage({ kind: 'closeTab' }).catch(() => undefined);
      return;
    }
    history.back();
    // A back that goes nowhere (single-entry tab opened by a link) leaves the
    // gate stranded, so fall back to closing the tab.
    window.setTimeout(() => {
      if (location.href === before && open) {
        void chrome.runtime.sendMessage({ kind: 'closeTab' }).catch(() => undefined);
      }
    }, BACK_TIMEOUT_MS);
  }

  function openGate(url: string): void {
    const handle = createGate(url, {
      onConfirm: () => {
        confirmedUrl = open?.url ?? url;
        closeGate();
      },
      onBack: goBack,
    });
    const frozen = freezePage(handle.host, handle.focusTarget, goBack);
    open = { handle, frozen, url };
  }

  /**
   * @param optimistic gate before settings have loaded (document_start), on the
   * strength of the host having matched when the script was registered.
   */
  function evaluate(url: string, optimistic = false): void {
    const matches = hostnames === null ? optimistic : urlMatches(url, hostnames);
    if (!matches) {
      closeGate();
      confirmedUrl = null;
      return;
    }

    if (open) {
      // The page navigated again while gated: re-point the gate, never lower it.
      if (!isSameNavigation(open.url, url)) {
        open.url = url;
        open.handle.setUrl(url);
      }
      return;
    }
    if (confirmedUrl !== null && isSameNavigation(confirmedUrl, url)) return;
    openGate(url);
  }

  function checkUrl(): void {
    if (location.href === lastHref) return;
    lastHref = location.href;
    evaluate(lastHref);
  }

  // 1. Gate immediately, before the page paints anything.
  evaluate(location.href, true);

  // 2. Confirm against the real settings as soon as they arrive.
  void getHostnames().then((list) => {
    hostnames = list;
    evaluate(location.href);
  });
  onHostnamesChanged((list) => {
    hostnames = list;
    evaluate(location.href);
  });

  // 3. Watch for URL changes from every angle.
  document.addEventListener(HISTORY_EVENT, checkUrl, true);
  window.addEventListener('popstate', checkUrl, true);
  window.addEventListener('hashchange', checkUrl, true);
  window.setInterval(checkUrl, POLL_INTERVAL_MS);

  // A back/forward restore from the bfcache re-runs no script and keeps this
  // state alive, so drop the confirmation and gate again.
  window.addEventListener('pageshow', (event) => {
    if ((event as PageTransitionEvent).persisted) {
      confirmedUrl = null;
      lastHref = location.href;
      evaluate(location.href);
    }
  });

  // 4. webNavigation relays from the service worker.
  chrome.runtime.onMessage.addListener(
    (message: ToContentMessage, _sender, sendResponse: (response: PingResponse) => void) => {
      if (message?.kind === 'navigated') {
        checkUrl();
        // The relay can arrive before the poll notices; re-check the live URL so
        // the gate is up either way.
        evaluate(location.href);
      }
      if (message?.kind === 'navigated' || message?.kind === 'ping') {
        // Always answer, so the service worker can tell "no content script here"
        // from "handled" and only repairs tabs that really need it.
        sendResponse({ kind: 'pong', url: location.href, gated: open !== null });
      }
      return false;
    },
  );
}

const globals = globalThis as unknown as Record<string, unknown>;
if (!globals[RUN_ONCE_FLAG] && window.top === window) {
  globals[RUN_ONCE_FLAG] = true;
  main();
}
