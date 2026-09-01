import test from 'node:test';
import assert from 'node:assert/strict';
import {
  displayReference, formatMoment, formatSeconds, formatSignal, safeExternalWebsiteUrl,
  safeFilename
} from '../src/ui-format.js';

test('reference labels fall back without inventing metadata', () => {
  assert.equal(displayReference({ title: 'Poster', sourceUrl: 'https://example.com' }), 'Poster');
  assert.equal(displayReference({ sourceUrl: 'https://example.com' }), 'https://example.com');
  assert.equal(displayReference({}), 'Untitled reference');
});

test('moments use labels or readable timestamps', () => {
  assert.equal(formatSeconds(65), '1:05');
  assert.equal(formatSeconds(-1), '');
  assert.equal(formatMoment({ label: 'Opening' }), 'Opening');
  assert.equal(formatMoment({ start: 2, end: 8 }), '0:02–0:08');
  assert.equal(formatMoment(null), '');
});

test('signals are rendered as factual actions', () => {
  assert.equal(formatSignal({ event: 'capture' }), 'Captured a reference');
  assert.equal(formatSignal({ event: 'board.change' }), 'Changed the board');
  assert.equal(formatSignal({ event: 'custom' }), 'custom');
});

test('download filenames are portable', () => {
  assert.equal(safeFilename('My Creative Direction!', 'json'), 'my-creative-direction.json');
  assert.equal(safeFilename('', 'md'), 'refloom.md');
});

test('external website links allow only absolute HTTP and HTTPS URLs', () => {
  assert.equal(safeExternalWebsiteUrl('https://example.com/path?q=1'), 'https://example.com/path?q=1');
  assert.equal(safeExternalWebsiteUrl('http://example.com'), 'http://example.com/');
  for (const value of [
    'javascript:alert(1)', 'data:text/html,hello', '/relative', 'not a URL', undefined
  ]) assert.equal(safeExternalWebsiteUrl(value), null);
});
