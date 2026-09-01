import { access, mkdtemp, readFile, rm } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { CAPTURE_ERROR, normalizeCaptureUrl } from './capture-url.js';
import { createCaptureProxy } from './capture-proxy.js';

const KNOWN_CHROME = process.platform === 'darwin'
  ? ['/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', '/Applications/Chromium.app/Contents/MacOS/Chromium']
  : process.platform === 'win32'
    ? ['C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe']
    : ['/usr/bin/google-chrome', '/usr/bin/chromium', '/usr/bin/chromium-browser'];

const CAPTURE_DIAGNOSTICS = new Set([
  'BROWSER_UNAVAILABLE', 'BROWSER_START_FAILED', 'CAPTURE_RUNTIME_FAILED'
]);

function diagnosticError(code, cause) {
  const error = new Error(CAPTURE_ERROR, cause ? { cause } : undefined);
  Object.defineProperty(error, 'captureDiagnosticCode', { value: code });
  return error;
}

export function captureDiagnosticCode(error) {
  for (let current = error, depth = 0; current && depth < 8; current = current.cause, depth += 1) {
    if (CAPTURE_DIAGNOSTICS.has(current.captureDiagnosticCode)) return current.captureDiagnosticCode;
  }
  return undefined;
}

export async function findChrome(explicit, fsAccess = access) {
  for (const candidate of [explicit, process.env.REFLOOM_CHROME_PATH, ...KNOWN_CHROME]) {
    if (!candidate) continue;
    try { await fsAccess(candidate); return candidate; } catch { /* continue */ }
  }
  throw diagnosticError('BROWSER_UNAVAILABLE');
}

async function bounded(promise, clock, ms) {
  let timer;
  try {
    return await Promise.race([
      promise,
      new Promise((_, reject) => { timer = clock.setTimeout(() => reject(new Error(CAPTURE_ERROR)), ms); })
    ]);
  } finally {
    (clock.clearTimeout || globalThis.clearTimeout)(timer);
  }
}

const pause = (clock, ms) => new Promise(resolve => clock.setTimeout(resolve, ms));

export async function connectChromeCdp(_browser, options = {}) {
  const clock = options.clock || globalThis;
  const read = options.readFile || readFile;
  const fetcher = options.fetch || globalThis.fetch;
  const WebSocketType = options.WebSocket || globalThis.WebSocket;
  if (!options.profile || !fetcher || !WebSocketType) throw new Error(CAPTURE_ERROR);

  let port;
  for (let attempt = 0; attempt < 100; attempt += 1) {
    try {
      const lines = (await read(path.join(options.profile, 'DevToolsActivePort'), 'utf8')).trim().split(/\r?\n/);
      port = Number(lines[0]);
      if (Number.isSafeInteger(port) && port > 0 && port < 65_536) break;
    } catch { /* Chrome has not published its endpoint yet. */ }
    await pause(clock, 25);
  }
  if (!port) throw new Error(CAPTURE_ERROR);

  let targets;
  try {
    const response = await fetcher(`http://127.0.0.1:${port}/json/list`);
    if (!response.ok) throw new Error();
    targets = await response.json();
  } catch { throw new Error(CAPTURE_ERROR); }
  const target = Array.isArray(targets) && targets.find(item => item?.type === 'page' && typeof item.webSocketDebuggerUrl === 'string');
  if (!target) throw new Error(CAPTURE_ERROR);
  const endpoint = new URL(target.webSocketDebuggerUrl);
  if (endpoint.protocol !== 'ws:' || !['127.0.0.1', 'localhost', '[::1]'].includes(endpoint.hostname) || Number(endpoint.port) !== port) throw new Error(CAPTURE_ERROR);

  const socket = new WebSocketType(endpoint.href);
  await new Promise((resolve, reject) => {
    socket.addEventListener('open', resolve, { once: true });
    socket.addEventListener('error', () => reject(new Error(CAPTURE_ERROR)), { once: true });
  });
  let nextId = 1;
  const pending = new Map();
  const listeners = new Map();
  socket.addEventListener('message', event => {
    let message;
    try { message = JSON.parse(String(event.data)); } catch { return; }
    if (message.id !== undefined) {
      const operation = pending.get(message.id);
      if (!operation) return;
      pending.delete(message.id);
      if (message.error) operation.reject(new Error(CAPTURE_ERROR));
      else operation.resolve(message.result || {});
      return;
    }
    for (const listener of listeners.get(message.method) || []) listener(message.params || {});
  });
  socket.addEventListener('close', () => {
    for (const operation of pending.values()) operation.reject(new Error(CAPTURE_ERROR));
    pending.clear();
  });

  function send(method, params = {}) {
    return new Promise((resolve, reject) => {
      const id = nextId++;
      pending.set(id, { resolve, reject });
      try { socket.send(JSON.stringify({ id, method, params })); }
      catch { pending.delete(id); reject(new Error(CAPTURE_ERROR)); }
    });
  }

  return {
    targetId: target.id,
    send,
    async evaluate(expression) {
      const response = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
      if (response.exceptionDetails) throw new Error(CAPTURE_ERROR);
      return response.result?.value;
    },
    on(method, listener) {
      const values = listeners.get(method) || [];
      values.push(listener);
      listeners.set(method, values);
    },
    waitFor(method) {
      return new Promise(resolve => {
        const listener = value => {
          const values = listeners.get(method) || [];
          listeners.set(method, values.filter(item => item !== listener));
          resolve(value);
        };
        const values = listeners.get(method) || [];
        values.push(listener);
        listeners.set(method, values);
      });
    },
    async close() {
      try { socket.close(); } catch { /* cleanup */ }
    }
  };
}

export async function verifyChromeRuntime(options = {}) {
  const clock = options.clock || globalThis;
  const fs = options.fs || { mkdtemp, rm, access };
  const processSpawn = options.spawn || spawn;
  const connectCdp = options.connectCdp || connectChromeCdp;
  const timeoutMs = options.timeoutMs ?? 10_000;
  let profile;
  let browser;
  let cdp;
  try {
    const executable = await findChrome(options.executable, fs.access);
    profile = await fs.mkdtemp(path.join(options.tmpdir || tmpdir(), 'refloom-browser-check-'));
    browser = processSpawn(executable, [
      `--user-data-dir=${profile}`, '--remote-debugging-port=0',
      '--remote-debugging-address=127.0.0.1', '--headless=new',
      '--disable-dev-shm-usage', '--disable-background-networking',
      '--disable-sync', '--disable-extensions', '--no-first-run',
      '--no-default-browser-check', 'about:blank'
    ], { stdio: ['ignore', 'pipe', 'pipe'] });
    browser.once?.('error', () => {});
    for (const stream of [browser.stdout, browser.stderr]) {
      stream?.on?.('error', () => {});
      stream?.resume?.();
    }
    try {
      cdp = await bounded(connectCdp(browser, { clock, profile }), clock, timeoutMs);
      await bounded(cdp.send('Browser.getVersion'), clock, timeoutMs);
    } catch (error) {
      throw diagnosticError('BROWSER_START_FAILED', error);
    }
    return true;
  } catch (error) {
    throw diagnosticError(captureDiagnosticCode(error) || 'CAPTURE_RUNTIME_FAILED', error);
  } finally {
    try { await cdp?.close?.(); } catch { /* cleanup */ }
    try { browser?.kill?.('SIGKILL'); } catch { /* cleanup */ }
    if (browser?.pid && browser.exitCode === null) {
      try { await bounded(new Promise(resolve => browser.once('exit', resolve)), clock, 1_000); } catch { /* cleanup */ }
    }
    if (profile) try { await fs.rm(profile, { recursive: true, force: true }); } catch { /* cleanup */ }
  }
}

export function validateCaptureSettings(options = {}) {
  const values = {
    settleMs: options.settleMs ?? 500,
    readinessMs: options.readinessMs ?? 1_000,
    checkpoints: options.checkpoints ?? 3,
    width: options.width ?? 1440,
    height: options.height ?? 900,
    maxRedirects: options.maxRedirects ?? 10
  };
  if (!Object.values(values).every(Number.isSafeInteger) ||
      values.settleMs < 0 || values.settleMs > 2_000 ||
      values.readinessMs < 0 || values.readinessMs > 15_000 ||
      values.checkpoints < 1 || values.checkpoints > 5 ||
      values.maxRedirects < 0 || values.maxRedirects > 20 ||
      values.width < 320 || values.width > 2_560 ||
      values.height < 320 || values.height > 1_440) throw new Error(CAPTURE_ERROR);
  if (options.onScreenshot !== undefined && typeof options.onScreenshot !== 'function') throw new Error(CAPTURE_ERROR);
  return values;
}

export async function captureWebsite(input, options = {}) {
  const clock = options.clock || globalThis;
  const fs = options.fs || { mkdtemp, rm, access };
  const processSpawn = options.spawn || spawn;
  const makeProxy = options.createProxy || createCaptureProxy;
  const connectCdp = options.connectCdp || connectChromeCdp;
  const overallMs = options.overallTimeoutMs ?? 45_000;
  const checkpointMs = options.checkpointTimeoutMs ?? 8_000;
  const { settleMs, readinessMs, checkpoints, width, height, maxRedirects } = validateCaptureSettings(options);
  const maxScreenshotBytes = options.maxScreenshotBytes ?? 25 * 1024 * 1024;
  let profile;
  let proxy;
  let browser;
  let cdp;
  let cancelled = options.signal?.aborted || false;
  const active = () => { if (cancelled || options.signal?.aborted) throw new Error(CAPTURE_ERROR); };

  async function cleanup() {
    try { await cdp?.close?.(); } catch { /* cleanup */ }
    try { browser?.kill?.('SIGKILL'); } catch { /* cleanup */ }
    if (browser?.pid && browser.exitCode === null) {
      try { await bounded(new Promise(resolve => browser.once('exit', resolve)), clock, 1_000); } catch { /* cleanup */ }
    }
    try { await proxy?.close?.(); } catch { /* cleanup */ }
    if (profile) try { await fs.rm(profile, { recursive: true, force: true }); } catch { /* cleanup */ }
  }

  const abort = () => {
    cancelled = true;
    void cleanup();
  };
  options.signal?.addEventListener?.('abort', abort, { once: true });

  const work = (async () => {
    const target = await normalizeCaptureUrl(input, { resolver: options.resolver });
    active();
    const executable = await findChrome(options.executable, fs.access);
    active();
    profile = await fs.mkdtemp(path.join(options.tmpdir || tmpdir(), 'refloom-capture-'));
    active();
    proxy = makeProxy({ ...options.proxyOptions, resolver: options.resolver });
    const address = await proxy.listen();
    active();
    const args = [
      `--user-data-dir=${profile}`, '--remote-debugging-port=0', '--remote-debugging-address=127.0.0.1',
      '--headless=new', '--hide-scrollbars', '--incognito', '--no-first-run',
      '--no-default-browser-check', '--disable-dev-shm-usage', '--disable-quic', '--disable-background-networking',
      '--disable-sync', '--disable-extensions', '--disable-component-update',
      '--disable-features=MediaRouter,WebRtcHideLocalIpsWithMdns',
      '--force-webrtc-ip-handling-policy=disable_non_proxied_udp',
      `--proxy-server=http://127.0.0.1:${address.port}`,
      '--proxy-bypass-list=<-loopback>', 'about:blank'
    ];
    browser = processSpawn(executable, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    browser.once?.('error', () => {});
    for (const stream of [browser.stdout, browser.stderr]) {
      stream?.on?.('error', () => {});
      stream?.resume?.();
    }
    try {
      cdp = await bounded(connectCdp(browser, { clock, profile }), clock, checkpointMs);
    } catch (error) {
      throw diagnosticError('BROWSER_START_FAILED', error);
    }
    active();
    await cdp.send('Page.enable');
    await cdp.send('Runtime.enable');
    await cdp.send('Target.setDiscoverTargets', { discover: true });
    await cdp.send('Browser.setDownloadBehavior', { behavior: 'deny' });
    await cdp.send('Network.enable');
    await cdp.send('Network.setCacheDisabled', { cacheDisabled: true });
    await cdp.send('Network.setBypassServiceWorker', { bypass: true });
    await cdp.send('Emulation.setDeviceMetricsOverride', {
      width, height, deviceScaleFactor: 1, mobile: false
    });
    const closePopup = event => {
      if (event.targetInfo?.type === 'page' && event.targetInfo?.targetId !== cdp.targetId) {
        cdp.send('Target.closeTarget', { targetId: event.targetInfo.targetId }).catch(() => {});
      }
    };
    cdp.on?.('Target.targetCreated', closePopup);
    cdp.on?.('Target.targetInfoChanged', closePopup);
    let redirects = 0;
    let rejectRedirects;
    const redirectLimit = new Promise((_, reject) => { rejectRedirects = reject; });
    cdp.on?.('Network.requestWillBeSent', event => {
      if (event.type === 'Document' && event.redirectResponse && ++redirects > maxRedirects) {
        cdp.send('Page.stopLoading').catch(() => {});
        rejectRedirects(new Error(CAPTURE_ERROR));
      }
    });
    const loaded = cdp.waitFor?.('Page.loadEventFired') || Promise.resolve();
    const navigation = await bounded(cdp.send('Page.navigate', { url: target.href }), clock, checkpointMs);
    if (navigation.errorText || navigation.isDownload) throw new Error(CAPTURE_ERROR);
    await bounded(Promise.race([loaded, redirectLimit]), clock, checkpointMs);
    await bounded(pause(clock, readinessMs), clock, readinessMs + 100);
    active();
    const metrics = await cdp.evaluate(`({
      title: document.title,
      url: location.href,
      width: Math.min(document.documentElement.scrollWidth, 16384),
      height: Math.min(document.documentElement.scrollHeight, 100000),
      viewportWidth: innerWidth,
      viewportHeight: innerHeight
    })`);
    if (!metrics || typeof metrics.url !== 'string' || typeof metrics.title !== 'string' ||
        ![metrics.width, metrics.height, metrics.viewportWidth, metrics.viewportHeight].every(Number.isFinite)) throw new Error(CAPTURE_ERROR);
    const final = await normalizeCaptureUrl(metrics.url, { resolver: options.resolver });
    const capturedAt = options.now?.() || new Date().toISOString();
    const screenshots = [];
    for (let index = 0; index < checkpoints; index += 1) {
      active();
      const y = Math.round(Math.max(0, metrics.height - metrics.viewportHeight) * index / Math.max(1, checkpoints - 1));
      await bounded(cdp.evaluate(`scrollTo(0, ${y})`), clock, checkpointMs);
      await bounded(new Promise(resolve => clock.setTimeout(resolve, settleMs)), clock, checkpointMs);
      const shot = await bounded(cdp.send('Page.captureScreenshot', { format: 'png', fromSurface: true }), clock, checkpointMs);
      if (typeof shot.data !== 'string' || Buffer.byteLength(shot.data, 'base64') > maxScreenshotBytes || Buffer.from(shot.data, 'base64').toString('base64') !== shot.data) throw new Error(CAPTURE_ERROR);
      const screenshot = { y, png: shot.data };
      screenshots.push(screenshot);
      await options.onScreenshot?.({
        ...screenshot,
        originalUrl: target.href,
        finalUrl: final.href,
        title: metrics.title,
        domain: final.hostname,
        viewport: { width, height, deviceScaleFactor: 1 },
        checkpoint: { index, y, count: checkpoints },
        capturedAt,
        captureMethod: 'automated-browser',
        captureStrategy: 'deterministic-scroll'
      });
    }
    return { ...metrics, originalUrl: target.href, finalUrl: final.href, hostname: final.hostname, viewport: { width, height, deviceScaleFactor: 1 }, screenshots, capturedAt, networkBytes: proxy.stats?.().usedBytes };
  })();

  try {
    return await bounded(work, clock, overallMs);
  } catch (error) {
    throw diagnosticError(captureDiagnosticCode(error) || 'CAPTURE_RUNTIME_FAILED', error);
  } finally {
    cancelled = true;
    options.signal?.removeEventListener?.('abort', abort);
    await cleanup();
    work.catch(() => {}).finally(cleanup);
  }
}
