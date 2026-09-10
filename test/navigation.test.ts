import assert from 'node:assert/strict';
import { test } from 'node:test';
import { isSameNavigation } from '../src/common/navigation';

test('SPA URL touch-ups do not count as a new navigation', () => {
  // YouTube appends playback parameters with replaceState after the page loads.
  assert.equal(
    isSameNavigation('https://www.youtube.com/watch?v=abc', 'https://www.youtube.com/watch?v=abc&pp=xyz'),
    true,
  );
  // Fragments move within a page.
  assert.equal(
    isSameNavigation('https://old.reddit.com/r/x/comments/1', 'https://old.reddit.com/r/x/comments/1#c2'),
    true,
  );
  assert.equal(isSameNavigation('https://www.reddit.com/', 'https://www.reddit.com/?feed=home'), true);
  assert.equal(isSameNavigation('https://www.youtube.com/', 'https://www.youtube.com/'), true);
});

test('real navigations re-gate', () => {
  // A different video is a different navigation even though the path matches.
  assert.equal(
    isSameNavigation('https://www.youtube.com/watch?v=abc', 'https://www.youtube.com/watch?v=def'),
    false,
  );
  assert.equal(isSameNavigation('https://www.youtube.com/', 'https://www.youtube.com/watch?v=abc'), false);
  assert.equal(
    isSameNavigation('https://www.reddit.com/r/a/', 'https://www.reddit.com/r/b/'),
    false,
  );
  // Dropping a parameter is treated as a navigation, erring towards gating.
  assert.equal(
    isSameNavigation('https://www.youtube.com/watch?v=abc&t=30', 'https://www.youtube.com/watch?v=abc'),
    false,
  );
  // Never carry a confirmation across origins.
  assert.equal(isSameNavigation('https://m.youtube.com/', 'https://www.youtube.com/'), false);
  assert.equal(isSameNavigation('http://www.reddit.com/', 'https://www.reddit.com/'), false);
});

test('unparseable URLs fall back to exact comparison', () => {
  assert.equal(isSameNavigation('not a url', 'not a url'), true);
  assert.equal(isSameNavigation('not a url', 'also not a url'), false);
});
