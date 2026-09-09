import assert from 'node:assert/strict';
import test from 'node:test';
import { once } from 'node:events';
import { spawn } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createRefloomServer } from '../../server.mjs';
import { findChrome, connectChromeCdp } from '../../src/chrome-capture.js';
import { MemoryStore } from '../fixtures/analysis-store.mjs';
import { profile, png } from '../fixtures/analysis-profile.mjs';
import { digest } from '../../src/visparse-runner.js';

test('browser can request, inspect and reuse analysis; derived text is never HTML', { timeout: 30000 }, async t => {
  const store = new MemoryStore(); let calls = 0;
  const runner = { enabled: true, configuration: 'fixture', timeoutMs: 10000, info: async () => ({ version: 'fixture' }),
    analyze: async () => { calls++; const result = profile(digest(png)); result.observations[0].statement = '<img src=x onerror="window.analysisInjected=true">'; return { version: 'fixture', result }; } };
  const server = createRefloomServer({ store, analysisRunner: runner });
  server.listen(0, '127.0.0.1'); await once(server, 'listening'); await server.initialization;
  t.after(async () => { server.closeAllConnections(); await new Promise(r => server.close(r)); await server.repositoryClosed; });
  const directory = await mkdtemp(path.join(tmpdir(), 'refloom-analysis-browser-'));
  const browser = spawn(await findChrome(), [`--user-data-dir=${directory}`, '--remote-debugging-port=0', '--remote-debugging-address=127.0.0.1', '--headless=new', '--disable-background-networking', '--disable-sync', '--disable-extensions', '--no-first-run', 'about:blank'], { stdio: ['ignore', 'ignore', 'pipe'] });
  let diagnostic = ''; browser.stderr.on('data', chunk => { if (diagnostic.length < 2000) diagnostic += chunk.toString(); });
  t.after(async () => { browser.kill('SIGKILL'); if (browser.exitCode === null) await once(browser, 'exit'); await rm(directory, { recursive: true, force: true }); });
  const cdp = await connectChromeCdp(browser, { profile: directory }).catch(error => { throw new Error(`Chrome startup failed (exit ${browser.exitCode}): ${diagnostic.slice(0,2000)}`, { cause: error }); }); t.after(() => cdp.close());
  await cdp.send('Page.navigate', { url: `http://127.0.0.1:${server.address().port}/#library` });
  async function until(expression) {
    for (let i = 0; i < 100; i++) {
      if (await cdp.evaluate(expression)) return;
      await new Promise(r => setTimeout(r, 100));
    }
    assert.fail(`Browser condition did not complete: ${expression}`);
  }
  await until("document.querySelector('#project-select')?.options.length > 0");
  await cdp.evaluate("document.querySelector('#project-select').value='p'; document.querySelector('#project-select').dispatchEvent(new Event('change'))");
  await until("[...document.querySelectorAll('button')].some(b => b.textContent === 'Analysis')");
  await cdp.evaluate("[...document.querySelectorAll('button')].find(b => b.textContent === 'Analysis').click()");
  await until("document.querySelector('.analysis-dialog[open]') && ![...document.querySelectorAll('.analysis-dialog button')].find(b => b.textContent === 'Analyze selected image').disabled");
  await cdp.evaluate("[...document.querySelectorAll('.analysis-dialog button')].find(b => b.textContent === 'Analyze selected image').click()");
  await until("document.querySelector('.analysis-entry')?.textContent.includes('complete')");
  await cdp.evaluate("[...document.querySelectorAll('.analysis-dialog button')].find(b => b.textContent === 'View analysis').click()");
  await until("document.querySelector('.analysis-dialog')?.textContent.includes('<img src=x')");
  assert.equal(await cdp.evaluate('window.analysisInjected === true'), false);
  assert.equal(await cdp.evaluate("document.querySelectorAll('.analysis-dialog img').length"), 1);
  await cdp.evaluate("[...document.querySelectorAll('.analysis-dialog button')].find(b => b.textContent === 'Analyze selected image').click()");
  await new Promise(r => setTimeout(r, 300));
  assert.equal(calls, 1);
  await cdp.evaluate("[...document.querySelectorAll('.analysis-dialog button')].find(b => b.textContent === 'Close').click()");
  await until("!document.querySelector('.analysis-dialog')");
});
