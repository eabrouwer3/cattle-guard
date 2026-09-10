# Cattle Guard

A Chromium (Manifest V3) extension that puts a full-page gate in front of the sites you asked it to
guard — `youtube.com` and `reddit.com` by default, subdomains included. Every navigation is gated:
cold loads, reloads, back/forward, typed URLs, external links, **and in-app clicks that never touch
the network**, like a recommended video on YouTube or a post link on Reddit.

There is no grace period and nothing is remembered. A confirmation covers exactly the navigation it
was given for; the next one asks again.

## Build

```bash
npm install
npm run build      # writes dist/
npm run watch      # rebuild on change
npm test           # unit tests for URL matching and navigation identity
npm run typecheck
```

## Load unpacked

Chrome, Brave and Edge are the same three steps — only the URL differs.

| Browser | Extensions page |
| --- | --- |
| Chrome | `chrome://extensions` |
| Brave | `brave://extensions` |
| Edge | `edge://extensions` |

1. Run `npm install && npm run build`.
2. Open the extensions page above and turn on **Developer mode** (top-right in Chrome/Brave, left
   sidebar in Edge).
3. Click **Load unpacked** and select this repo's **`dist/`** folder (not the repo root).

The options page opens on first install. After editing `dist/`, hit **Reload** (⟳) on the extension
card; open tabs on a guarded site get the gate injected again automatically.

## Configuration

Extension icon → options page, or the **Details → Extension options** link.

- One hostname per line. Subdomains match automatically, so `reddit.com` covers `old.reddit.com`,
  `www.reddit.com` and `m.reddit.com`. Full URLs are reduced to their hostname when you save.
- Saved to `chrome.storage.sync`, so the list follows your Chrome profile.
- Saving asks for access to exactly the hosts on the list, and hands back access to any host you
  removed. The defaults (`youtube.com`, `reddit.com`) are declared in the manifest; anything else is
  granted at save time through `optional_host_permissions`.

Permissions requested: `webNavigation`, `storage`, `scripting`, and host access limited to the
configured sites. Nothing else — no `tabs`, no `<all_urls>` in the manifest.

## How it works

Single-page apps are the hard part. Clicking a recommended video on YouTube or a post on Reddit
fires `history.pushState`: no page load, no `popstate`, no new document. An extension that only
watches page loads misses every one of those. Cattle Guard covers the same ground twice, from two
processes that fail independently.

**In the page** (`src/content/`, injected at `document_start`):

- `history-hook.ts` runs in the **MAIN world** and patches `pushState`/`replaceState`. This has to
  be the page's own world — a patch applied from the isolated world is invisible to the site's code,
  because each world gets its own `window` and `History` wrapper. It reports changes by dispatching
  an event on `document`, the one object both worlds share.
- `gate.ts` runs in the isolated world, owns the gate, and watches the URL four ways: the history
  hook above, `popstate`/`hashchange`, a 250 ms `location.href` poll, and relays from the service
  worker. It also re-gates on `pageshow` with `persisted: true`, because a back/forward restore from
  the bfcache runs no script at all and would otherwise walk back into a page for free.

**In the service worker** (`src/background/service-worker.ts`):

- `webNavigation.onHistoryStateUpdated` → relays SPA navigations to the content script.
- `webNavigation.onCommitted` / `onBeforeNavigate` → checks shortly afterwards that the new document
  really has a gate, and injects one if it does not.
- If injection is impossible (a restricted URL, a revoked permission), the tab is sent to
  `blocked.html` as a last resort. That is the fallback, not the primary path: an in-page overlay
  keeps the real destination URL in the address bar and is the only thing that can gate a
  `pushState` navigation, which never loads a page for a redirect to intercept.

Its listeners are registered unfiltered at the top level and filtered inside the handler (main frame,
configured hostnames). An MV3 worker is torn down between events, and building a `filters` argument
needs an `await` on storage — which can lose the very event that woke the worker.

**The gate itself** is a closed shadow root on an element appended next to `<body>`, at
`z-index: 2147483647`. Site CSS cannot reach into it, and the rule that hides `<body>` cannot hide
it. While it is up: the page is hidden, playing media is paused (and re-paused every second, since
players retry autoplay), focus is trapped on the dialog, and key events are swallowed so the site's
shortcuts do not fire behind it.

**Confirming takes a real click.** The confirm control needs a trusted `pointerdown` followed by a
trusted click with `detail >= 1`, and it stays inert for 350 ms after appearing. Keyboard-driven
clicks arrive with `detail === 0` and synthetic clicks from page scripts are untrusted, so neither
Enter, Space, a stray double-click from the link you just clicked, nor a script on the page can wave
the gate through. `Esc` is wired to **Take me back**, never to confirm.

## Test plan

Load `dist/`, open the service worker console (`chrome://extensions` → Cattle Guard → **service
worker**) if you want to watch it work, and walk these. **Start with the SPA cases** — they are the
ones most gate extensions miss.

**SPA navigations (no page load — the important ones)**

| # | Case | Expected |
| --- | --- | --- |
| 1 | On a YouTube video, click a recommended video in the sidebar | Gate appears, showing the new `watch?v=…` URL; the current video pauses |
| 2 | YouTube home → click any video | Gate appears before the player starts |
| 3 | YouTube: type in search, press Enter | Gate appears for the `/results?search_query=…` URL |
| 4 | `www.reddit.com` feed → click a post | Gate appears with the post URL |
| 5 | `www.reddit.com` → click a subreddit in the sidebar / left rail | Gate appears with the subreddit URL |
| 6 | Confirm a YouTube video, then let it play for a minute without touching anything | No re-gate (URL touch-ups from `replaceState` are not navigations) |

**Full page loads**

| # | Case | Expected |
| --- | --- | --- |
| 7 | Cold load: new tab → type `youtube.com` | Gate appears before any content is visible |
| 8 | Reload (`Ctrl/Cmd-R`) after confirming | Gate appears again |
| 9 | Back, then Forward | Gate appears each time, including bfcache restores |
| 10 | Typed URL straight to a deep link, e.g. `reddit.com/r/programming` | Gate appears |
| 11 | External link into a guarded site (from a search result or another page) | Gate appears |
| 12 | `old.reddit.com` — a classic multi-page app — browse a few links | Gate appears on every link |
| 13 | `m.youtube.com` | Gate appears (subdomains match) |
| 14 | Middle-click a video to open it in a background tab, then switch to it | Gate is up in that tab |

**Gate behaviour**

| # | Case | Expected |
| --- | --- | --- |
| 15 | Press Enter or Space while the gate is up | Nothing happens — no confirm |
| 16 | Press `Esc` | Goes back, same as **Take me back** |
| 17 | Press Tab repeatedly | Focus stays on the dialog |
| 18 | With a video playing, trigger a gate | Audio stops immediately |
| 19 | **Take me back** on a tab with no history (opened by a link) | The tab closes |
| 20 | Wait on the gate without clicking | It never dismisses itself |

**Configuration**

| # | Case | Expected |
| --- | --- | --- |
| 21 | Add a host (e.g. `news.ycombinator.com`) and save | Chrome prompts for access; that site is gated on the next navigation |
| 22 | Remove a host and save | It stops being gated, and its access is handed back |
| 23 | Visit a site not on the list | No gate, no overlay flash |

## Known behaviour

- **Back/forward re-gates, including "Take me back."** If the page you land on is also guarded, it
  gets its own gate. Clicking through the gates walks you off the site; that is the intended shape of
  the escape hatch, not a bug.
- **Fragment and parameter touch-ups are not navigations.** `#comment-123`, or YouTube tacking `&pp=`
  onto the URL you just confirmed, will not re-gate. Any change of path, or a changed or dropped
  query parameter — a new `?v=`, a different subreddit, a different sort — will.
- **Sites where scripts cannot be injected** (a URL Chrome reserves, a host whose permission was
  revoked) fall back to `blocked.html`. Confirming there grants that tab a 30-second, URL-specific
  pass so it can actually reach the page instead of bouncing back to the fallback.
- **iframes are not gated** — only the main frame is, which is what an address bar navigation means.

## Layout

```
src/
  manifest.json          MV3 manifest
  background/            service worker: registration, webNavigation relays, repair
  content/
    history-hook.ts      MAIN world: pushState/replaceState patch
    gate.ts              isolated world: state machine and URL watchers
    overlay.ts           the gate UI (closed shadow root)
    freeze.ts            hides the page, pauses media, traps focus and keys
  common/                hostname config and navigation identity (unit tested)
  options/               options page
  blocked/               fallback gate page
test/                    node:test unit tests
```
