/**
 * Fallback gate, used only when the overlay cannot be injected into the page
 * (a restricted URL, a revoked host permission, an injection that failed). The
 * overlay is the primary path because it keeps the destination URL in the
 * address bar and works for SPA navigations, which this page cannot.
 */

const ARM_DELAY_MS = 350;

const hostLine = document.getElementById('host') as HTMLParagraphElement;
const urlLine = document.getElementById('url') as HTMLParagraphElement;
const confirmButton = document.getElementById('confirm') as HTMLDivElement;
const backButton = document.getElementById('back') as HTMLDivElement;

function destination(): string | null {
  const raw = new URL(location.href).searchParams.get('url');
  if (!raw) return null;
  try {
    const parsed = new URL(raw);
    // Never follow anything but a real web URL from a query parameter.
    if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') return null;
    return parsed.href;
  } catch {
    return null;
  }
}

const target = destination();

if (target) {
  hostLine.textContent = new URL(target).hostname.replace(/^www\./, '');
  urlLine.textContent = target;
} else {
  hostLine.textContent = 'Unknown destination';
  urlLine.textContent = 'No valid URL was passed to this page.';
  confirmButton.remove();
}

let armed = false;
let lastPointerDown = 0;
window.setTimeout(() => {
  armed = true;
  confirmButton.setAttribute('aria-disabled', 'false');
}, ARM_DELAY_MS);

confirmButton.addEventListener('pointerdown', (event) => {
  if (event.isTrusted) lastPointerDown = Date.now();
});

confirmButton.addEventListener('click', (event) => {
  // detail === 0 means a keyboard-driven click, which must not pass the gate.
  if (!armed || !target || !event.isTrusted || event.detail < 1 || lastPointerDown === 0) return;
  void chrome.runtime
    .sendMessage({ kind: 'allowOnce', url: target })
    .catch(() => undefined)
    .then(() => location.replace(target));
});

backButton.addEventListener('click', (event) => {
  if (!event.isTrusted) return;
  if (history.length > 1) {
    history.back();
    return;
  }
  void chrome.runtime.sendMessage({ kind: 'closeTab' }).catch(() => undefined);
});
