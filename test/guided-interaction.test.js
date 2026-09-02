import assert from 'node:assert/strict';
import test from 'node:test';

import { GUIDED_LIMITS, validateGuidedActions } from '../src/guided-interaction.js';

const INVALID_MESSAGE = 'Invalid guided interaction settings.';
const symbolKey = Symbol('unexpected');

function action(label, overrides = {}) {
  return { type: 'click', role: 'button', label, ...overrides };
}

function assertInvalid(value) {
  assert.throws(
    () => validateGuidedActions(value),
    error => error instanceof TypeError && error.message === INVALID_MESSAGE
  );
}

test('GUIDED_LIMITS exposes the bounded frozen policy', () => {
  assert.deepEqual(GUIDED_LIMITS, {
    maxActions: 3,
    maxDurationMs: 5000,
    maxNavigations: 1
  });
  assert.ok(Object.isFrozen(GUIDED_LIMITS));
});

test('valid actions normalize labels and deeply freeze only the result', () => {
  const input = [
    action('  Ｏｐｅｎ   menu\n now  '),
    action('Choose\titem'),
    action('Next page')
  ];
  const before = input.map(item => ({ ...item }));

  const result = validateGuidedActions(input);

  assert.deepEqual(result, [
    { type: 'click', role: 'button', label: 'Open menu now' },
    { type: 'click', role: 'button', label: 'Choose item' },
    { type: 'click', role: 'button', label: 'Next page' }
  ]);
  assert.ok(Object.isFrozen(result));
  assert.ok(result.every(item => Object.isFrozen(item)));
  assert.notStrictEqual(result, input);
  assert.deepEqual(input, before);
  assert.equal(Object.isFrozen(input), false);
  assert.equal(Object.isFrozen(input[0]), false);
  assert.throws(() => { result[0].label = 'Changed'; }, TypeError);
  assert.throws(() => { result.push(action('Another')); }, TypeError);
});

test('accepts zero through three actions and labels at the Unicode boundary', () => {
  assert.deepEqual(validateGuidedActions([]), []);
  assert.equal(validateGuidedActions([action('One')]).length, 1);
  assert.equal(validateGuidedActions([action('One'), action('Two'), action('Three')]).length, 3);
  assert.equal(validateGuidedActions([action('a'.repeat(80))])[0].label.length, 80);
  assert.equal(validateGuidedActions([action('😀'.repeat(80))])[0].label, '😀'.repeat(80));
});

test('rejects non-arrays and action lists above the maximum', () => {
  for (const value of [null, undefined, {}, 'actions', new Set(), 3]) assertInvalid(value);
  assertInvalid([action('One'), action('Two'), action('Three'), action('Four')]);
});

test('rejects non-plain action objects', () => {
  class CustomAction {
    constructor() {
      this.type = 'click';
      this.role = 'button';
      this.label = 'Custom';
    }
  }
  for (const value of [
    [null],
    [[]],
    [new Date()],
    [Object.create(null)],
    [new CustomAction()]
  ]) assertInvalid(value);
});

test('rejects missing, extra, and symbol action keys', () => {
  const missing = { type: 'click', role: 'button' };
  const extra = action('Extra', { description: 'not allowed' });
  const symbol = action('Symbol');
  symbol[symbolKey] = true;

  assertInvalid([missing]);
  assertInvalid([extra]);
  assertInvalid([symbol]);
  assert.deepEqual(Object.keys(extra), ['type', 'role', 'label', 'description']);
  assert.equal(symbol[symbolKey], true);
  assert.deepEqual(Reflect.ownKeys(symbol), ['type', 'role', 'label', symbolKey]);
});

test('rejects wrong type, role, and non-string labels', () => {
  for (const candidate of [
    action('Wrong type', { type: 'tap' }),
    action('Wrong role', { role: 'link' }),
    action('Number label', { label: 1 }),
    action('Null label', { label: null }),
    action('Object label', { label: {} })
  ]) assertInvalid([candidate]);
});

test('rejects empty and over-80 Unicode labels', () => {
  for (const label of ['', '   ', '\n\t  ', 'a'.repeat(81), '😀'.repeat(81)]) {
    assertInvalid([action(label)]);
  }
});

test('rejects every forbidden label term and its supported variants', () => {
  for (const label of [
    'Wallet', 'AUTH', 'login', 'sign in', 'sign-in', 'signin',
    'purchase', 'BUY', 'upload', 'permission', 'clipboard', 'download',
    'submit', 'form', 'checkout', 'connect'
  ]) assertInvalid([action(`Open ${label} dialog`)]);
});

test('rejects duplicate labels after normalization', () => {
  assertInvalid([action('Open   menu'), action(' Open menu ')]);
  assertInvalid([action('Ｆｉｌｅ'), action('File')]);
  assertInvalid([action('😀'), action('😀')]);
  assert.deepEqual(validateGuidedActions([action('Open menu'), action('Open Menu')]), [
    { type: 'click', role: 'button', label: 'Open menu' },
    { type: 'click', role: 'button', label: 'Open Menu' }
  ]);
});

test('does not mutate invalid inputs while rejecting them', () => {
  const extra = action('Keep me', { extra: true });
  const input = [extra];
  const keysBefore = Reflect.ownKeys(extra);
  const valuesBefore = keysBefore.map(key => [key, extra[key]]);

  assertInvalid(input);

  assert.deepEqual(Reflect.ownKeys(extra), keysBefore);
  for (const [key, value] of valuesBefore) assert.strictEqual(extra[key], value);
  assert.strictEqual(input[0], extra);
  assert.equal(Object.isFrozen(input), false);
  assert.equal(Object.isFrozen(extra), false);
});
