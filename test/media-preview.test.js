import assert from 'node:assert/strict';
import test from 'node:test';
import { createMediaPreviewController, orderPreviewAssets } from '../src/media-preview.js';

const image = (id, timestamp) => ({
  id, kind: 'image', ...(timestamp === undefined ? {} : { provenance: { relativeTimestampMs: timestamp } })
});
const video = (id, timestamp) => ({
  id, kind: 'video', ...(timestamp === undefined ? {} : { provenance: { relativeTimestampMs: timestamp } })
});
const flush = async () => {
  for (let i = 0; i < 12; i += 1) await Promise.resolve();
};
const deferred = () => {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
};
function fakeTimers() {
  let now = 0, nextId = 1;
  const timers = new Map();
  return {
    setTimer(callback, delay) {
      const id = nextId++;
      timers.set(id, { callback, at: now + delay });
      return id;
    },
    clearTimer(id) { timers.delete(id); },
    delays() { return [...timers.values()].map(timer => timer.at - now).sort((a, b) => a - b); },
    async tick(ms) {
      const target = now + ms;
      while (true) {
        const due = [...timers.entries()]
          .filter(([, timer]) => timer.at <= target)
          .sort((a, b) => a[1].at - b[1].at || a[0] - b[0])[0];
        if (!due) break;
        now = due[1].at;
        timers.delete(due[0]);
        due[1].callback();
        await flush();
      }
      now = target;
      await flush();
    }
  };
}
function setup({ assets, initialUrl = 'url:first', load, ...options }) {
  const clock = fakeTimers();
  const shown = [], created = [], revoked = [];
  const controller = createMediaPreviewController({
    assets, initialUrl,
    load: load ?? (async asset => `blob:${asset.id}`),
    createUrl(blob, asset) { const url = `url:${asset.id}`; created.push([blob, url]); return url; },
    revokeUrl(url) { revoked.push(url); },
    show(value) { shown.push(value); },
    setTimer: clock.setTimer, clearTimer: clock.clearTimer,
    ...options
  });
  return { controller, clock, shown, created, revoked };
}

test('orderPreviewAssets keeps preview media in stable provenance order with untimed last', () => {
  const assets = [image('late', 20), { id: 'text', kind: 'text' }, video('tie-a', 10),
    image('untimed'), image('tie-b', 10), image('invalid', Number.NaN)];
  assert.deepEqual(orderPreviewAssets(assets).map(asset => asset.id),
    ['tie-a', 'tie-b', 'late', 'untimed', 'invalid']);
});

test('start observes dwell and interval timing, then stop resets and releases', async () => {
  const first = image('first', 0), second = image('second', 1);
  const releases = [], loaded = [];
  const state = setup({
    assets: [first, second], release: value => releases.push(value),
    load: async asset => { loaded.push(asset.id); return `blob:${asset.id}`; }
  });
  assert.equal(state.controller.start(), true);
  assert.deepEqual(state.clock.delays(), [300]);
  await state.clock.tick(299);
  assert.equal(state.shown.length, 0);
  await state.clock.tick(1);
  assert.deepEqual(state.shown.map(({ asset, url }) => [asset.id, url]), [['first', 'url:first']]);
  assert.deepEqual(loaded, []);
  assert.deepEqual(state.clock.delays(), [800]);
  await state.clock.tick(800);
  assert.deepEqual(state.shown.at(-1), { asset: second, url: 'url:second', index: 1, playing: false });
  assert.deepEqual(loaded, ['second']);
  assert.equal(state.controller.stop(), true);
  assert.deepEqual(state.clock.delays(), []);
  assert.deepEqual(state.shown.at(-1), { asset: first, url: 'url:first', index: 0, playing: false });
  assert.deepEqual(releases, [state.controller]);
});

test('a single video auto-plays on activity and manual toggles its play state', async () => {
  const asset = video('clip', 0);
  const state = setup({ assets: [asset] });
  state.controller.start();
  await state.clock.tick(300);
  assert.equal(state.shown.at(-1).playing, false);
  await state.clock.tick(800);
  assert.equal(state.shown.at(-1).playing, true);
  await state.controller.manual();
  assert.equal(state.shown.at(-1).playing, false);
  await state.controller.manual();
  assert.equal(state.shown.at(-1).playing, true);
  state.controller.stop();
  assert.deepEqual(state.shown.at(-1), { asset, url: 'url:first', index: 0, playing: false });
});

test('reduced motion schedules nothing and immediate manual image advance stays manual', async () => {
  const first = image('first'), second = image('second');
  const state = setup({ assets: [first, second], reducedMotion: true });
  assert.equal(state.controller.start({ immediate: true }), true);
  await flush();
  assert.deepEqual(state.shown.map(value => value.asset.id), ['first']);
  assert.deepEqual(state.clock.delays(), []);
  await state.controller.manual();
  assert.deepEqual(state.shown.map(value => value.asset.id), ['first', 'second']);
  assert.deepEqual(state.clock.delays(), []);
});

test('a corrupt secondary asset falls through while the active preview remains usable', async () => {
  const first = image('first'), corrupt = image('corrupt'), third = image('third');
  const loaded = [];
  const state = setup({ assets: [first, corrupt, third], load: async asset => {
    loaded.push(asset.id);
    if (asset === corrupt) throw new Error('corrupt');
    return `blob:${asset.id}`;
  } });
  state.controller.start({ immediate: true });
  await flush();
  await state.clock.tick(800);
  assert.deepEqual(loaded, ['corrupt', 'third']);
  assert.deepEqual(state.shown.map(value => value.asset.id), ['first', 'third']);
  assert.deepEqual(state.clock.delays(), [800]);
});

test('a secondary load resolved after stop cannot show or leak an object URL', async () => {
  const pending = deferred();
  const state = setup({ assets: [image('first'), image('second')], load: () => pending.promise });
  state.controller.start({ immediate: true });
  await flush();
  await state.clock.tick(800);
  state.controller.stop();
  const showsAtStop = state.shown.length;
  pending.resolve('late-blob');
  await flush();
  assert.equal(state.shown.length, showsAtStop);
  assert.deepEqual(state.created, []);
  assert.deepEqual(state.revoked, []);
  assert.deepEqual(state.clock.delays(), []);
});

test('claims prevent rejected and simultaneous starts until the owner releases', () => {
  const denied = setup({ assets: [image('denied')], claim: () => false });
  assert.equal(denied.controller.start(), false);
  assert.deepEqual(denied.clock.delays(), []);
  let owner;
  const claim = candidate => owner ? false : Boolean(owner = candidate);
  const release = candidate => { if (owner === candidate) owner = undefined; };
  const first = setup({ assets: [image('one')], claim, release });
  const second = setup({ assets: [image('two')], claim, release });
  assert.equal(first.controller.start(), true);
  assert.equal(second.controller.start(), false);
  first.controller.stop();
  assert.equal(second.controller.start(), true);
});

test('destroy is idempotent and revokes initial and created URLs exactly once', async () => {
  const state = setup({ assets: [image('first'), image('second')] });
  state.controller.start({ immediate: true });
  await flush();
  await state.controller.manual();
  assert.deepEqual(state.created, [['blob:second', 'url:second']]);
  state.controller.destroy();
  state.controller.destroy();
  assert.deepEqual(state.revoked.sort(), ['url:first', 'url:second']);
  assert.equal(state.controller.start(), false);
});
