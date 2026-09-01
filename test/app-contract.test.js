import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

test('URL capture controls are visibly default-on with shared and per-create opt-out', async () => {
  const html = await readFile(new URL('../public/index.html', import.meta.url), 'utf8');
  assert.match(html, /id="capture-website"[^>]*checked/);
  assert.match(html, /Automatically capture after saving/);
  assert.match(html, /id="automatic-website-capture"[^>]*checked/);
  assert.match(html, /shared Workspace preference/);
});

test('UI saves before capture and does not auto-capture URL edits or non-URL imports', async () => {
  const source = await readFile(new URL('../src/app.js', import.meta.url), 'utf8');
  const submit = source.indexOf("$('#url-form').addEventListener('submit'");
  const save = source.indexOf("const result = await commit(next, [], 'URL saved'", submit);
  const capture = source.indexOf('if (optedIn) await waitForScheduledCapture', submit);
  assert.ok(submit >= 0 && save > submit && capture > save);
  const editor = source.slice(source.indexOf('function referenceEditor'), source.indexOf('function selectionEditor'));
  assert.doesNotMatch(editor, /captureWebsite/);
  const files = source.slice(source.indexOf('async function captureFiles'), source.indexOf('function referenceEditor'));
  assert.doesNotMatch(files, /captureWebsite/);
});
