/**
 * The gate UI. Lives in a closed shadow root attached to a host element that is
 * a sibling of <body>, so neither the site's CSS nor the "hide the page" rule
 * applied to <body> can touch it.
 */

import { whenRootReady } from './dom';

/** How long the confirm button stays inert after the gate appears, in ms. */
const ARM_DELAY_MS = 350;

/** A trusted pointerdown is only good for this long, in ms. */
const POINTER_WINDOW_MS = 5000;

export interface GateCallbacks {
  onConfirm: () => void;
  onBack: () => void;
}

export interface GateHandle {
  /** The element to keep focus on while the gate is up. */
  readonly focusTarget: HTMLElement;
  /** The host element in the page, used to detect tampering. */
  readonly host: HTMLElement;
  /** Re-point an already-open gate at a new destination. */
  setUrl(url: string): void;
  destroy(): void;
}

const STYLES = `
:host { all: initial; }
* { box-sizing: border-box; margin: 0; padding: 0; }
.backdrop {
  position: fixed;
  inset: 0;
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 24px;
  background: #0f1115;
  color: #e8eaed;
  font-family: system-ui, -apple-system, "Segoe UI", Roboto, sans-serif;
  font-size: 16px;
  line-height: 1.5;
  -webkit-font-smoothing: antialiased;
}
.card {
  width: min(560px, 100%);
  padding: 32px;
  border: 1px solid #2a2f3a;
  border-radius: 16px;
  background: #171a21;
  box-shadow: 0 24px 64px rgba(0, 0, 0, 0.55);
  outline: none;
  text-align: left;
}
.brand {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-bottom: 20px;
  color: #f2c85c;
  font-size: 12px;
  font-weight: 600;
  letter-spacing: 0.14em;
  text-transform: uppercase;
}
.rails { display: block; width: 20px; height: 20px; flex: none; }
h1 { margin-bottom: 6px; font-size: 22px; font-weight: 650; line-height: 1.3; }
.host { margin-bottom: 18px; color: #9aa3b2; font-size: 14px; }
.url {
  margin-bottom: 26px;
  padding: 12px 14px;
  border: 1px solid #262b36;
  border-radius: 10px;
  background: #0f1218;
  color: #c9d1e1;
  font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
  font-size: 13px;
  line-height: 1.45;
  word-break: break-all;
  max-height: 5.8em;
  overflow-y: auto;
}
.actions { display: flex; flex-wrap: wrap; gap: 12px; }
.btn {
  padding: 12px 20px;
  border-radius: 10px;
  font-size: 15px;
  font-weight: 600;
  cursor: pointer;
  user-select: none;
  -webkit-user-select: none;
  transition: background-color 120ms ease, opacity 120ms ease;
}
.confirm { background: #f2c85c; color: #1a1c22; }
.confirm:hover { background: #f7d477; }
.confirm[aria-disabled="true"] { opacity: 0.45; cursor: default; }
.back { border: 1px solid #333a48; background: transparent; color: #d5dbe6; }
.back:hover { background: #1e222b; }
.hint { margin-top: 20px; color: #6f7889; font-size: 12.5px; }
@media (max-width: 480px) {
  .card { padding: 24px 20px; }
  h1 { font-size: 19px; }
  .btn { width: 100%; text-align: center; }
}
@media (prefers-reduced-motion: reduce) { .btn { transition: none; } }
`;

const RAILS_SVG = `
<svg class="rails" viewBox="0 0 20 20" aria-hidden="true" focusable="false">
  <g fill="currentColor">
    <rect x="1" y="3" width="18" height="2.4" rx="1.2"/>
    <rect x="1" y="8.8" width="18" height="2.4" rx="1.2"/>
    <rect x="1" y="14.6" width="18" height="2.4" rx="1.2"/>
  </g>
</svg>`;

function hostLabel(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, '');
  } catch {
    return 'this site';
  }
}

/**
 * Only a genuine mouse/touch/pen press counts. Keyboard-driven clicks arrive
 * with `detail === 0`, and synthetic clicks from page scripts are untrusted, so
 * neither Enter nor a site script can wave the gate through.
 */
function isRealClick(event: MouseEvent, lastPointerDown: number): boolean {
  return (
    event.isTrusted &&
    event.detail >= 1 &&
    event.button === 0 &&
    lastPointerDown > 0 &&
    Date.now() - lastPointerDown <= POINTER_WINDOW_MS
  );
}

export function createGate(url: string, callbacks: GateCallbacks): GateHandle {
  const host = document.createElement('cattle-guard-gate');
  host.setAttribute('data-cattle-guard', 'gate');
  const hostStyle =
    'all: initial; position: fixed; inset: 0; width: 100%; height: 100%; ' +
    'z-index: 2147483647; display: block; visibility: visible; opacity: 1; ' +
    'pointer-events: auto; color-scheme: dark;';
  host.setAttribute('style', hostStyle);

  const shadow = host.attachShadow({ mode: 'closed' });
  const style = document.createElement('style');
  style.textContent = STYLES;

  const backdrop = document.createElement('div');
  backdrop.className = 'backdrop';
  backdrop.innerHTML = `
    <section class="card" role="dialog" aria-modal="true" aria-labelledby="cg-title" tabindex="-1">
      <div class="brand">${RAILS_SVG}<span>Cattle Guard</span></div>
      <h1 id="cg-title">Do you actually want to open this?</h1>
      <p class="host"></p>
      <p class="url"></p>
      <div class="actions">
        <div class="btn confirm" role="button" aria-disabled="true">Yes, I want to open this</div>
        <div class="btn back" role="button">Take me back</div>
      </div>
      <p class="hint">Confirming needs a real click — Enter and Space are ignored on purpose. Esc goes back.</p>
    </section>`;

  shadow.append(style, backdrop);

  const card = backdrop.querySelector('.card') as HTMLElement;
  const hostLine = backdrop.querySelector('.host') as HTMLElement;
  const urlLine = backdrop.querySelector('.url') as HTMLElement;
  const confirmButton = backdrop.querySelector('.confirm') as HTMLElement;
  const backButton = backdrop.querySelector('.back') as HTMLElement;

  const setUrl = (next: string): void => {
    hostLine.textContent = hostLabel(next);
    urlLine.textContent = next;
    urlLine.scrollTop = 0;
  };
  setUrl(url);

  let destroyed = false;
  let armed = false;
  let lastPointerDown = 0;

  const armTimer = window.setTimeout(() => {
    armed = true;
    confirmButton.setAttribute('aria-disabled', 'false');
  }, ARM_DELAY_MS);

  confirmButton.addEventListener('pointerdown', (event) => {
    if (event.isTrusted) lastPointerDown = Date.now();
  });
  confirmButton.addEventListener('click', (event) => {
    event.preventDefault();
    event.stopPropagation();
    if (!armed || destroyed || !isRealClick(event, lastPointerDown)) return;
    callbacks.onConfirm();
  });

  backButton.addEventListener('click', (event) => {
    event.preventDefault();
    event.stopPropagation();
    if (destroyed || !event.isTrusted) return;
    callbacks.onBack();
  });

  // Swallow clicks that land on the backdrop so nothing reaches the page.
  backdrop.addEventListener('click', (event) => event.stopPropagation(), true);

  // If the site (or an over-eager extension) rips the host out of the DOM or
  // rewrites its style attribute, put it back.
  let rootObserver: MutationObserver | null = null;
  let hostObserver: MutationObserver | null = null;

  void whenRootReady().then((root) => {
    if (destroyed) return;
    root.appendChild(host);
    card.focus({ preventScroll: true });

    rootObserver = new MutationObserver(() => {
      if (!destroyed && !host.isConnected) root.appendChild(host);
    });
    rootObserver.observe(root, { childList: true });

    hostObserver = new MutationObserver(() => {
      if (!destroyed && host.getAttribute('style') !== hostStyle) {
        host.setAttribute('style', hostStyle);
      }
    });
    hostObserver.observe(host, { attributes: true, attributeFilter: ['style'] });
  });

  return {
    focusTarget: card,
    host,
    setUrl,
    destroy(): void {
      if (destroyed) return;
      destroyed = true;
      window.clearTimeout(armTimer);
      rootObserver?.disconnect();
      hostObserver?.disconnect();
      host.remove();
    },
  };
}
