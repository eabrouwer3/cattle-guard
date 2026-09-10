import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  hostnameMatches,
  matchPattern,
  normalizeHostname,
  parseHostnameList,
  urlMatches,
} from '../src/common/config';

const hosts = ['youtube.com', 'reddit.com'];

test('gates configured hosts and their subdomains', () => {
  for (const url of [
    'https://youtube.com',
    'https://www.youtube.com/watch?v=abc',
    'https://m.youtube.com/',
    'https://REDDIT.COM/r/X',
    'https://old.reddit.com/r/x/comments/1',
    'http://www.reddit.com/',
  ]) {
    assert.equal(urlMatches(url, hosts), true, url);
  }
  assert.equal(hostnameMatches('sub.old.reddit.com', hosts), true);
});

test('does not gate look-alike hosts or non-web schemes', () => {
  for (const url of [
    'https://notyoutube.com/',
    'https://youtube.com.evil.test/',
    'https://news.ycombinator.com/',
    'chrome://extensions',
    'file:///tmp/youtube.com',
    'not a url',
  ]) {
    assert.equal(urlMatches(url, hosts), false, url);
  }
});

test('normalizes user input down to a hostname', () => {
  assert.equal(normalizeHostname('https://www.Reddit.com/r/x'), 'www.reddit.com');
  assert.equal(normalizeHostname('  YouTube.com  '), 'youtube.com');
  assert.equal(normalizeHostname('*.reddit.com'), 'reddit.com');
  assert.equal(normalizeHostname('reddit.com:8080'), 'reddit.com');
  assert.equal(normalizeHostname('user:pw@reddit.com'), 'reddit.com');
  assert.equal(normalizeHostname('localhost'), null);
  assert.equal(normalizeHostname('# a comment'), null);
  assert.equal(normalizeHostname(''), null);
});

test('parses the options textarea, deduping and dropping junk', () => {
  assert.deepEqual(parseHostnameList('youtube.com\n\nYOUTUBE.com\nhttps://reddit.com/r/x\nnope\n'), [
    'youtube.com',
    'reddit.com',
  ]);
  assert.deepEqual(parseHostnameList(''), []);
});

test('builds a match pattern that covers the host and its subdomains', () => {
  assert.equal(matchPattern('reddit.com'), '*://*.reddit.com/*');
});
