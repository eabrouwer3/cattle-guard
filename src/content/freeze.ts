/**
 * Everything that happens to the *page* while the gate is up: content hidden,
 * media paused, keyboard neutralised, focus trapped.
 */

import { whenRootReady } from './dom';

const FREEZE_STYLE_ID = 'cattle-guard-freeze';

/** How often to re-pause media, in ms. Players like YouTube retry autoplay. */
const REPAUSE_INTERVAL_MS = 1000;

export interface FrozenPage {
  release(): void;
}

type Media = HTMLMediaElement;

function freezeStyle(): HTMLStyleElement {
  const style = document.createElement('style');
  style.id = FREEZE_STYLE_ID;
  // <body> is hidden rather than removed so the site keeps its layout and
  // scroll position; the gate host is a sibling of <body>, so it stays visible.
  style.textContent = `
    html { overflow: hidden !important; }
    body { visibility: hidden !important; }
  `;
  return style;
}

export function freezePage(host: Element, focusTarget: HTMLElement, onEscape: () => void): FrozenPage {
  const paused = new Set<Media>();
  const previousActive = document.activeElement as HTMLElement | null;
  let released = false;

  const style = freezeStyle();
  const attachStyle = (): void => {
    if (released || style.isConnected) return;
    const root = document.head ?? document.documentElement;
    if (root) root.appendChild(style);
    // At document_start there may be no <html> yet; attach as soon as there is.
    else void whenRootReady().then(attachStyle);
  };
  attachStyle();

  const pauseAll = (): void => {
    if (released) return;
    for (const element of document.querySelectorAll<Media>('video, audio')) {
      if (!element.paused) {
        paused.add(element);
        try {
          element.pause();
        } catch {
          /* some players guard pause() */
        }
      }
    }
  };
  pauseAll();

  const onPlay = (event: Event): void => {
    const target = event.target;
    if (target instanceof HTMLMediaElement) {
      paused.add(target);
      try {
        target.pause();
      } catch {
        /* ignore */
      }
    }
  };
  // Media events do not bubble, but a capturing listener still sees them.
  document.addEventListener('play', onPlay, true);
  const repauseTimer = window.setInterval(() => {
    attachStyle();
    pauseAll();
  }, REPAUSE_INTERVAL_MS);

  const onKey = (event: KeyboardEvent): void => {
    if (released) return;
    if (event.type === 'keydown' && event.key === 'Escape') {
      event.preventDefault();
      event.stopImmediatePropagation();
      onEscape();
      return;
    }
    // Keep the page's own shortcuts (YouTube's k/f/j, Reddit's j/k) from firing
    // behind the gate, and make sure Tab/Enter/Space do nothing at all.
    event.stopImmediatePropagation();
    if (event.key === 'Tab' || event.key === 'Enter' || event.key === ' ') {
      event.preventDefault();
    }
  };
  for (const type of ['keydown', 'keyup', 'keypress'] as const) {
    window.addEventListener(type, onKey, true);
  }

  const onFocusIn = (event: FocusEvent): void => {
    if (released) return;
    const target = event.target as Node | null;
    if (target && (target === host || host.contains(target))) return;
    focusTarget.focus({ preventScroll: true });
  };
  document.addEventListener('focusin', onFocusIn, true);

  previousActive?.blur?.();

  return {
    release(): void {
      if (released) return;
      released = true;
      window.clearInterval(repauseTimer);
      document.removeEventListener('play', onPlay, true);
      document.removeEventListener('focusin', onFocusIn, true);
      for (const type of ['keydown', 'keyup', 'keypress'] as const) {
        window.removeEventListener(type, onKey, true);
      }
      style.remove();

      for (const element of paused) {
        if (element.isConnected) void element.play?.().catch(() => undefined);
      }
      paused.clear();

      if (previousActive?.isConnected) previousActive.focus?.({ preventScroll: true });
    },
  };
}
