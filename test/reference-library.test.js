import assert from 'node:assert/strict';
import test from 'node:test';
import {
  addReferenceTags, filterLibraryReferences, listReferenceTags, listReferenceTagSuggestions
} from '../src/reference-library.js';

test('tag entry canonicalizes comma input, deduplicates, and keeps domain bounds', () => {
  assert.deepEqual(addReferenceTags(['editorial'], ' Art Direction, EDITORIAL '),
    ['editorial', 'art-direction']);
  assert.throws(() => addReferenceTags(Array.from({ length: 20 }, (_, index) => `tag-${index}`), 'extra'),
    /at most 20/);
  assert.throws(() => addReferenceTags([], 'x'.repeat(65)), /at most 64/);
});

test('tag discovery keeps used tags and deterministically follows them with built-ins', () => {
  const references = [
    { tags: ['motion', 'custom-tag'] },
    { tags: ['motion', 'typography'] }
  ];
  assert.deepEqual(listReferenceTags(references), ['custom-tag', 'motion', 'typography']);
  assert.deepEqual(listReferenceTagSuggestions(references), [
    { tag: 'motion', referenceCount: 2 },
    { tag: 'custom-tag', referenceCount: 1 },
    { tag: 'typography', referenceCount: 1 },
    { tag: 'branding', referenceCount: 0 },
    { tag: 'editorial', referenceCount: 0 },
    { tag: 'illustration', referenceCount: 0 },
    { tag: 'photography', referenceCount: 0 },
    { tag: 'web-3d', referenceCount: 0 },
    { tag: 'web-design', referenceCount: 0 }
  ]);
});

test('Library free text includes tags and exact-tag filtering composes with it', () => {
  const references = [
    { id: 'one', title: 'Opening', creator: 'A', sourceUrl: undefined, notes: undefined, tags: ['motion', 'editorial'] },
    { id: 'two', title: 'Poster', creator: 'B', sourceUrl: undefined, notes: 'Opening study', tags: ['print'] },
    { id: 'three', title: 'Still', creator: 'C', sourceUrl: 'https://example.test', notes: undefined, tags: ['slow-motion'] }
  ];
  assert.deepEqual(filterLibraryReferences(references, { query: 'motion' }).map(item => item.id), ['one', 'three']);
  assert.deepEqual(filterLibraryReferences(references, { tag: 'MOTION' }).map(item => item.id), ['one']);
  assert.deepEqual(filterLibraryReferences(references, { query: 'opening', tag: 'print' }).map(item => item.id), ['two']);
  assert.deepEqual(filterLibraryReferences(references, { query: 'opening', tag: 'motion' }).map(item => item.id), ['one']);
});
