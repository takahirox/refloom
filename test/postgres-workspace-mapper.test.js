import test from 'node:test';
import assert from 'node:assert/strict';
import {
  createAsset,
  createBoard,
  createMoment,
  createProject,
  createReference,
  createSelection,
  createTarget,
  createWorkspace,
  recordSignal,
  updateWorkspaceSettings,
  ValidationError
} from '../src/domain.js';
import {
  DELETE_ORDER,
  INSERT_ORDER,
  INSERT_SPECIFICATIONS,
  rowsToWorkspace,
  workspaceToRows
} from '../src/postgres-workspace-mapper.js';

function completeWorkspace() {
  let workspace = createWorkspace();
  workspace = createProject(workspace, { id: 'project-1', title: 'Direction', brief: 'Brief' });
  workspace = createReference(workspace, {
    id: 'reference-1', projectId: 'project-1', title: 'Reference', sourceUrl: 'https://example.test',
    creator: 'Creator', notes: 'Notes', tags: ['Motion Study', 'pace'],
    capturedAt: '2025-01-01T01:02:03.004Z', captureMethod: 'manual'
  });
  workspace = createAsset(workspace, {
    id: 'asset-1', referenceId: 'reference-1', kind: 'video', locator: 's3://asset',
    mediaType: 'video/mp4', capturedAt: '2025-01-02T01:02:03.004Z', provenance: { nested: { source: 'capture' } }
  });
  workspace = createTarget(workspace, {
    id: 'target-1', referenceId: 'reference-1', assetId: 'asset-1', kind: 'asset', detail: { crop: [1, 2] }
  });
  workspace = createMoment(workspace, {
    id: 'moment-1', targetId: 'target-1', label: 'Opening', start: 1.25, end: 2.5, state: { paused: true }
  });
  workspace = createSelection(workspace, {
    id: 'selection-1', projectId: 'project-1', targetId: 'target-1', momentId: 'moment-1', aspect: 'Motion', intent: 'Reuse pacing'
  });
  workspace = createSelection(workspace, {
    id: 'selection-2', projectId: 'project-1', targetId: 'target-1', aspect: 'Color', intent: 'Reuse palette'
  });
  workspace = createBoard(workspace, {
    id: 'board-1', projectId: 'project-1', title: 'Board', selectionIds: ['selection-2', 'selection-1']
  });
  return recordSignal(workspace, {
    id: 'signal-1', projectId: 'project-1', event: 'capture',
    subject: { type: 'reference', id: 'reference-1' }, occurredAt: '2025-01-03T01:02:03.004Z',
    facts: { nested: { accepted: true } }
  });
}

test('maps every workspace collection and field and round-trips board order', () => {
  const workspace = updateWorkspaceSettings(completeWorkspace(), {
    automaticWebsiteCapture: false
  });
  const rows = workspaceToRows(workspace);

  assert.deepEqual(Object.keys(rows), INSERT_ORDER);
  assert.deepEqual(rows.reference_tags, [
    { reference_id: 'reference-1', position: 0, tag: 'motion-study' },
    { reference_id: 'reference-1', position: 1, tag: 'pace' }
  ]);
  assert.deepEqual(rows.board_selections, [
    { board_id: 'board-1', selection_id: 'selection-2', position: 0 },
    { board_id: 'board-1', selection_id: 'selection-1', position: 1 }
  ]);
  assert.equal(rows.moments[0].start_value, 1.25);
  assert.equal(rows.moments[0].end_value, 2.5);
  assert.deepEqual(rows.signals[0].subject_type, 'reference');
  assert.deepEqual(rows.signals[0].subject_id, 'reference-1');
  assert.deepEqual(rowsToWorkspace(rows, workspace.settings), workspace);
});

test('converts SQL null to omitted optional properties and Date values to canonical ISO strings', () => {
  const rows = workspaceToRows(completeWorkspace());
  rows.projects[0].brief = null;
  rows.references[0].title = null;
  rows.references[0].captured_at = new Date('2025-02-01T01:02:03.004Z');
  rows.targets[0].asset_id = null;
  rows.targets[0].kind = 'reference';
  rows.moments[0].label = null;
  rows.moments[0].start_value = null;
  rows.moments[0].end_value = null;
  rows.selections[0].moment_id = null;

  const workspace = rowsToWorkspace(rows);
  assert.equal(workspace.references[0].capturedAt, '2025-02-01T01:02:03.004Z');
  assert.equal('brief' in workspace.projects[0], false);
  assert.equal('title' in workspace.references[0], false);
  assert.equal('assetId' in workspace.targets[0], false);
  assert.equal('label' in workspace.moments[0], false);
  assert.equal('start' in workspace.moments[0], false);
  assert.equal('end' in workspace.moments[0], false);
  assert.equal('momentId' in workspace.selections[0], false);
});

test('JSONB values are cloned in both mapping directions', () => {
  const workspace = completeWorkspace();
  const rows = workspaceToRows(workspace);
  rows.assets[0].provenance.nested.source = 'changed';
  rows.targets[0].detail.crop[0] = 99;
  rows.moments[0].state.paused = false;
  rows.signals[0].facts.nested.accepted = false;
  assert.equal(workspace.assets[0].provenance.nested.source, 'capture');
  assert.equal(workspace.targets[0].detail.crop[0], 1);
  assert.equal(workspace.moments[0].state.paused, true);
  assert.equal(workspace.signals[0].facts.nested.accepted, true);

  const restored = rowsToWorkspace(workspaceToRows(workspace));
  restored.assets[0].provenance.nested.source = 'restored-change';
  assert.equal(workspace.assets[0].provenance.nested.source, 'capture');
});

test('reconstruction sorts entity rows and ordered relational rows deterministically', () => {
  const rows = workspaceToRows(completeWorkspace());
  rows.selections.reverse();
  rows.reference_tags.reverse();
  rows.board_selections.reverse();
  const workspace = rowsToWorkspace(rows);
  assert.deepEqual(workspace.selections.map(item => item.id), ['selection-1', 'selection-2']);
  assert.deepEqual(workspace.references[0].tags, ['motion-study', 'pace']);
  assert.deepEqual(workspace.boards[0].selectionIds, ['selection-2', 'selection-1']);
});

test('exports FK-safe orders and fixed parameterized insert specifications', () => {
  assert.deepEqual(DELETE_ORDER, [...INSERT_ORDER].reverse());
  assert.deepEqual(Object.keys(INSERT_SPECIFICATIONS), INSERT_ORDER);
  for (const table of INSERT_ORDER) {
    const specification = INSERT_SPECIFICATIONS[table];
    assert.match(specification.text, /^insert into (?:[a-z_]+|"references") \(.+\) values \(\$1/);
    assert.equal(specification.text.includes(';'), false);
    assert.deepEqual(specification.values(workspaceToRows(completeWorkspace())[table][0]).length,
      specification.text.match(/\$\d+/g).length);
  }
  const hostile = { ...workspaceToRows(completeWorkspace()).projects[0], id: "x'); drop table projects; --" };
  assert.equal(INSERT_SPECIFICATIONS.projects.text.includes(hostile.id), false);
  assert.equal(INSERT_SPECIFICATIONS.projects.values(hostile)[0], hostile.id);
});

test('rejects missing, duplicate, malformed, and cross-project result rows', () => {
  const missing = workspaceToRows(completeWorkspace());
  delete missing.targets;
  assert.throws(() => rowsToWorkspace(missing), ValidationError);

  const duplicate = workspaceToRows(completeWorkspace());
  duplicate.projects.push(structuredClone(duplicate.projects[0]));
  assert.throws(() => rowsToWorkspace(duplicate), ValidationError);

  const malformed = workspaceToRows(completeWorkspace());
  malformed.board_selections[1].position = 0;
  assert.throws(() => rowsToWorkspace(malformed), ValidationError);

  const malformedTags = workspaceToRows(completeWorkspace());
  malformedTags.reference_tags[1].position = 0;
  assert.throws(() => rowsToWorkspace(malformedTags), ValidationError);

  const crossProject = workspaceToRows(completeWorkspace());
  crossProject.projects.push({ ...crossProject.projects[0], id: 'project-2' });
  crossProject.targets[0].project_id = 'project-2';
  assert.throws(() => rowsToWorkspace(crossProject), ValidationError);
});
