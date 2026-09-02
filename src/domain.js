import { isCanonicalReferenceTags, normalizeReferenceTags } from './reference-tags.js';

export const WORKSPACE_VERSION = 2;
export const CREATIVE_DIRECTION_VERSION = 2;
export const DEFAULT_WORKSPACE_SETTINGS = Object.freeze({ automaticWebsiteCapture: true });

const COLLECTIONS = ['projects', 'references', 'assets', 'targets', 'moments', 'selections', 'boards', 'signals'];
const TARGET_KINDS = new Set(['reference', 'asset', 'region', 'frame', 'interaction']);
const ASSET_KINDS = new Set(['image', 'video', 'url']);
const SIGNAL_EVENTS = new Set(['capture', 'enrich', 'selection.create', 'board.change', 'export']);

export class ValidationError extends Error {
  constructor(issues) {
    super('Workspace validation failed');
    this.name = 'ValidationError';
    this.issues = issues;
  }
}

const copy = value => structuredClone(value);
const now = () => new Date().toISOString();
const id = prefix => `${prefix}_${crypto.randomUUID()}`;
const required = (value, name) => {
  if (typeof value !== 'string' || value.trim() === '') throw new TypeError(`${name} must be a non-empty string`);
  return value.trim();
};
const optional = (value, name) => {
  if (value === undefined || value === null || value === '') return undefined;
  if (typeof value !== 'string') throw new TypeError(`${name} must be a string`);
  return value;
};
const stamp = (entity, timestamp = now()) => ({
  ...Object.fromEntries(Object.entries(entity).filter(([, value]) => value !== undefined)),
  createdAt: timestamp,
  updatedAt: timestamp
});
const append = (workspace, collection, entity) => ({ ...copy(workspace), [collection]: [...workspace[collection], entity] });
const find = (workspace, collection, entityId) => workspace[collection].find(item => item.id === entityId);
const need = (workspace, collection, entityId) => {
  const entity = find(workspace, collection, entityId);
  if (!entity) throw new RangeError(`${collection} does not contain ${entityId}`);
  return entity;
};

export function createWorkspace() {
  return Object.fromEntries([
    ['version', WORKSPACE_VERSION],
    ['settings', copy(DEFAULT_WORKSPACE_SETTINGS)],
    ...COLLECTIONS.map(name => [name, []])
  ]);
}

export function updateWorkspaceSettings(workspace, changes) {
  validateWorkspace(workspace);
  if (!changes || typeof changes !== 'object' || Array.isArray(changes)
    || Object.keys(changes).some(key => key !== 'automaticWebsiteCapture')
    || (changes.automaticWebsiteCapture !== undefined
      && typeof changes.automaticWebsiteCapture !== 'boolean')) {
    throw new TypeError('Workspace capture settings are invalid');
  }
  return {
    ...copy(workspace),
    settings: { ...copy(workspace.settings), ...copy(changes) }
  };
}

export function createProject(workspace, input) {
  const timestamp = now();
  return append(workspace, 'projects', stamp({ id: input.id ?? id('project'), title: required(input.title, 'title'), brief: optional(input.brief, 'brief') }, timestamp));
}

export function updateProject(workspace, projectId, changes) {
  need(workspace, 'projects', projectId);
  const allowed = { title: changes.title === undefined ? undefined : required(changes.title, 'title'), brief: changes.brief === undefined ? undefined : optional(changes.brief, 'brief') };
  return update(workspace, 'projects', projectId, allowed);
}

export function createReference(workspace, input) {
  need(workspace, 'projects', input.projectId);
  return append(workspace, 'references', stamp({
    id: input.id ?? id('reference'), projectId: input.projectId,
    title: optional(input.title, 'title'), sourceUrl: optional(input.sourceUrl, 'sourceUrl'),
    creator: optional(input.creator, 'creator'), notes: optional(input.notes, 'notes'),
    tags: normalizeReferenceTags(input.tags),
    capturedAt: input.capturedAt ?? now(), captureMethod: required(input.captureMethod ?? 'manual', 'captureMethod')
  }));
}

export function updateReference(workspace, referenceId, changes) {
  need(workspace, 'references', referenceId);
  const allowed = {};
  for (const field of ['title', 'sourceUrl', 'creator', 'notes']) if (field in changes) allowed[field] = optional(changes[field], field);
  if (changes.tags !== undefined) allowed.tags = normalizeReferenceTags(changes.tags);
  return update(workspace, 'references', referenceId, allowed);
}

export function createAsset(workspace, input) {
  const reference = need(workspace, 'references', input.referenceId);
  if (!ASSET_KINDS.has(input.kind)) throw new TypeError('kind must be image, video, or url');
  return append(workspace, 'assets', stamp({
    id: input.id ?? id('asset'), projectId: reference.projectId, referenceId: reference.id,
    kind: input.kind, locator: required(input.locator, 'locator'), mediaType: optional(input.mediaType, 'mediaType'),
    capturedAt: input.capturedAt ?? now(), provenance: copy(input.provenance ?? {})
  }));
}

export function createTarget(workspace, input) {
  const reference = need(workspace, 'references', input.referenceId);
  if (!TARGET_KINDS.has(input.kind)) throw new TypeError('invalid target kind');
  if (input.assetId) {
    const asset = need(workspace, 'assets', input.assetId);
    if (asset.referenceId !== reference.id) throw new RangeError('target asset must belong to its reference');
  }
  if (input.kind === 'asset' && !input.assetId) throw new TypeError('asset targets require assetId');
  return append(workspace, 'targets', stamp({
    id: input.id ?? id('target'), projectId: reference.projectId, referenceId: reference.id,
    assetId: input.assetId, kind: input.kind, detail: copy(input.detail ?? {})
  }));
}

export function createMoment(workspace, input) {
  const target = need(workspace, 'targets', input.targetId);
  if (input.start !== undefined && (!Number.isFinite(input.start) || input.start < 0)) throw new TypeError('start must be a non-negative number');
  if (input.end !== undefined && (!Number.isFinite(input.end) || input.end < (input.start ?? 0))) throw new TypeError('end must be at least start');
  return append(workspace, 'moments', stamp({
    id: input.id ?? id('moment'), projectId: target.projectId, targetId: target.id,
    label: optional(input.label, 'label'), start: input.start, end: input.end, state: copy(input.state ?? {})
  }));
}

export function createSelection(workspace, input) {
  const project = need(workspace, 'projects', input.projectId);
  const target = need(workspace, 'targets', input.targetId);
  if (project.id !== target.projectId) throw new RangeError('selection target must belong to its project');
  if (input.momentId) {
    const moment = need(workspace, 'moments', input.momentId);
    if (moment.targetId !== target.id) throw new RangeError('selection moment must belong to its target');
  }
  return append(workspace, 'selections', stamp({
    id: input.id ?? id('selection'), projectId: project.id, targetId: target.id,
    momentId: input.momentId, aspect: required(input.aspect, 'aspect'), intent: required(input.intent, 'intent')
  }));
}

export function createBoard(workspace, input) {
  need(workspace, 'projects', input.projectId);
  const selectionIds = [...(input.selectionIds ?? [])];
  assertBoardSelections(workspace, input.projectId, selectionIds);
  return append(workspace, 'boards', stamp({ id: input.id ?? id('board'), projectId: input.projectId, title: required(input.title, 'title'), selectionIds }));
}

export function reorderBoard(workspace, boardId, selectionIds) {
  const board = need(workspace, 'boards', boardId);
  if (selectionIds.length !== board.selectionIds.length || new Set(selectionIds).size !== selectionIds.length || board.selectionIds.some(item => !selectionIds.includes(item))) {
    throw new RangeError('reorder must contain every board selection exactly once');
  }
  return update(workspace, 'boards', boardId, { selectionIds: [...selectionIds] });
}

export function removeFromBoard(workspace, boardId, selectionId) {
  const board = need(workspace, 'boards', boardId);
  return update(workspace, 'boards', boardId, { selectionIds: board.selectionIds.filter(item => item !== selectionId) });
}

export function recordSignal(workspace, input) {
  need(workspace, 'projects', input.projectId);
  if (!SIGNAL_EVENTS.has(input.event)) throw new TypeError('signal event is not factual or supported');
  if (!input.subject || typeof input.subject.type !== 'string' || typeof input.subject.id !== 'string') throw new TypeError('signal subject is required');
  if ('inference' in input || 'preference' in input) throw new TypeError('signals cannot contain inferred preferences');
  return append(workspace, 'signals', stamp({
    id: input.id ?? id('signal'), projectId: input.projectId, event: input.event,
    subject: copy(input.subject), occurredAt: input.occurredAt ?? now(), facts: copy(input.facts ?? {})
  }));
}

export function deleteReference(workspace, referenceId) {
  need(workspace, 'references', referenceId);
  const assetIds = new Set(workspace.assets.filter(x => x.referenceId === referenceId).map(x => x.id));
  const targetIds = new Set(workspace.targets.filter(x => x.referenceId === referenceId).map(x => x.id));
  const momentIds = new Set(workspace.moments.filter(x => targetIds.has(x.targetId)).map(x => x.id));
  const selectionIds = new Set(workspace.selections.filter(x => targetIds.has(x.targetId) || momentIds.has(x.momentId)).map(x => x.id));
  return {
    ...copy(workspace), references: workspace.references.filter(x => x.id !== referenceId),
    assets: workspace.assets.filter(x => !assetIds.has(x.id)), targets: workspace.targets.filter(x => !targetIds.has(x.id)),
    moments: workspace.moments.filter(x => !momentIds.has(x.id)), selections: workspace.selections.filter(x => !selectionIds.has(x.id)),
    boards: workspace.boards.map(board => ({ ...board, selectionIds: board.selectionIds.filter(x => !selectionIds.has(x)) })),
    signals: workspace.signals.filter(x => !(x.subject.type === 'reference' && x.subject.id === referenceId))
  };
}

export function deleteProject(workspace, projectId) {
  need(workspace, 'projects', projectId);
  return Object.fromEntries(Object.entries(workspace).map(([key, value]) => [key,
    key === 'projects' ? value.filter(item => item.id !== projectId)
      : COLLECTIONS.includes(key) ? value.filter(item => item.projectId !== projectId) : value
  ]));
}

export function exportCreativeDirection(workspace, boardId) {
  validateWorkspace(workspace);
  const board = need(workspace, 'boards', boardId);
  const project = need(workspace, 'projects', board.projectId);
  const selections = board.selectionIds.map(selectionId => {
    const selection = need(workspace, 'selections', selectionId);
    const target = need(workspace, 'targets', selection.targetId);
    const reference = need(workspace, 'references', target.referenceId);
    return {
      selection: copy(selection), target: copy(target),
      moment: selection.momentId ? copy(need(workspace, 'moments', selection.momentId)) : null,
      reference: copy(reference), asset: target.assetId ? copy(need(workspace, 'assets', target.assetId)) : null
    };
  });
  return { format: 'refloom.creative-direction', version: CREATIVE_DIRECTION_VERSION, exportedAt: now(), project: copy(project), board: copy(board), selections };
}

export function exportBoardMarkdown(workspace, boardId) {
  const data = exportCreativeDirection(workspace, boardId);
  const lines = [`# ${data.board.title}`, '', `Project: ${data.project.title}`, ''];
  if (data.project.brief) lines.push(data.project.brief, '');
  for (const item of data.selections) {
    lines.push(`## ${item.selection.aspect}`, '', `Intent: ${item.selection.intent}`, `Reference: ${item.reference.title ?? item.reference.sourceUrl ?? item.reference.id}`);
    lines.push(`Reference tags: ${item.reference.tags.join(', ')}`);
    if (item.asset) lines.push(`Asset: ${item.asset.locator}`);
    if (item.moment) lines.push(`Moment: ${item.moment.label ?? `${item.moment.start ?? ''}–${item.moment.end ?? ''}`}`);
    lines.push('');
  }
  return lines.join('\n');
}

export function exportWorkspace(workspace) {
  validateWorkspace(workspace);
  return JSON.stringify(copy(workspace), null, 2);
}

export function importWorkspace(input) {
  let parsed;
  try { parsed = typeof input === 'string' ? JSON.parse(input) : copy(input); }
  catch { throw new ValidationError([{ path: '$', message: 'invalid JSON' }]); }
  validateWorkspace(parsed);
  return copy(parsed);
}

export function validateWorkspace(workspace) {
  const issues = [];
  if (!workspace || typeof workspace !== 'object' || Array.isArray(workspace)) throw new ValidationError([{ path: '$', message: 'must be an object' }]);
  if (workspace.version !== WORKSPACE_VERSION) issues.push({ path: 'version', message: `must equal ${WORKSPACE_VERSION}` });
  if (!workspace.settings || typeof workspace.settings !== 'object'
    || Array.isArray(workspace.settings)) {
    issues.push({ path: 'settings', message: 'must be an object' });
  } else {
    if (Object.keys(workspace.settings).some(key => key !== 'automaticWebsiteCapture')) {
      issues.push({ path: 'settings', message: 'contains unsupported fields' });
    }
    if (typeof workspace.settings.automaticWebsiteCapture !== 'boolean') {
      issues.push({ path: 'settings.automaticWebsiteCapture', message: 'must be a boolean' });
    }
  }
  for (const collection of COLLECTIONS) if (!Array.isArray(workspace[collection])) issues.push({ path: collection, message: 'must be an array' });
  if (issues.length) throw new ValidationError(issues);
  const isRecord = value => value !== null && typeof value === 'object' && !Array.isArray(value);
  const stringField = (entity, field, path, { optional: allowMissing = false } = {}) => {
    const value = entity[field];
    if (allowMissing && value === undefined) return;
    if (typeof value !== 'string' || value.trim() === '') issues.push({ path: `${path}.${field}`, message: 'must be a non-empty string' });
  };
  const optionalString = (entity, field, path) => {
    if (entity[field] !== undefined && typeof entity[field] !== 'string') issues.push({ path: `${path}.${field}`, message: 'must be a string when present' });
  };
  for (const collection of COLLECTIONS) {
    const seen = new Set();
    workspace[collection].forEach((entity, index) => {
      const path = `${collection}[${index}]`;
      if (!isRecord(entity)) issues.push({ path, message: 'must be an object' });
      else if (typeof entity.id !== 'string' || entity.id.trim() === '') issues.push({ path: `${path}.id`, message: 'must be a non-empty string' });
      else if (seen.has(entity.id)) issues.push({ path: `${path}.id`, message: 'must be unique within collection' });
      else seen.add(entity.id);
      if (isRecord(entity)) {
        stringField(entity, 'createdAt', path);
        stringField(entity, 'updatedAt', path);
      }
    });
  }
  workspace.projects.forEach((x, i) => {
    if (!isRecord(x)) return;
    stringField(x, 'title', `projects[${i}]`);
    optionalString(x, 'brief', `projects[${i}]`);
  });
  workspace.references.forEach((x, i) => {
    if (!isRecord(x)) return;
    const path = `references[${i}]`;
    stringField(x, 'projectId', path);
    stringField(x, 'capturedAt', path);
    stringField(x, 'captureMethod', path);
    for (const field of ['title', 'sourceUrl', 'creator', 'notes']) optionalString(x, field, path);
    if (!isCanonicalReferenceTags(x.tags)) issues.push({ path: `${path}.tags`, message: 'must be a canonical unique Reference tag array' });
  });
  workspace.assets.forEach((x, i) => {
    if (!isRecord(x)) return;
    const path = `assets[${i}]`;
    stringField(x, 'projectId', path);
    stringField(x, 'referenceId', path);
    stringField(x, 'locator', path);
    stringField(x, 'capturedAt', path);
    if (!ASSET_KINDS.has(x.kind)) issues.push({ path: `${path}.kind`, message: 'must be image, video, or url' });
    optionalString(x, 'mediaType', path);
    if (!isRecord(x.provenance)) issues.push({ path: `${path}.provenance`, message: 'must be an object' });
  });
  workspace.targets.forEach((x, i) => {
    if (!isRecord(x)) return;
    const path = `targets[${i}]`;
    stringField(x, 'projectId', path);
    stringField(x, 'referenceId', path);
    if (!TARGET_KINDS.has(x.kind)) issues.push({ path: `${path}.kind`, message: 'must be a supported target kind' });
    if (x.kind === 'asset' && (typeof x.assetId !== 'string' || x.assetId === '')) issues.push({ path: `${path}.assetId`, message: 'is required for an asset target' });
    if (x.assetId !== undefined && typeof x.assetId !== 'string') issues.push({ path: `${path}.assetId`, message: 'must be a string when present' });
    if (!isRecord(x.detail)) issues.push({ path: `${path}.detail`, message: 'must be an object' });
  });
  workspace.moments.forEach((x, i) => {
    if (!isRecord(x)) return;
    const path = `moments[${i}]`;
    stringField(x, 'projectId', path);
    stringField(x, 'targetId', path);
    optionalString(x, 'label', path);
    if (x.start !== undefined && (!Number.isFinite(x.start) || x.start < 0)) issues.push({ path: `${path}.start`, message: 'must be a non-negative number when present' });
    if (x.end !== undefined && (!Number.isFinite(x.end) || x.end < (x.start ?? 0))) issues.push({ path: `${path}.end`, message: 'must be a number at least as large as start' });
    if (!isRecord(x.state)) issues.push({ path: `${path}.state`, message: 'must be an object' });
  });
  workspace.selections.forEach((x, i) => {
    if (!isRecord(x)) return;
    const path = `selections[${i}]`;
    stringField(x, 'projectId', path);
    stringField(x, 'targetId', path);
    stringField(x, 'aspect', path);
    stringField(x, 'intent', path);
    if (x.momentId !== undefined && typeof x.momentId !== 'string') issues.push({ path: `${path}.momentId`, message: 'must be a string when present' });
  });
  workspace.boards.forEach((x, i) => {
    if (!isRecord(x)) return;
    stringField(x, 'projectId', `boards[${i}]`);
    stringField(x, 'title', `boards[${i}]`);
  });
  const exists = (collection, entityId, path) => {
    const entity = workspace[collection].find(item => isRecord(item) && item.id === entityId);
    if (!entity) issues.push({ path, message: `references missing ${collection} entity` });
    return entity;
  };
  workspace.references.forEach((x, i) => { if (isRecord(x)) exists('projects', x.projectId, `references[${i}].projectId`); });
  workspace.assets.forEach((x, i) => {
    if (!isRecord(x)) return;
    const ref = exists('references', x.referenceId, `assets[${i}].referenceId`);
    if (ref && x.projectId !== ref.projectId) issues.push({ path: `assets[${i}].projectId`, message: 'must match reference project' });
  });
  workspace.targets.forEach((x, i) => {
    if (!isRecord(x)) return;
    const ref = exists('references', x.referenceId, `targets[${i}].referenceId`);
    const asset = x.assetId ? exists('assets', x.assetId, `targets[${i}].assetId`) : undefined;
    if (ref && x.projectId !== ref.projectId) issues.push({ path: `targets[${i}].projectId`, message: 'must match reference project' });
    if (asset && asset.referenceId !== x.referenceId) issues.push({ path: `targets[${i}].assetId`, message: 'must belong to reference' });
  });
  workspace.moments.forEach((x, i) => {
    if (!isRecord(x)) return;
    const target = exists('targets', x.targetId, `moments[${i}].targetId`);
    if (target && x.projectId !== target.projectId) issues.push({ path: `moments[${i}].projectId`, message: 'must match target project' });
  });
  workspace.selections.forEach((x, i) => {
    if (!isRecord(x)) return;
    const project = exists('projects', x.projectId, `selections[${i}].projectId`);
    const target = exists('targets', x.targetId, `selections[${i}].targetId`);
    const moment = x.momentId ? exists('moments', x.momentId, `selections[${i}].momentId`) : undefined;
    if (project && target && project.id !== target.projectId) issues.push({ path: `selections[${i}].targetId`, message: 'must belong to selection project' });
    if (moment && moment.targetId !== x.targetId) issues.push({ path: `selections[${i}].momentId`, message: 'must belong to selection target' });
  });
  workspace.boards.forEach((x, i) => {
    if (!isRecord(x)) return;
    exists('projects', x.projectId, `boards[${i}].projectId`);
    if (!Array.isArray(x.selectionIds)) issues.push({ path: `boards[${i}].selectionIds`, message: 'must be an array' });
    else {
      if (new Set(x.selectionIds).size !== x.selectionIds.length) issues.push({ path: `boards[${i}].selectionIds`, message: 'must not contain duplicates' });
      x.selectionIds.forEach((selectionId, j) => {
        const selection = exists('selections', selectionId, `boards[${i}].selectionIds[${j}]`);
        if (selection && selection.projectId !== x.projectId) issues.push({ path: `boards[${i}].selectionIds[${j}]`, message: 'must belong to board project' });
      });
    }
  });
  workspace.signals.forEach((x, i) => {
    if (!isRecord(x)) return;
    stringField(x, 'projectId', `signals[${i}]`);
    stringField(x, 'occurredAt', `signals[${i}]`);
    exists('projects', x.projectId, `signals[${i}].projectId`);
    if (!SIGNAL_EVENTS.has(x.event)) issues.push({ path: `signals[${i}].event`, message: 'must be a supported factual event' });
    if (!x.subject || typeof x.subject.type !== 'string' || typeof x.subject.id !== 'string') issues.push({ path: `signals[${i}].subject`, message: 'must identify an observed subject' });
    if (!isRecord(x.facts)) issues.push({ path: `signals[${i}].facts`, message: 'must be an object' });
    if ('inference' in x || 'preference' in x) issues.push({ path: `signals[${i}]`, message: 'must not store inferred preferences' });
  });
  if (issues.length) throw new ValidationError(issues);
  return true;
}

function update(workspace, collection, entityId, changes) {
  const clean = Object.fromEntries(Object.entries(changes).filter(([, value]) => value !== undefined));
  return { ...copy(workspace), [collection]: workspace[collection].map(entity => entity.id === entityId ? { ...entity, ...copy(clean), id: entity.id, updatedAt: now() } : entity) };
}

function assertBoardSelections(workspace, projectId, selectionIds) {
  if (new Set(selectionIds).size !== selectionIds.length) throw new RangeError('board selections must be unique');
  for (const selectionId of selectionIds) if (need(workspace, 'selections', selectionId).projectId !== projectId) throw new RangeError('board selections must belong to its project');
}
