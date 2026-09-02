export const PAGE_WEBGL_SURFACE_EXPRESSION = `(() => {
  const MAX_FRAMES = 8;
  const MAX_SURFACES = 32;
  const MAX_DEPTH = 3;
  const diagnosticKey = Symbol.for('refloom.pageRuntimeDiagnostic');
  const surfaces = [];
  const warnings = [];
  const seenWarnings = new Set();
  let frameCount = 0;
  let frameSequence = 0;
  let surfaceLimitReached = false;
  let depthLimitReached = false;
  const warn = value => {
    if (!seenWarnings.has(value)) {
      seenWarnings.add(value);
      warnings.push(value);
    }
  };
  const finite = value => Number.isFinite(value) && value >= 0 ? value : 0;
  const integer = value => Number.isSafeInteger(value) && value >= 0 ? value : 0;
  const locationUrl = win => {
    try { return String(win.location.href); } catch { return 'about:blank'; }
  };
  const originClass = (url, parentUrl, main) => {
    if (main) return 'main';
    try {
      const current = new URL(url);
      if (current.origin === 'null') return 'opaque';
      return current.origin === new URL(parentUrl).origin ? 'same-origin' : 'cross-origin';
    } catch { return 'opaque'; }
  };
  const addSurface = record => {
    if (surfaces.length >= MAX_SURFACES) {
      if (!surfaceLimitReached) warn('surface_limit_exceeded');
      surfaceLimitReached = true;
      return false;
    }
    surfaces.push(record);
    return true;
  };
  const styleVisible = (win, element) => {
    try {
      const style = win.getComputedStyle(element);
      return style.display !== 'none' && style.visibility !== 'hidden' &&
        Number(style.opacity) > 0;
    } catch { return true; }
  };
  const selectorFor = (element, tag) => {
    try {
      if (element.id) return '#' + String(element.id);
      const parent = element.parentElement;
      if (!parent) return tag;
      const siblings = Array.from(parent.children).filter(item => item.tagName === tag.toUpperCase());
      return tag + ':nth-of-type(' + (Math.max(0, siblings.indexOf(element)) + 1) + ')';
    } catch { return tag; }
  };
  const diagnosticRecords = win => {
    try {
      const state = win[diagnosticKey];
      const records = Array.isArray(state?.records) ? state.records : [];
      const contexts = Array.isArray(state?.contexts) ? state.contexts : [];
      return { state, records: records.concat(contexts.filter(item => !records.includes(item))) };
    } catch { return { state: null, records: [] }; }
  };
  const transferMarker = (state, canvas, record) => {
    try { return Boolean(record?.transferred || state?.transferred?.has(canvas)); } catch { return Boolean(record?.transferred); }
  };
  const drawCount = records => {
    let count = 0;
    for (const record of records) {
      if (Number.isSafeInteger(record?.drawCalls) && record.drawCalls > 0) count += record.drawCalls;
      else {
        count += integer(record?.drawArrays) + integer(record?.drawElements) +
          integer(record?.drawArraysInstanced) + integer(record?.drawElementsInstanced);
      }
    }
    return Number.isSafeInteger(count) && count >= 0 ? count : Number.MAX_SAFE_INTEGER;
  };
  const clippedBounds = (rect, offset, clip, viewportWidth, viewportHeight) => {
    const left = offset.x + finite(rect.left);
    const top = offset.y + finite(rect.top);
    const right = left + finite(rect.width);
    const bottom = top + finite(rect.height);
    const x1 = Math.max(0, clip.x, left);
    const y1 = Math.max(0, clip.y, top);
    const x2 = Math.min(viewportWidth, clip.x + clip.width, right);
    const y2 = Math.min(viewportHeight, clip.y + clip.height, bottom);
    return { x: x1, y: y1, width: Math.max(0, x2 - x1), height: Math.max(0, y2 - y1) };
  };
  const frameIdentity = depth => depth === 0 ? 'main-frame' : 'frame-' + (++frameSequence);
  const frameSource = (element, parentUrl) => {
    try {
      const source = String(element.src || '');
      return source || parentUrl;
    } catch { return parentUrl; }
  };
  const inspectFrame = (win, frameElement, parentUrl, frameId, depth, offset, clip, main) => {
    if (frameCount >= MAX_FRAMES) {
      warn('frame_limit_exceeded');
      return;
    }
    frameCount += 1;
    let doc;
    let url;
    try {
      doc = win.document;
      url = locationUrl(win);
      void doc.documentElement;
    } catch {
      const frameUrl = frameSource(frameElement, parentUrl);
      let bounds = { x: 0, y: 0, width: 0, height: 0 };
      try { bounds = clippedBounds(frameElement.getBoundingClientRect(), offset, clip, innerWidth, innerHeight); } catch {}
      addSurface({
        frameId, frameUrl, originClass: originClass(frameUrl, parentUrl, false),
        surfaceType: 'cross-origin-frame', selector: selectorFor(frameElement, 'iframe'),
        targetIdentity: frameUrl, observationMethod: 'frame-boundary', bounds,
        visible: bounds.width > 0 && bounds.height > 0, webglContext: false,
        drawCalls: 0, supported: false, domIndex: 0, depth
      });
      warn('unsupported_cross_origin_surface');
      return;
    }
    const localOrigin = originClass(url, parentUrl, main);
    const local = diagnosticRecords(win);
    let viewportWidth = 0;
    let viewportHeight = 0;
    try { viewportWidth = finite(win.innerWidth); viewportHeight = finite(win.innerHeight); } catch {}
    const canvases = Array.from(doc.querySelectorAll('canvas'));
    canvases.forEach((canvas, domIndex) => {
      if (surfaces.length >= MAX_SURFACES) { addSurface(null); return; }
      let rect = { left: 0, top: 0, width: 0, height: 0 };
      try { rect = canvas.getBoundingClientRect(); } catch {}
      const bounds = clippedBounds(rect, offset, clip, innerWidth, innerHeight);
      const related = local.records.filter(record => record?.canvas === canvas);
      const transferred = related.some(record => transferMarker(local.state, canvas, record)) || transferMarker(local.state, canvas, null);
      const hasContext = related.some(record => Boolean(record?.context));
      const visible = bounds.width > 0 && bounds.height > 0 && styleVisible(win, canvas);
      const selector = selectorFor(canvas, 'canvas');
      addSurface({
        frameId, frameUrl: url, originClass: localOrigin,
        surfaceType: transferred ? 'offscreen-transferred' : 'html-canvas',
        selector, targetIdentity: canvas.id ? String(canvas.id) : selector,
        observationMethod: transferred ? 'composited-offscreen-transfer' :
          related.length ? 'page-runtime-diagnostic' : 'dom-observation',
        bounds, visible, webglContext: hasContext || transferred, drawCalls: drawCount(related),
        supported: hasContext || transferred, domIndex, depth
      });
    });
    const offscreen = local.records.filter(record => record?.source === 'offscreen-page' && !record?.canvas);
    offscreen.forEach((record, index) => addSurface({
      frameId, frameUrl: url, originClass: localOrigin, surfaceType: 'worker-offscreen',
      selector: null, targetIdentity: 'worker-offscreen-' + index,
      observationMethod: 'page-runtime-diagnostic', bounds: { x: 0, y: 0, width: 0, height: 0 },
      visible: false, webglContext: Boolean(record?.context), drawCalls: drawCount([record]),
      supported: false, domIndex: canvases.length + index, depth
    }));
    if (depth >= MAX_DEPTH) {
      if (doc.querySelector('iframe,frame')) { depthLimitReached = true; warn('depth_limit_exceeded'); }
      return;
    }
    const frames = Array.from(doc.querySelectorAll('iframe,frame'));
    frames.forEach((element, domIndex) => {
      if (frameCount >= MAX_FRAMES) { warn('frame_limit_exceeded'); return; }
      let rect = { left: 0, top: 0, width: 0, height: 0 };
      try { rect = element.getBoundingClientRect(); } catch {}
      const childClip = clippedBounds(rect, offset, clip, innerWidth, innerHeight);
      let childWindow;
      try { childWindow = element.contentWindow; void childWindow.document; } catch { childWindow = null; }
      const childId = 'frame-' + (++frameSequence);
      if (!childWindow) {
        const frameUrl = frameSource(element, url);
        addSurface({
          frameId: childId, frameUrl, originClass: originClass(frameUrl, url, false),
          surfaceType: 'cross-origin-frame', selector: selectorFor(element, 'iframe'),
          targetIdentity: frameUrl, observationMethod: 'frame-boundary', bounds: childClip,
          visible: childClip.width > 0 && childClip.height > 0 && styleVisible(win, element),
          webglContext: false, drawCalls: 0, supported: false, domIndex, depth: depth + 1
        });
        warn('unsupported_cross_origin_surface');
        return;
      }
      inspectFrame(childWindow, element, url, childId, depth + 1,
        { x: offset.x + finite(rect.left), y: offset.y + finite(rect.top) }, childClip, false);
    });
  };
  let rootUrl = locationUrl(globalThis);
  let width = 0;
  let height = 0;
  try { width = finite(innerWidth); height = finite(innerHeight); } catch {}
  inspectFrame(globalThis, null, rootUrl, frameIdentity(0), 0,
    { x: 0, y: 0 }, { x: 0, y: 0, width, height }, true);
  if (surfaces.some(record => record?.surfaceType === 'worker-offscreen' && record.visible &&
      !surfaces.some(item => item?.surfaceType === 'offscreen-transferred' && item.visible && item.webglContext))) {
    warn('worker_offscreen_without_transferred_visible_canvas');
  }
  if (!surfaces.some(record => record?.supported && record.visible && record.webglContext &&
      (record.surfaceType === 'html-canvas' || record.surfaceType === 'offscreen-transferred'))) {
    warn('no_supported_surface');
  }
  return { surfaces, warnings };
})()`;
