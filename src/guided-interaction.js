const INVALID_GUIDED_INTERACTION = 'Invalid guided interaction settings.';
const BLOCKED_LABEL_TERMS = /(?:wallet|auth|login|sign[ -]?in|purchase|buy|upload|permission|clipboard|download|submit|form|checkout|connect)/iu;

export const GUIDED_LIMITS = Object.freeze({
  maxActions: 3,
  maxDurationMs: 5000,
  maxNavigations: 1
});

function invalid() {
  throw new TypeError(INVALID_GUIDED_INTERACTION);
}

function normalizeLabel(label) {
  if (typeof label !== 'string') invalid();
  const normalized = label.normalize('NFKC').trim().replace(/\s+/gu, ' ');
  if (normalized.length === 0 || [...normalized].length > 80 || BLOCKED_LABEL_TERMS.test(normalized)) {
    invalid();
  }
  return normalized;
}

function isPlainObject(value) {
  return value !== null && typeof value === 'object' &&
    Object.getPrototypeOf(value) === Object.prototype;
}

function deepFreeze(value) {
  Object.freeze(value);
  for (const child of Object.values(value)) {
    if (child !== null && typeof child === 'object' && !Object.isFrozen(child)) {
      deepFreeze(child);
    }
  }
  return value;
}

export function validateGuidedActions(value) {
  if (!Array.isArray(value) || value.length > GUIDED_LIMITS.maxActions) invalid();

  const labels = new Set();
  const actions = value.map(action => {
    if (!isPlainObject(action) ||
        Reflect.ownKeys(action).length !== 3 ||
        !Object.prototype.hasOwnProperty.call(action, 'type') ||
        !Object.prototype.hasOwnProperty.call(action, 'role') ||
        !Object.prototype.hasOwnProperty.call(action, 'label') ||
        action.type !== 'click' || action.role !== 'button') {
      invalid();
    }
    const label = normalizeLabel(action.label);
    if (labels.has(label)) invalid();
    labels.add(label);
    return { type: 'click', role: 'button', label };
  });

  return deepFreeze(actions);
}
