export function orderPreviewAssets(assets) {
  return assets
    .filter(asset => asset?.kind === 'image' || asset?.kind === 'video')
    .map((asset, inputIndex) => ({ asset, inputIndex }))
    .sort((left, right) => {
      const a = left.asset.provenance?.relativeTimestampMs;
      const b = right.asset.provenance?.relativeTimestampMs;
      if (Number.isFinite(a) && Number.isFinite(b)) return a - b || left.inputIndex - right.inputIndex;
      if (Number.isFinite(a) !== Number.isFinite(b)) return Number.isFinite(a) ? -1 : 1;
      return left.inputIndex - right.inputIndex;
    })
    .map(entry => entry.asset);
}

export function createMediaPreviewController(options) {
  const items = orderPreviewAssets(options.assets);
  const {
    load, createUrl, revokeUrl, show,
    setTimer = globalThis.setTimeout, clearTimer = globalThis.clearTimeout,
    claim = () => true, release = () => {},
    initialUrl, reducedMotion = false, dwellMs = 300, intervalMs = 800
  } = options;
  const urls = new Map();
  const knownUrls = new Map();
  if (initialUrl !== undefined) {
    urls.set(items[0], initialUrl);
    knownUrls.set(initialUrl, { asset: items[0], revoked: false });
  }
  let index = 0, active = false, claimed = false, destroyed = false, playing = false;
  let timer, generation = 0;

  function cancelTimer() {
    if (timer === undefined) return;
    clearTimer(timer);
    timer = undefined;
  }
  function revokeAsset(asset) {
    const url = urls.get(asset);
    if (url === undefined) return;
    urls.delete(asset);
    const record = knownUrls.get(url);
    if (record && !record.revoked) {
      record.revoked = true;
      revokeUrl(url, asset);
    }
  }
  function dropAsset(asset) {
    const position = items.indexOf(asset);
    if (position < 0) return -1;
    revokeAsset(asset);
    items.splice(position, 1);
    if (position < index) index -= 1;
    if (index >= items.length) index = 0;
    return position;
  }

  async function ensureUrl(asset, token) {
    if (urls.has(asset)) return { url: urls.get(asset) };
    let blob;
    try { blob = await load(asset); }
    catch { return { failed: true }; }
    if (!active || destroyed || token !== generation || !items.includes(asset)) return { stale: true };
    let url;
    try { url = createUrl(blob, asset); }
    catch { return { failed: true }; }
    if (!active || destroyed || token !== generation || !items.includes(asset)) {
      revokeUrl(url, asset);
      return { stale: true };
    }
    urls.set(asset, url);
    if (!knownUrls.has(url)) knownUrls.set(url, { asset, revoked: false });
    return { url };
  }
  async function showAsset(asset, token, play) {
    const result = await ensureUrl(asset, token);
    if (token !== generation || !active || destroyed) return false;
    if (result.failed) { dropAsset(asset); return false; }
    if (result.stale) return false;
    const position = items.indexOf(asset);
    if (position < 0) return false;
    index = position;
    playing = Boolean(play && asset.kind === 'video');
    show({ asset, url: result.url, index, playing });
    return true;
  }

  function schedule(token) {
    if (!active || destroyed || reducedMotion || token !== generation || !items.length) return;
    cancelTimer();
    timer = setTimer(async () => {
      timer = undefined;
      if (!active || destroyed || token !== generation) return;
      await advance(token, true);
      if (active && !destroyed && token === generation) schedule(token);
    }, intervalMs);
  }
  async function showPoster(token) {
    while (active && !destroyed && token === generation && items.length) {
      const asset = items[0];
      if (await showAsset(asset, token, false)) return true;
    }
    return false;
  }
  async function advance(token, autoPlayVideo) {
    if (!active || destroyed || token !== generation || !items.length) return false;
    if (items.length === 1) return showAsset(items[0], token, autoPlayVideo);
    let remaining = items.length;
    while (active && token === generation && items.length && remaining > 0) {
      const asset = items[(index + 1) % items.length];
      if (await showAsset(asset, token, autoPlayVideo)) return true;
      remaining -= 1;
    }
    if (!items.length) stop();
    return false;
  }

  async function begin(token) {
    timer = undefined;
    if (!active || destroyed || token !== generation) return;
    if (await showPoster(token)) schedule(token);
    else if (!items.length) stop();
  }
  function start({ immediate = false } = {}) {
    if (destroyed || active || !items.length) return false;
    if (claim(controller) === false) return false;
    claimed = true;
    active = true;
    playing = false;
    const token = ++generation;
    if (immediate) void begin(token);
    else timer = setTimer(() => void begin(token), dwellMs);
    return true;
  }

  function stop() {
    if (!active && timer === undefined && !claimed) return false;
    active = false;
    generation += 1;
    cancelTimer();
    playing = false;
    index = 0;
    if (items.length) show({ asset: items[0], url: urls.get(items[0]), index: 0, playing: false });
    if (claimed) { claimed = false; release(controller); }
    return true;
  }
  async function manual() {
    if (destroyed || !active || !items.length) return false;
    cancelTimer();
    const token = ++generation;
    if (items.length === 1 && items[0].kind === 'video') {
      const shown = await showAsset(items[0], token, !playing);
      if (!items.length) stop();
      return shown;
    }
    const shown = await advance(token, false);
    if (!items.length) stop();
    return shown;
  }
  function failed(asset) {
    const position = items.indexOf(asset);
    if (position < 0) return false;
    const wasCurrent = position === index;
    dropAsset(asset);
    if (!active || !wasCurrent) return true;
    cancelTimer();
    const token = ++generation;
    if (!items.length) { stop(); return true; }
    void showAsset(items[index], token, false).then(shown => {
      if (active && token === generation && shown) schedule(token);
      else if (!items.length) stop();
    });
    return true;
  }

  function destroy() {
    if (destroyed) return;
    destroyed = true;
    stop();
    for (const [url, record] of knownUrls) {
      if (!record.revoked) {
        record.revoked = true;
        revokeUrl(url, record.asset);
      }
    }
    urls.clear();
  }
  const controller = { start, stop, manual, failed, destroy };
  return controller;
}
