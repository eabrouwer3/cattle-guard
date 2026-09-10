/**
 * MAIN-world content script, injected at document_start.
 *
 * YouTube and Reddit navigate with `history.pushState`, which fires no load and
 * no popstate. A patch installed from the isolated world would not be seen by
 * the page (each world has its own `window`/`History` wrapper), so the patch has
 * to live here, in the page's own world. It reports URL changes to the isolated
 * world by dispatching an event on `document`, which both worlds share.
 */
import { HISTORY_EVENT } from '../common/messages';

const FLAG = '__cattleGuardHistoryHooked';
const globals = window as unknown as Record<string, unknown>;

if (!globals[FLAG]) {
  globals[FLAG] = true;

  const notify = (): void => {
    try {
      document.dispatchEvent(new CustomEvent(HISTORY_EVENT));
    } catch {
      /* the page may be tearing down */
    }
  };

  for (const method of ['pushState', 'replaceState'] as const) {
    const original = history[method];
    if (typeof original !== 'function') continue;

    const patched = function (this: History, ...args: unknown[]): unknown {
      const result = (original as (...a: unknown[]) => unknown).apply(this, args);
      notify();
      return result;
    };
    // Sites sometimes sniff for a native-looking implementation.
    Object.defineProperty(patched, 'name', { value: method });
    Object.defineProperty(patched, 'toString', {
      value: () => `function ${method}() { [native code] }`,
      writable: true,
      configurable: true,
    });
    history[method] = patched as unknown as History[typeof method];
  }

  // Covers back/forward within the SPA and in-page fragment jumps.
  window.addEventListener('popstate', notify, true);
  window.addEventListener('hashchange', notify, true);
}
