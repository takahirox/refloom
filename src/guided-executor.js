import { GUIDED_LIMITS, validateGuidedActions } from './guided-interaction.js';

const INITIAL_SNAPSHOT_EXPRESSION = '({ documentUrl: location.href, origin: location.origin })';
const INVALID_OPTIONS = 'Invalid guided executor options.';

function isPlainObject(value) {
  return value !== null && typeof value === 'object' &&
    Object.getPrototypeOf(value) === Object.prototype;
}

function deepFreeze(value) {
  if (value === null || typeof value !== 'object' || Object.isFrozen(value)) return value;
  Object.freeze(value);
  for (const child of Object.values(value)) deepFreeze(child);
  return value;
}

function validUrl(value) {
  if (typeof value !== 'string' || value.length === 0) return false;
  try {
    new URL(value);
    return true;
  } catch {
    return false;
  }
}

function validSnapshot(value) {
  return isPlainObject(value) && Reflect.ownKeys(value).length === 2 &&
    typeof value.documentUrl === 'string' && validUrl(value.documentUrl) &&
    typeof value.origin === 'string';
}

function validEvaluation(value, label) {
  if (!isPlainObject(value) ||
      !['executed', 'skipped', 'blocked'].includes(value.outcome) ||
      !['allowed', 'target_missing', 'target_ambiguous', 'blocked_element'].includes(value.policyReason) ||
      typeof value.documentUrl !== 'string' || !validUrl(value.documentUrl) ||
      typeof value.origin !== 'string') return false;
  if (value.outcome === 'executed') {
    return value.role === 'button' && value.label === label;
  }
  return value.role === undefined && value.label === undefined;
}

function actionExpression(label) {
  const encodedLabel = JSON.stringify(label);
  return `(() => {
  const wanted = ${encodedLabel};
  const normalize = value => typeof value === 'string' ? value.normalize('NFKC').trim().replace(/\\s+/gu, ' ') : '';
  const visible = element => {
    const rect = element.getBoundingClientRect();
    const style = getComputedStyle(element);
    return rect.width > 0 && rect.height > 0 && style.display !== 'none' &&
      style.visibility !== 'hidden' && Number(style.opacity) > 0 &&
      rect.right > 0 && rect.bottom > 0 && rect.left < innerWidth && rect.top < innerHeight;
  };
  const candidates = [...document.querySelectorAll('button, input, [role="button"]')]
    .filter(element => {
      const tag = element.tagName.toLowerCase();
      const type = (element.getAttribute('type') || (tag === 'button' ? 'submit' : '')).toLowerCase();
      const buttonInput = tag === 'input' && type === 'button';
      const roleButton = element.getAttribute('role') === 'button';
      return (tag === 'button' || buttonInput || roleButton) &&
        !element.disabled && element.getAttribute('aria-disabled') !== 'true' && visible(element);
    })
    .filter(element => normalize(
      element.getAttribute('aria-label') ||
      (element.tagName.toLowerCase() === 'input' ? element.value : element.textContent)
    ) === wanted);
  const base = { documentUrl: location.href, origin: location.origin };
  if (candidates.length === 0) return { outcome: 'skipped', policyReason: 'target_missing', ...base };
  if (candidates.length !== 1) return { outcome: 'skipped', policyReason: 'target_ambiguous', ...base };
  const element = candidates[0];
  const tag = element.tagName.toLowerCase();
  const type = (element.getAttribute('type') || '').toLowerCase();
  if (element.closest('a, form') || ['submit', 'reset', 'file'].includes(type)) {
    return { outcome: 'blocked', policyReason: 'blocked_element', ...base };
  }
  element.click();
  return { outcome: 'executed', policyReason: 'allowed', role: 'button', label: wanted, ...base };
})()`;
}

function validateOptions(options) {
  if (!isPlainObject(options) || !isPlainObject(options.cdp) ||
      typeof options.cdp.evaluate !== 'function' ||
      typeof options.now !== 'function' || typeof options.active !== 'function' ||
      typeof options.bounded !== 'function' ||
      !Number.isSafeInteger(options.checkpointMs) || options.checkpointMs < 1) {
    throw new TypeError(INVALID_OPTIONS);
  }
}

function warningFor(reason) {
  return reason;
}

export async function runGuidedActions(actions, options) {
  const validatedActions = validateGuidedActions(actions);
  validateOptions(options);

  const output = [];
  const warnings = [];
  let timestamp = 0;
  let startedAt = 0;
  let clockFailed = false;
  try {
    startedAt = options.now();
    if (!Number.isSafeInteger(startedAt)) throw new TypeError('clock');
    timestamp = startedAt;
  } catch {
    clockFailed = true;
  }

  const appendFailure = (action, reason, outcome = 'failed') => {
    const record = {
      order: output.length,
      type: action.type,
      target: { role: 'button', label: action.label, documentUrl: '' },
      relativeTimestampMs: Math.max(0, timestamp - startedAt),
      outcome,
      policyReason: reason
    };
    output.push(record);
    warnings.push(warningFor(reason));
  };

  if (clockFailed && validatedActions.length > 0) {
    appendFailure(validatedActions[0], 'clock_failed');
  } else {
    let snapshot;
    let navigations = 0;
    try {
      options.active();
      snapshot = await options.bounded(
        options.cdp.evaluate(INITIAL_SNAPSHOT_EXPRESSION), options.checkpointMs
      );
      if (!validSnapshot(snapshot)) throw new TypeError('snapshot');
    } catch {
      snapshot = undefined;
      if (validatedActions.length > 0) appendFailure(validatedActions[0], 'snapshot_failed');
    }

    if (snapshot) {
      for (const action of validatedActions) {
        let actionTimestamp = timestamp;
        let halted = false;
        try {
          const activeResult = options.active();
          if (activeResult === false) throw new Error('inactive');
          actionTimestamp = options.now();
          if (!Number.isSafeInteger(actionTimestamp)) throw new TypeError('clock');
          timestamp = actionTimestamp;
          if (actionTimestamp - startedAt > GUIDED_LIMITS.maxDurationMs) {
            appendFailure(action, 'duration_exceeded', 'blocked');
            break;
          }

          const evaluation = await options.bounded(
            options.cdp.evaluate(actionExpression(action.label)), options.checkpointMs
          );
          if (!validEvaluation(evaluation, action.label)) throw new TypeError('evaluation');
          const record = {
            order: output.length,
            type: action.type,
            target: {
              role: 'button', label: action.label, documentUrl: snapshot.documentUrl
            },
            relativeTimestampMs: actionTimestamp - startedAt,
            outcome: evaluation.outcome,
            policyReason: evaluation.policyReason
          };
          output.push(record);
          if (record.outcome !== 'executed') {
            warnings.push(warningFor(record.policyReason));
            break;
          }

          let postClickSnapshot;
          try {
            options.active();
            postClickSnapshot = await options.bounded(
              options.cdp.evaluate(INITIAL_SNAPSHOT_EXPRESSION), options.checkpointMs
            );
            if (!validSnapshot(postClickSnapshot)) throw new TypeError('snapshot');
          } catch {
            record.outcome = 'failed';
            record.policyReason = 'snapshot_failed';
            warnings.push(warningFor(record.policyReason));
            break;
          }
          if (postClickSnapshot.origin !== snapshot.origin) {
            record.outcome = 'blocked';
            record.policyReason = 'origin_changed';
            warnings.push(warningFor(record.policyReason));
            break;
          }
          if (postClickSnapshot.documentUrl !== snapshot.documentUrl) {
            const before = new URL(snapshot.documentUrl);
            const after = new URL(postClickSnapshot.documentUrl);
            const sameDocument = before.origin === after.origin && before.pathname === after.pathname &&
              before.search === after.search;
            navigations += 1;
            if (!sameDocument || navigations > GUIDED_LIMITS.maxNavigations) {
              record.outcome = 'blocked';
              record.policyReason = sameDocument ? 'navigation_limit' : 'document_changed';
              warnings.push(warningFor(record.policyReason));
              break;
            }
          }
          snapshot = postClickSnapshot;
        } catch {
          appendFailure(action, 'evaluation_failed');
          halted = true;
        }
        if (halted) break;
      }
    }
  }

  return deepFreeze({
    schemaVersion: 1,
    interactionMode: 'guided',
    actions: output,
    warnings
  });
}
