import { createMoment, createTarget } from '../../src/domain.js';
import { digest } from '../../src/visparse-runner.js';
import { png } from './analysis-profile.mjs';

export function capturedEvidence(store) {
  const metadata = {
    captureMethod: 'automated-browser', captureStrategy: 'passive-webgl-observation',
    mode: 'interactive-auto', capturedAt: '2026-09-01T00:00:00.000Z',
    originalUrl: 'https://example.com/', finalUrl: 'https://example.com/',
    viewport: { width: 1280, height: 720 }, screenshotSha256: digest(png),
    checkpointIndex: 0, relativeTimestampMs: 0,
    automation: { schemaVersion: 1, interactionMode: 'passive', actions: [{ type: 'capture' }] },
    targetCanvas: { frameId: 'frame-1', frameUrl: 'https://example.com/', originClass: 'main',
      surfaceType: 'html-canvas', selector: 'canvas', targetIdentity: 'canvas-1',
      observationMethod: 'main-runtime-hook', bounds: { x: 0, y: 0, width: 640, height: 480 },
      visible: true, webglContext: true, drawCalls: 10, supported: true, domIndex: 0, depth: 0 }
  };
  store.workspace.assets[0].provenance = structuredClone(metadata);
  store.workspace = createTarget(store.workspace, { id: 't', referenceId: 'r', assetId: 'a', kind: 'frame' });
  store.workspace = createMoment(store.workspace, { id: 'm', targetId: 't', state: metadata });
  return store;
}
