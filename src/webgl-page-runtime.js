export const PAGE_WEBGL_RUNTIME_HOOK = `(() => {
  const key = Symbol.for('refloom.pageRuntimeDiagnostic');
  const existing = globalThis[key];
  if (existing?.installed) return;

  const state = {
    installed: true,
    webGlContextFailure: false,
    records: [],
    transferred: new WeakSet()
  };
  Object.defineProperty(globalThis, key, {
    configurable: false,
    enumerable: false,
    value: state,
    writable: false
  });

  const webglType = type => {
    const normalized = String(type).toLowerCase();
    return normalized === 'webgl' || normalized === 'webgl2' ? normalized : null;
  };

  const recordContext = (context, type, canvas, source) => {
    if (!context || state.records.some(record => record.context === context)) return;
    if (state.records.length >= 32) return;
    const record = {
      context,
      canvas: canvas || null,
      source,
      type,
      transferred: Boolean(canvas && state.transferred.has(canvas)),
      clear: 0,
      drawArrays: 0,
      drawElements: 0
    };
    state.records.push(record);
    for (const method of ['clear', 'drawArrays', 'drawElements']) {
      const original = context[method];
      if (typeof original !== 'function') continue;
      try {
        context[method] = function(...args) {
          record[method] += 1;
          return Reflect.apply(original, this, args);
        };
      } catch {
        // Some native WebGL implementations expose read-only methods.
      }
    }
  };

  const canvasPrototype = globalThis.HTMLCanvasElement?.prototype;
  if (canvasPrototype) {
    const nativeGetContext = canvasPrototype.getContext;
    if (typeof nativeGetContext === 'function') {
      canvasPrototype.getContext = function(type, ...args) {
        const kind = webglType(type);
        try {
          const context = Reflect.apply(nativeGetContext, this, [type, ...args]);
          if (kind) recordContext(context, kind, this, 'canvas');
          return context;
        } catch (error) {
          if (kind) state.webGlContextFailure = true;
          throw error;
        }
      };
    }
    const nativeTransfer = canvasPrototype.transferControlToOffscreen;
    if (typeof nativeTransfer === 'function') {
      canvasPrototype.transferControlToOffscreen = function(...args) {
        const result = Reflect.apply(nativeTransfer, this, args);
        state.transferred.add(this);
        for (const record of state.records) {
          if (record.canvas === this) record.transferred = true;
        }
        return result;
      };
    }
  }

  const offscreenPrototype = globalThis.OffscreenCanvas?.prototype;
  if (offscreenPrototype && typeof offscreenPrototype.getContext === 'function') {
    const nativeGetContext = offscreenPrototype.getContext;
    offscreenPrototype.getContext = function(type, ...args) {
      const kind = webglType(type);
      try {
        const context = Reflect.apply(nativeGetContext, this, [type, ...args]);
        if (kind) recordContext(context, kind, null, 'offscreen-page');
        return context;
      } catch (error) {
        if (kind) state.webGlContextFailure = true;
        throw error;
      }
    };
  }
})()`;
