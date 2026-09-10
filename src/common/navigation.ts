/**
 * Deciding whether a URL change is a new navigation.
 *
 * A confirmation covers exactly one navigation, but single-page apps rewrite
 * the current URL constantly without navigating anywhere: YouTube appends
 * playback parameters with replaceState, Reddit rewrites the feed URL. Treating
 * those as navigations would re-gate a page the user just confirmed, seconds
 * after they confirmed it.
 *
 * So a change counts as the *same* navigation only when it stays on the same
 * origin and path and every parameter of the confirmed URL survives unchanged.
 * Anything else — a different path, a changed or dropped parameter (a new
 * `?v=`, a different subreddit) — is a new navigation and re-gates. Fragments
 * are ignored: they move within a page rather than to a new one.
 */
export function isSameNavigation(confirmed: string, next: string): boolean {
  let a: URL;
  let b: URL;
  try {
    a = new URL(confirmed);
    b = new URL(next);
  } catch {
    return confirmed === next;
  }

  if (a.origin !== b.origin || a.pathname !== b.pathname) return false;

  for (const [key, value] of a.searchParams) {
    if (b.searchParams.get(key) !== value) return false;
  }
  return true;
}
