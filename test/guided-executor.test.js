import assert from 'node:assert/strict';
import test from 'node:test';

import { GUIDED_LIMITS } from '../src/guided-interaction.js';
import { runGuidedActions } from '../src/guided-executor.js';

const INITIAL_URL = 'https://example.test/start';
const INVALID_OPTIONS = 'Invalid guided executor options.';

function action(label) {
  return { type: 'click', role: 'button', label };
}

function snapshot(documentUrl = INITIAL_URL) {
  return { documentUrl, origin: new URL(documentUrl).origin };
}

function evaluation(outcome = 'executed', policyReason = 'allowed', label) {
  if (outcome === 'executed') {
    return { outcome, policyReason, role: 'button', label, documentUrl: INITIAL_URL, origin: 'https://example.test' };
  }
  return { outcome, policyReason, documentUrl: INITIAL_URL, origin: 'https://example.test' };
}

function fakeHarness({
  snapshots = [snapshot()],
  evaluations = [],
  times = [1000],
  active = () => {},
  bounded = promise => promise
} = {}) {
  const calls = [];
  const snapshotQueue = [...snapshots];
  const evaluationQueue = [...evaluations];
  const timeQueue = [...times];
  let lastTime = timeQueue[0] ?? 1000;
  let evaluationCount = 0;
  const cdp = {
    evaluate: async expression => {
      calls.push(['evaluate', expression]);
      const value = expression.startsWith('({')
        ? (snapshotQueue.length ? snapshotQueue.shift() : snapshot())
        : evaluationQueue[evaluationCount++];
      return value;
    }
  };
  return {
    calls,
    cdp,
    options: {
      cdp,
      now: () => {
        calls.push(['now']);
        if (timeQueue.length) lastTime = timeQueue.shift();
        else lastTime += 1;
        return lastTime;
      },
      active: () => {
        calls.push(['active']);
        return active();
      },
      bounded: promise => {
        calls.push(['bounded']);
        return bounded(promise);
      },
      checkpointMs: 25
    }
  };
}

function assertFrozenDeep(value) {
  assert.ok(Object.isFrozen(value));
  if (value && typeof value === 'object') {
    for (const child of Object.values(value)) assertFrozenDeep(child);
  }
}

test('executes Start then English with ordered timestamps and frozen guided provenance', async () => {
  const fake = fakeHarness({
    snapshots: [snapshot(), snapshot(), snapshot()],
    evaluations: [evaluation('executed', 'allowed', 'Start'), evaluation('executed', 'allowed', 'English')],
    times: [1000, 1012, 1040]
  });

  const result = await runGuidedActions([action('Start'), action('English')], fake.options);

  assert.deepEqual(result, {
    schemaVersion: 1,
    interactionMode: 'guided',
    actions: [
      {
        order: 0, type: 'click', target: { role: 'button', label: 'Start', documentUrl: INITIAL_URL },
        relativeTimestampMs: 12, outcome: 'executed', policyReason: 'allowed'
      },
      {
        order: 1, type: 'click', target: { role: 'button', label: 'English', documentUrl: INITIAL_URL },
        relativeTimestampMs: 40, outcome: 'executed', policyReason: 'allowed'
      }
    ],
    warnings: []
  });
  assertFrozenDeep(result);
  assert.deepEqual(fake.calls.filter(([name]) => name === 'evaluate').map(([, expression]) => expression.startsWith('({') ? 'snapshot' : 'action'), [
    'snapshot', 'action', 'snapshot', 'action', 'snapshot'
  ]);
});

test('records missing and ambiguous targets as skipped and stops after the first non-success', async () => {
  for (const [reason, expected] of [['target_missing', 'missing'], ['target_ambiguous', 'ambiguous']]) {
    const fake = fakeHarness({ evaluations: [evaluation('skipped', reason)] });
    const result = await runGuidedActions([action('Start'), action('English')], fake.options);

    assert.equal(result.actions.length, 1);
    assert.equal(result.actions[0].outcome, 'skipped');
    assert.equal(result.actions[0].policyReason, reason);
    assert.deepEqual(result.warnings, [reason]);
    assert.equal(fake.calls.filter(([name]) => name === 'action').length, 0);
    assert.equal(fake.calls.filter(([name]) => name === 'evaluate').length, 2);
    assert.equal(expected.length > 0, true);
  }
});

test('records a forbidden page element as blocked and makes no later calls', async () => {
  const fake = fakeHarness({ evaluations: [evaluation('blocked', 'blocked_element')] });
  const result = await runGuidedActions([action('Start'), action('English')], fake.options);

  assert.equal(result.actions[0].outcome, 'blocked');
  assert.equal(result.actions[0].policyReason, 'blocked_element');
  assert.deepEqual(result.warnings, ['blocked_element']);
  assert.equal(fake.calls.filter(([name]) => name === 'evaluate').length, 2);
  assert.equal(fake.calls.filter(([name]) => name === 'active').length, 2);
});

test('enforces the action count validator', async () => {
  const fake = fakeHarness();
  await assert.rejects(
    runGuidedActions([action('One'), action('Two'), action('Three'), action('Four')], fake.options),
    /Invalid guided interaction settings\./
  );
  assert.equal(fake.calls.length, 0);
});

test('allows the 5000ms duration boundary and blocks an over-budget action', async () => {
  const boundary = fakeHarness({
    snapshots: [snapshot(), snapshot()],
    evaluations: [evaluation('executed', 'allowed', 'Start')],
    times: [1000, 6000]
  });
  const boundaryResult = await runGuidedActions([action('Start')], boundary.options);
  assert.equal(boundaryResult.actions[0].outcome, 'executed');
  assert.equal(boundaryResult.actions[0].relativeTimestampMs, GUIDED_LIMITS.maxDurationMs);

  const overBudget = fakeHarness({ times: [1000, 6001] });
  const overBudgetResult = await runGuidedActions([action('Start'), action('English')], overBudget.options);
  assert.deepEqual(overBudgetResult.actions, [{
    order: 0, type: 'click', target: { role: 'button', label: 'Start', documentUrl: '' },
    relativeTimestampMs: GUIDED_LIMITS.maxDurationMs + 1, outcome: 'blocked', policyReason: 'duration_exceeded'
  }]);
  assert.deepEqual(overBudgetResult.warnings, ['duration_exceeded']);
  assert.equal(overBudget.calls.filter(([name]) => name === 'evaluate').length, 1);
});

test('fails closed and stops after active, clock, evaluation, initial snapshot, and post-click snapshot failures', async () => {
  const initial = fakeHarness({ snapshots: [null] });
  const initialResult = await runGuidedActions([action('Start')], initial.options);
  assert.equal(initialResult.actions[0].policyReason, 'snapshot_failed');
  assert.equal(initial.calls.filter(([name]) => name === 'evaluate').length, 1);
  assert.equal(initial.calls.filter(([name]) => name === 'active').length, 1);

  const clock = fakeHarness({ times: [undefined] });
  const clockResult = await runGuidedActions([action('Start')], clock.options);
  assert.equal(clockResult.actions[0].policyReason, 'clock_failed');
  assert.equal(clock.calls.length, 1);

  const active = fakeHarness({ active: () => { throw new Error('inactive'); } });
  const activeResult = await runGuidedActions([action('Start')], active.options);
  assert.equal(activeResult.actions[0].policyReason, 'snapshot_failed');
  assert.equal(active.calls.filter(([name]) => name === 'evaluate').length, 0);

  const evaluationFailure = fakeHarness({ evaluations: [{ bad: true }] });
  const evaluationResult = await runGuidedActions([action('Start'), action('English')], evaluationFailure.options);
  assert.equal(evaluationResult.actions[0].policyReason, 'evaluation_failed');
  assert.equal(evaluationFailure.calls.filter(([name]) => name === 'evaluate').length, 2);

  const postSnapshot = fakeHarness({ snapshots: [snapshot(), null], evaluations: [evaluation('executed', 'allowed', 'Start')] });
  const postResult = await runGuidedActions([action('Start'), action('English')], postSnapshot.options);
  assert.equal(postResult.actions[0].outcome, 'failed');
  assert.equal(postResult.actions[0].policyReason, 'snapshot_failed');
  assert.equal(postSnapshot.calls.filter(([name]) => name === 'evaluate').length, 3);
  assert.equal(postSnapshot.calls.filter(([name]) => name === 'active').length, 3);
});

test('blocks cross-origin and new-document navigation on the clicked action', async () => {
  const crossOrigin = fakeHarness({
    snapshots: [snapshot(), snapshot('https://other.example/next')],
    evaluations: [evaluation('executed', 'allowed', 'Start')]
  });
  const crossOriginResult = await runGuidedActions([action('Start'), action('English')], crossOrigin.options);
  assert.equal(crossOriginResult.actions[0].outcome, 'blocked');
  assert.equal(crossOriginResult.actions[0].policyReason, 'origin_changed');
  assert.equal(crossOrigin.calls.filter(([name]) => name === 'evaluate').length, 3);

  const newDocument = fakeHarness({
    snapshots: [snapshot(), snapshot('https://example.test/next')],
    evaluations: [evaluation('executed', 'allowed', 'Start')]
  });
  const newDocumentResult = await runGuidedActions([action('Start'), action('English')], newDocument.options);
  assert.equal(newDocumentResult.actions[0].outcome, 'blocked');
  assert.equal(newDocumentResult.actions[0].policyReason, 'document_changed');
  assert.equal(newDocument.calls.filter(([name]) => name === 'evaluate').length, 3);
});

test('allows one hash-only navigation and blocks the second with navigation_limit', async () => {
  const fake = fakeHarness({
    snapshots: [snapshot(), snapshot(`${INITIAL_URL}#one`), snapshot(`${INITIAL_URL}#two`)],
    evaluations: [evaluation('executed', 'allowed', 'Start'), evaluation('executed', 'allowed', 'English')],
    times: [1000, 1010, 1020]
  });
  const result = await runGuidedActions([action('Start'), action('English')], fake.options);

  assert.equal(result.actions[0].outcome, 'executed');
  assert.equal(result.actions[1].outcome, 'blocked');
  assert.equal(result.actions[1].policyReason, 'navigation_limit');
  assert.deepEqual(result.warnings, ['navigation_limit']);
  assert.equal(fake.calls.filter(([name]) => name === 'evaluate').length, 5);
});

test('keeps action expressions data-only and excludes page-returned text', async () => {
  const configuredLabel = 'Open "menu"';
  const pageReturnedText = '"; globalThis.__guidedInjected = true; //';
  const fake = fakeHarness({ evaluations: [evaluation('executed', 'allowed', configuredLabel)] });
  const result = await runGuidedActions([action(configuredLabel)], fake.options);
  const expression = fake.calls.find(([name, value]) => name === 'evaluate' && value.startsWith('(()'))?.[1];

  assert.equal(result.actions[0].outcome, 'executed');
  assert.ok(expression.includes(JSON.stringify(configuredLabel)));
  assert.doesNotMatch(expression, /globalThis\.__guidedInjected\s*=\s*true/);
  assert.doesNotMatch(expression, new RegExp(pageReturnedText.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&')));
});

test('rejects invalid options and invalid snapshot/results without continuing', async () => {
  await assert.rejects(runGuidedActions([], null), error => error instanceof TypeError && error.message === INVALID_OPTIONS);
  await assert.rejects(runGuidedActions([], { cdp: {}, now() {}, active() {}, bounded() {}, checkpointMs: 0 }), error => error instanceof TypeError && error.message === INVALID_OPTIONS);

  const invalidSnapshot = fakeHarness({ snapshots: [{ documentUrl: 'not-a-url', origin: 'null' }] });
  const snapshotResult = await runGuidedActions([action('Start')], invalidSnapshot.options);
  assert.equal(snapshotResult.actions[0].policyReason, 'snapshot_failed');
  assert.equal(invalidSnapshot.calls.filter(([name]) => name === 'evaluate').length, 1);

  const invalidResult = fakeHarness({ evaluations: [{ outcome: 'executed', policyReason: 'allowed', role: 'link', label: 'Start', documentUrl: INITIAL_URL, origin: 'https://example.test' }] });
  const result = await runGuidedActions([action('Start'), action('English')], invalidResult.options);
  assert.equal(result.actions[0].policyReason, 'evaluation_failed');
  assert.equal(invalidResult.calls.filter(([name]) => name === 'evaluate').length, 2);
});
