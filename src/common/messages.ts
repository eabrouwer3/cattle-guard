/** Message contracts between the service worker, the gate content script and extension pages. */

/** Service worker -> content script: this tab's URL changed (full load or history API). */
export interface NavigatedMessage {
  kind: 'navigated';
  url: string;
}

/** Service worker -> content script: are you alive, and is the gate up? */
export interface PingMessage {
  kind: 'ping';
}

export interface PingResponse {
  kind: 'pong';
  /** The URL the content script currently considers gated or confirmed. */
  url: string;
  gated: boolean;
}

/** Content script -> service worker: no history to go back to, please close this tab. */
export interface CloseTabMessage {
  kind: 'closeTab';
}

export type ToContentMessage = NavigatedMessage | PingMessage;
export type ToBackgroundMessage = CloseTabMessage;

/** Event name used by the MAIN-world history hook to signal the isolated-world gate. */
export const HISTORY_EVENT = '__cattle_guard_history__';
