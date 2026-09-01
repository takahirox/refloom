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

test('Reference cards expose safe website links in a new tab', async () => {
  const source = await readFile(new URL('../src/app.js', import.meta.url), 'utf8');
  assert.match(source, /text: 'Visit website'/);
  assert.match(source, /target: '_blank'/);
  assert.match(source, /rel: 'noopener noreferrer'/);
  assert.match(source, /safeExternalWebsiteUrl\(reference\.sourceUrl\)/);
});

const read = file => readFile(new URL(`../${file}`, import.meta.url), 'utf8');

test('UI refresh preserves every element ID the application script binds', async () => {
  const [html, source] = await Promise.all([read('public/index.html'), read('src/app.js')]);
  const bound = new Set([...source.matchAll(/\$\('#([\w-]+)'\)/g)].map(match => match[1]));
  assert.ok(bound.size >= 30, `only ${bound.size} bound ids found`);
  for (const id of bound) assert.match(html, new RegExp(`\\sid="${id}"`), `missing #${id}`);
});

test('UI refresh preserves hash routes, navigation links, and section landmarks', async () => {
  const html = await read('public/index.html');
  for (const route of ['library', 'board', 'activity', 'data']) {
    assert.match(html, new RegExp(`<a href="#${route}">`), `missing nav link #${route}`);
    assert.match(html, new RegExp(`<section id="${route}" class="view" aria-labelledby="${route}-title"`), `missing view #${route}`);
  }
  assert.match(html, /<a class="skip-link" href="#main">/);
  assert.match(html, /<main id="main" tabindex="-1">/);
  assert.match(html, /<a class="brand" href="#library" aria-label="Refloom home">/);
});

test('UI refresh preserves form names, file inputs, and dialog forms', async () => {
  const html = await read('public/index.html');
  const form = html.slice(html.indexOf('<form id="url-form"'), html.indexOf('</form>'));
  for (const name of ['url', 'captureWebsite', 'width', 'height', 'checkpoints', 'readinessMs', 'settleMs']) assert.match(form, new RegExp(`name="${name}"`), `missing field ${name}`);
  assert.match(html, /<form id="editor-form" method="dialog">/);
  assert.match(html, /<dialog id="confirm-dialog" aria-labelledby="confirm-title"><form method="dialog">/);
  assert.match(html, /id="file-input" class="sr-only" type="file" accept="image\/\*,video\/\*" multiple/);
  assert.match(html, /id="restore-file" class="sr-only" type="file" accept="application\/json"/);
});

test('UI refresh preserves accessibility labelling and keyboard focus order', async () => {
  const html = await read('public/index.html');
  for (const attribute of [
    'aria-expanded="false" aria-controls="primary-nav"', 'aria-label="Primary"', 'aria-describedby="project-help"',
    'id="project-help" class="sr-only"', 'role="alert"', 'aria-controls="capture-settings"', 'tabindex="0" role="button" aria-describedby="drop-help"',
    'id="reference-list" class="card-grid" aria-live="polite"', 'role="status" aria-live="polite" aria-atomic="true"', 'aria-label="Close"',
    'aria-labelledby="dialog-title"', 'aria-labelledby="welcome-title"'
  ]) assert.ok(html.includes(attribute), `missing ${attribute}`);
  const order = ['nav-toggle', 'primary-nav', 'project-select', 'new-project', 'welcome-create', 'edit-project', 'capture-url', 'capture-website', 'drop-zone', 'choose-files', 'file-input', 'library-search', 'export-json', 'export-markdown', 'aspect-filter', 'automatic-website-capture', 'backup', 'restore-file', 'delete-project', 'reset', 'editor-dialog', 'confirm-dialog', 'status'];
  const positions = order.map(id => html.indexOf(`id="${id}"`));
  assert.ok(positions.every((position, index) => position >= 0 && (index === 0 || position > positions[index - 1])), positions.join(','));
});

test('stylesheet keeps overflow protection, motion, theme, and state hooks', async () => {
  const [css, source] = await Promise.all([read('public/styles.css'), read('src/app.js')]);
  for (const rule of [
    'min-width:0', 'overflow-wrap:anywhere', 'img,video{max-width:100%', 'overflow-x:clip', 'repeat(auto-fill,minmax(min(100%,', '[hidden]{display:none!important}',
    '@media(prefers-reduced-motion:reduce)', '@media(prefers-color-scheme:dark)', 'color-scheme:light dark', ':focus-visible{outline:', '@media(max-width:960px)', '@media(max-width:800px)', '.section-head>div:first-child{flex:none}', '@media(max-width:600px)'
  ]) assert.ok(css.includes(rule), `missing ${rule}`);
  for (const hook of ['.status.visible', '.drop-zone.dragging', 'nav.open', 'nav a[aria-current="page"]', '.sr-only', '.skip-link:focus', '.empty', '.fatal', '.placeholder', '.preview.video', '.capture-status']) assert.ok(css.includes(hook), `missing ${hook}`);
  const classes = new Set([...source.matchAll(/className: '([^']+)'/g)].flatMap(match => match[1].split(' ')));
  assert.ok(classes.size >= 10, `only ${classes.size} rendered classes found`);
  for (const name of classes) assert.match(css, new RegExp(`\\.${name}\\b`), `unstyled .${name}`);
});

test('UI refresh introduces no external assets or inline style mechanisms', async () => {
  const [html, css] = await Promise.all([read('public/index.html'), read('public/styles.css')]);
  assert.deepEqual([...html.matchAll(/<link[^>]*>/g)].map(match => match[0]), ['<link rel="stylesheet" href="/styles.css">']);
  assert.deepEqual([...html.matchAll(/<script[^>]*>/g)].map(match => match[0]), ['<script type="module" src="/src/app.js">']);
  assert.doesNotMatch(html, /<style|\sstyle=|https?:\/\/(?!example\.com)/);
  assert.doesNotMatch(css, /@import|@font-face|url\(/);
});
