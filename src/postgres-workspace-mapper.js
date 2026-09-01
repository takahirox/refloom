import { importWorkspace, ValidationError } from './domain.js';

export const INSERT_ORDER = Object.freeze([
  'projects',
  'references',
  'assets',
  'targets',
  'moments',
  'selections',
  'boards',
  'board_selections',
  'signals'
]);

export const DELETE_ORDER = Object.freeze([...INSERT_ORDER].reverse());

const clone = value => structuredClone(value);
const optional = value => value === null || value === undefined ? undefined : value;
const present = (name, value) => value === null || value === undefined ? {} : { [name]: value };

function timestamp(value, field) {
  const date = value instanceof Date ? value : new Date(value);
  if ((typeof value !== 'string' && !(value instanceof Date)) || Number.isNaN(date.getTime())) {
    throw new TypeError(`${field} must be a valid timestamp`);
  }
  return date.toISOString();
}

const stampsToRow = entity => ({
  created_at: timestamp(entity.createdAt, 'createdAt'),
  updated_at: timestamp(entity.updatedAt, 'updatedAt')
});

const stampsFromRow = row => ({
  createdAt: timestamp(row.created_at, 'created_at'),
  updatedAt: timestamp(row.updated_at, 'updated_at')
});

export function workspaceToRows(workspace) {
  const value = importWorkspace(workspace);
  return {
    projects: value.projects.map(entity => ({
      id: entity.id, title: entity.title, brief: entity.brief ?? null, ...stampsToRow(entity)
    })),
    references: value.references.map(entity => ({
      id: entity.id, project_id: entity.projectId, title: entity.title ?? null,
      source_url: entity.sourceUrl ?? null, creator: entity.creator ?? null,
      notes: entity.notes ?? null, captured_at: timestamp(entity.capturedAt, 'capturedAt'),
      capture_method: entity.captureMethod, ...stampsToRow(entity)
    })),
    assets: value.assets.map(entity => ({
      id: entity.id, project_id: entity.projectId, reference_id: entity.referenceId,
      kind: entity.kind, locator: entity.locator, media_type: entity.mediaType ?? null,
      captured_at: timestamp(entity.capturedAt, 'capturedAt'), provenance: clone(entity.provenance),
      ...stampsToRow(entity)
    })),
    targets: value.targets.map(entity => ({
      id: entity.id, project_id: entity.projectId, reference_id: entity.referenceId,
      asset_id: entity.assetId ?? null, kind: entity.kind, detail: clone(entity.detail),
      ...stampsToRow(entity)
    })),
    moments: value.moments.map(entity => ({
      id: entity.id, project_id: entity.projectId, target_id: entity.targetId,
      label: entity.label ?? null, start_value: entity.start ?? null,
      end_value: entity.end ?? null, state: clone(entity.state), ...stampsToRow(entity)
    })),
    selections: value.selections.map(entity => ({
      id: entity.id, project_id: entity.projectId, target_id: entity.targetId,
      moment_id: entity.momentId ?? null, aspect: entity.aspect, intent: entity.intent,
      ...stampsToRow(entity)
    })),
    boards: value.boards.map(entity => ({
      id: entity.id, project_id: entity.projectId, title: entity.title, ...stampsToRow(entity)
    })),
    board_selections: value.boards.flatMap(board => board.selectionIds.map((selectionId, position) => ({
      board_id: board.id, selection_id: selectionId, position
    }))),
    signals: value.signals.map(entity => ({
      id: entity.id, project_id: entity.projectId, event: entity.event,
      subject_type: entity.subject.type, subject_id: entity.subject.id,
      occurred_at: timestamp(entity.occurredAt, 'occurredAt'), facts: clone(entity.facts),
      ...stampsToRow(entity)
    }))
  };
}

function requireRowSets(rowSets) {
  if (!rowSets || typeof rowSets !== 'object' || Array.isArray(rowSets)) {
    throw new ValidationError([{ path: '$', message: 'rowSets must be an object' }]);
  }
  const issues = INSERT_ORDER.flatMap(table => Array.isArray(rowSets[table])
    ? []
    : [{ path: table, message: 'must be an array' }]);
  if (issues.length) throw new ValidationError(issues);
}

const stableRows = rows => [...rows].sort((left, right) => {
  const leftId = typeof left?.id === 'string' ? left.id : '';
  const rightId = typeof right?.id === 'string' ? right.id : '';
  return leftId.localeCompare(rightId);
});

function boardSelectionMap(rowSets, boardIds) {
  const issues = [];
  const byBoard = new Map(boardIds.map(id => [id, []]));
  const positions = new Set();
  const selections = new Set();
  for (const [index, row] of rowSets.board_selections.entries()) {
    if (!row || typeof row !== 'object' || Array.isArray(row)) {
      issues.push({ path: `board_selections[${index}]`, message: 'must be an object' });
      continue;
    }
    if (!byBoard.has(row.board_id)) {
      issues.push({ path: `board_selections[${index}].board_id`, message: 'references missing board row' });
      continue;
    }
    if (!Number.isInteger(row.position) || row.position < 0) {
      issues.push({ path: `board_selections[${index}].position`, message: 'must be a non-negative integer' });
      continue;
    }
    const positionKey = `${row.board_id}\u0000${row.position}`;
    const selectionKey = `${row.board_id}\u0000${row.selection_id}`;
    if (positions.has(positionKey)) issues.push({ path: `board_selections[${index}].position`, message: 'must be unique within board' });
    if (selections.has(selectionKey)) issues.push({ path: `board_selections[${index}].selection_id`, message: 'must be unique within board' });
    positions.add(positionKey);
    selections.add(selectionKey);
    byBoard.get(row.board_id).push(row);
  }
  for (const [boardId, rows] of byBoard) {
    rows.sort((left, right) => left.position - right.position || String(left.selection_id).localeCompare(String(right.selection_id)));
    rows.forEach((row, index) => {
      if (row.position !== index) issues.push({ path: `board_selections.${boardId}`, message: 'positions must be contiguous from zero' });
    });
  }
  if (issues.length) throw new ValidationError(issues);
  return byBoard;
}

export function rowsToWorkspace(rowSets) {
  requireRowSets(rowSets);
  const boardRows = stableRows(rowSets.boards);
  const boardSelections = boardSelectionMap(rowSets, boardRows.map(row => row?.id));
  const workspace = {
    version: 1,
    projects: stableRows(rowSets.projects).map(row => ({
      id: row.id, title: row.title, ...present('brief', optional(row.brief)), ...stampsFromRow(row)
    })),
    references: stableRows(rowSets.references).map(row => ({
      id: row.id, projectId: row.project_id, ...present('title', optional(row.title)),
      ...present('sourceUrl', optional(row.source_url)), ...present('creator', optional(row.creator)),
      ...present('notes', optional(row.notes)), capturedAt: timestamp(row.captured_at, 'captured_at'),
      captureMethod: row.capture_method, ...stampsFromRow(row)
    })),
    assets: stableRows(rowSets.assets).map(row => ({
      id: row.id, projectId: row.project_id, referenceId: row.reference_id,
      kind: row.kind, locator: row.locator, ...present('mediaType', optional(row.media_type)),
      capturedAt: timestamp(row.captured_at, 'captured_at'), provenance: clone(row.provenance),
      ...stampsFromRow(row)
    })),
    targets: stableRows(rowSets.targets).map(row => ({
      id: row.id, projectId: row.project_id, referenceId: row.reference_id,
      ...present('assetId', optional(row.asset_id)), kind: row.kind, detail: clone(row.detail),
      ...stampsFromRow(row)
    })),
    moments: stableRows(rowSets.moments).map(row => ({
      id: row.id, projectId: row.project_id, targetId: row.target_id,
      ...present('label', optional(row.label)), ...present('start', optional(row.start_value)),
      ...present('end', optional(row.end_value)), state: clone(row.state), ...stampsFromRow(row)
    })),
    selections: stableRows(rowSets.selections).map(row => ({
      id: row.id, projectId: row.project_id, targetId: row.target_id,
      ...present('momentId', optional(row.moment_id)), aspect: row.aspect, intent: row.intent,
      ...stampsFromRow(row)
    })),
    boards: boardRows.map(row => ({
      id: row.id, projectId: row.project_id, title: row.title,
      selectionIds: boardSelections.get(row.id).map(item => item.selection_id), ...stampsFromRow(row)
    })),
    signals: stableRows(rowSets.signals).map(row => ({
      id: row.id, projectId: row.project_id, event: row.event,
      subject: { type: row.subject_type, id: row.subject_id },
      occurredAt: timestamp(row.occurred_at, 'occurred_at'), facts: clone(row.facts),
      ...stampsFromRow(row)
    }))
  };
  return importWorkspace(workspace);
}

const specification = (text, fields) => Object.freeze({
  text,
  values: row => fields.map(field => row[field])
});

export const INSERT_SPECIFICATIONS = Object.freeze({
  projects: specification('insert into projects (id, title, brief, created_at, updated_at) values ($1, $2, $3, $4, $5)', ['id', 'title', 'brief', 'created_at', 'updated_at']),
  references: specification('insert into "references" (id, project_id, title, source_url, creator, notes, captured_at, capture_method, created_at, updated_at) values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)', ['id', 'project_id', 'title', 'source_url', 'creator', 'notes', 'captured_at', 'capture_method', 'created_at', 'updated_at']),
  assets: specification('insert into assets (id, project_id, reference_id, kind, locator, media_type, captured_at, provenance, created_at, updated_at) values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)', ['id', 'project_id', 'reference_id', 'kind', 'locator', 'media_type', 'captured_at', 'provenance', 'created_at', 'updated_at']),
  targets: specification('insert into targets (id, project_id, reference_id, asset_id, kind, detail, created_at, updated_at) values ($1, $2, $3, $4, $5, $6, $7, $8)', ['id', 'project_id', 'reference_id', 'asset_id', 'kind', 'detail', 'created_at', 'updated_at']),
  moments: specification('insert into moments (id, project_id, target_id, label, start_value, end_value, state, created_at, updated_at) values ($1, $2, $3, $4, $5, $6, $7, $8, $9)', ['id', 'project_id', 'target_id', 'label', 'start_value', 'end_value', 'state', 'created_at', 'updated_at']),
  selections: specification('insert into selections (id, project_id, target_id, moment_id, aspect, intent, created_at, updated_at) values ($1, $2, $3, $4, $5, $6, $7, $8)', ['id', 'project_id', 'target_id', 'moment_id', 'aspect', 'intent', 'created_at', 'updated_at']),
  boards: specification('insert into boards (id, project_id, title, created_at, updated_at) values ($1, $2, $3, $4, $5)', ['id', 'project_id', 'title', 'created_at', 'updated_at']),
  board_selections: specification('insert into board_selections (board_id, selection_id, position) values ($1, $2, $3)', ['board_id', 'selection_id', 'position']),
  signals: specification('insert into signals (id, project_id, event, subject_type, subject_id, occurred_at, facts, created_at, updated_at) values ($1, $2, $3, $4, $5, $6, $7, $8, $9)', ['id', 'project_id', 'event', 'subject_type', 'subject_id', 'occurred_at', 'facts', 'created_at', 'updated_at'])
});
