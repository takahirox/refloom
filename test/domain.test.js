import test from 'node:test';
import assert from 'node:assert/strict';
import {
  ValidationError, createWorkspace, createProject, updateProject, createReference, updateReference,
  createAsset, createTarget, createMoment, createSelection, createBoard, reorderBoard,
  removeFromBoard, recordSignal, deleteReference, deleteProject, exportCreativeDirection,
  exportBoardMarkdown, exportWorkspace, importWorkspace, validateWorkspace,
  updateWorkspaceSettings
} from '../src/domain.js';

function fixture() {
  let workspace = createWorkspace();
  workspace = createProject(workspace, { id: 'p1', title: 'Campaign', brief: 'Quiet confidence' });
  workspace = createReference(workspace, {
    id: 'r1', projectId: 'p1', title: 'Film', sourceUrl: 'https://example.test/film', captureMethod: 'url', tags: [' Editorial ', 'Slow—Motion', 'ＥＤＩＴＯＲＩＡＬ']
  });
  workspace = createAsset(workspace, { id: 'a1', referenceId: 'r1', kind: 'video', locator: 'local://film.mp4', provenance: { sourceUrl: 'https://example.test/film' } });
  workspace = createTarget(workspace, { id: 't1', referenceId: 'r1', assetId: 'a1', kind: 'frame', detail: { x: 10, y: 20 } });
  workspace = createMoment(workspace, { id: 'm1', targetId: 't1', label: 'Reveal', start: 3.5, end: 4.2 });
  workspace = createSelection(workspace, { id: 's1', projectId: 'p1', targetId: 't1', momentId: 'm1', aspect: 'Pacing', intent: 'Use a similarly restrained reveal' });
  workspace = createBoard(workspace, { id: 'b1', projectId: 'p1', title: 'Direction', selectionIds: ['s1'] });
  return workspace;
}

test('create and update operations return new workspaces without mutating input', () => {
  const original = createWorkspace();
  const created = createProject(original, { id: 'p1', title: 'One' });
  const updated = updateProject(created, 'p1', { title: 'Two' });
  assert.equal(original.projects.length, 0);
  assert.equal(created.projects[0].title, 'One');
  assert.equal(updated.projects[0].title, 'Two');
  assert.notEqual(updated, created);
});

test('Reference tags normalize, deduplicate, update immutably, and stay bounded', () => {
  let workspace = createProject(createWorkspace(), { id: 'p1', title: 'One' });
  workspace = createReference(workspace, { id: 'r1', projectId: 'p1' });
  assert.deepEqual(workspace.references[0].tags, []);
  const updated = updateReference(workspace, 'r1', { tags: ['  Art Direction ', 'art—direction', 'ＦＩＬＭ'] });
  assert.deepEqual(updated.references[0].tags, ['art-direction', 'film']);
  assert.deepEqual(workspace.references[0].tags, []);
  assert.throws(() => createReference(workspace, { projectId: 'p1', tags: 'film' }), /array/);
  assert.throws(() => createReference(workspace, { projectId: 'p1', tags: Array(21).fill('film') }), /at most 20/);
  assert.throws(() => createReference(workspace, { projectId: 'p1', tags: ['x'.repeat(65)] }), /at most 64/);
});

test('workspace version 2 requires explicit capture settings', () => {
  const original = createWorkspace();
  assert.equal(original.version, 2);
  assert.deepEqual(original.settings, { automaticWebsiteCapture: true });
  const disabled = updateWorkspaceSettings(original, { automaticWebsiteCapture: false });
  assert.equal(disabled.settings.automaticWebsiteCapture, false);
  assert.equal(original.settings.automaticWebsiteCapture, true);
  assert.throws(() => updateWorkspaceSettings(original, { unknown: true }), /invalid/);

  const invalid = structuredClone(original);
  delete invalid.settings;
  assert.throws(() => importWorkspace(invalid), error => error.issues.some(issue => issue.path === 'settings'));
});

test('selection preserves reference, asset target, moment, aspect, and intent precision', () => {
  const workspace = fixture();
  const selection = workspace.selections[0];
  const target = workspace.targets[0];
  assert.equal(selection.projectId, 'p1');
  assert.equal(selection.targetId, 't1');
  assert.equal(selection.momentId, 'm1');
  assert.equal(selection.aspect, 'Pacing');
  assert.match(selection.intent, /restrained/);
  assert.deepEqual(target.detail, { x: 10, y: 20 });
  assert.equal(target.assetId, 'a1');
  assert.equal(workspace.moments[0].start, 3.5);
});

test('project scope prevents cross-project selections and board entries', () => {
  let workspace = fixture();
  workspace = createProject(workspace, { id: 'p2', title: 'Other' });
  assert.throws(() => createSelection(workspace, { projectId: 'p2', targetId: 't1', aspect: 'Color', intent: 'Borrow contrast' }), /must belong/);
  assert.throws(() => createBoard(workspace, { projectId: 'p2', title: 'Bad', selectionIds: ['s1'] }), /must belong/);
});

test('moment must belong to the selected target', () => {
  let workspace = fixture();
  workspace = createTarget(workspace, { id: 't2', referenceId: 'r1', kind: 'reference' });
  assert.throws(() => createSelection(workspace, { projectId: 'p1', targetId: 't2', momentId: 'm1', aspect: 'Tone', intent: 'Match it' }), /moment must belong/);
});

test('board reorder is exact and removal is immutable', () => {
  let workspace = fixture();
  workspace = createSelection(workspace, { id: 's2', projectId: 'p1', targetId: 't1', aspect: 'Color', intent: 'Use muted blue' });
  workspace = createBoard(workspace, { id: 'b2', projectId: 'p1', title: 'Two', selectionIds: ['s1', 's2'] });
  const reordered = reorderBoard(workspace, 'b2', ['s2', 's1']);
  assert.deepEqual(reordered.boards.find(x => x.id === 'b2').selectionIds, ['s2', 's1']);
  assert.throws(() => reorderBoard(workspace, 'b2', ['s1']), /every board selection/);
  const removed = removeFromBoard(reordered, 'b2', 's2');
  assert.deepEqual(removed.boards.find(x => x.id === 'b2').selectionIds, ['s1']);
  assert.deepEqual(reordered.boards.find(x => x.id === 'b2').selectionIds, ['s2', 's1']);
});

test('reference deletion cascades through owned concepts and board membership', () => {
  const workspace = fixture();
  const deleted = deleteReference(workspace, 'r1');
  for (const name of ['references', 'assets', 'targets', 'moments', 'selections']) assert.equal(deleted[name].length, 0);
  assert.deepEqual(deleted.boards[0].selectionIds, []);
  assert.equal(workspace.references.length, 1);
  assert.equal(validateWorkspace(deleted), true);
});

test('project deletion removes every project-owned entity only', () => {
  let workspace = fixture();
  workspace = createProject(workspace, { id: 'p2', title: 'Keep' });
  const deleted = deleteProject(workspace, 'p1');
  assert.deepEqual(deleted.projects.map(x => x.id), ['p2']);
  for (const name of ['references', 'assets', 'targets', 'moments', 'selections', 'boards', 'signals']) assert.equal(deleted[name].length, 0);
});

test('signals accept observable events and reject preference inferences', () => {
  const workspace = fixture();
  const signaled = recordSignal(workspace, { id: 'sig1', projectId: 'p1', event: 'selection.create', subject: { type: 'selection', id: 's1' }, facts: { aspect: 'Pacing' } });
  assert.equal(signaled.signals[0].event, 'selection.create');
  assert.throws(() => recordSignal(workspace, { projectId: 'p1', event: 'taste.detected', subject: { type: 'project', id: 'p1' } }), /not factual/);
  assert.throws(() => recordSignal(workspace, { projectId: 'p1', event: 'capture', subject: { type: 'reference', id: 'r1' }, preference: 'likes blue' }), /inferred preferences/);
});

test('structured export is versioned, ordered, and contains provenance', () => {
  const output = exportCreativeDirection(fixture(), 'b1');
  assert.equal(output.format, 'refloom.creative-direction');
  assert.equal(output.version, 2);
  assert.equal(output.project.id, 'p1');
  assert.equal(output.board.id, 'b1');
  assert.equal(output.selections[0].selection.id, 's1');
  assert.equal(output.selections[0].reference.sourceUrl, 'https://example.test/film');
  assert.deepEqual(output.selections[0].reference.tags, ['editorial', 'slow-motion']);
  assert.deepEqual(output.selections[0].asset.provenance, { sourceUrl: 'https://example.test/film' });
  assert.equal(output.selections[0].moment.id, 'm1');
});

test('Markdown export is human readable', () => {
  const markdown = exportBoardMarkdown(fixture(), 'b1');
  assert.match(markdown, /^# Direction/m);
  assert.match(markdown, /## Pacing/);
  assert.match(markdown, /Intent: Use a similarly restrained reveal/);
  assert.match(markdown, /Reference tags: editorial, slow-motion/);
  assert.match(markdown, /Moment: Reveal/);
});

test('complete backup round-trips without shared mutable state', () => {
  const workspace = fixture();
  const imported = importWorkspace(exportWorkspace(workspace));
  assert.deepEqual(imported, workspace);
  imported.projects[0].title = 'Changed';
  assert.equal(workspace.projects[0].title, 'Campaign');
});

test('import rejects malformed JSON, unsupported versions, and missing collections', () => {
  assert.throws(() => importWorkspace('{'), error => error instanceof ValidationError && error.issues[0].message === 'invalid JSON');
  const badVersion = createWorkspace();
  badVersion.version = 99;
  assert.throws(() => importWorkspace(badVersion), error => error instanceof ValidationError && error.issues.some(x => x.path === 'version'));
  const missing = createWorkspace();
  delete missing.assets;
  assert.throws(() => importWorkspace(missing), error => error instanceof ValidationError && error.issues.some(x => x.path === 'assets'));
  const missingTags = fixture();
  delete missingTags.references[0].tags;
  assert.throws(() => importWorkspace(missingTags), error => error.issues.some(x => x.path === 'references[0].tags'));
  const nonCanonical = fixture();
  nonCanonical.references[0].tags = ['Editorial'];
  assert.throws(() => importWorkspace(nonCanonical), error => error.issues.some(x => x.path === 'references[0].tags'));
});

test('import rejects malformed entity shapes and missing required fields', () => {
  const malformed = fixture();
  malformed.projects[0].title = '';
  malformed.references[0].captureMethod = 42;
  malformed.assets[0].provenance = [];
  malformed.targets[0].detail = null;
  malformed.moments[0].start = -1;
  malformed.selections[0].intent = undefined;
  malformed.signals.push(null);
  assert.throws(
    () => importWorkspace(malformed),
    error => error instanceof ValidationError
      && error.issues.some(x => x.path === 'projects[0].title')
      && error.issues.some(x => x.path === 'references[0].captureMethod')
      && error.issues.some(x => x.path === 'assets[0].provenance')
      && error.issues.some(x => x.path === 'targets[0].detail')
      && error.issues.some(x => x.path === 'moments[0].start')
      && error.issues.some(x => x.path === 'selections[0].intent')
      && error.issues.some(x => x.path === 'signals[0]')
  );
});

test('import rejects duplicate identifiers and dangling references', () => {
  const duplicate = fixture();
  duplicate.projects.push({ ...duplicate.projects[0] });
  assert.throws(() => importWorkspace(duplicate), error => error.issues.some(x => /unique/.test(x.message)));
  const dangling = fixture();
  dangling.selections[0].targetId = 'missing';
  assert.throws(() => importWorkspace(dangling), error => error.issues.some(x => x.path === 'selections[0].targetId'));
});

test('import rejects cross-reference assets, mismatched moments, and cross-project boards', () => {
  let workspace = fixture();
  workspace = createProject(workspace, { id: 'p2', title: 'Other' });
  const badAsset = structuredClone(workspace);
  badAsset.assets[0].projectId = 'p2';
  assert.throws(() => importWorkspace(badAsset), error => error.issues.some(x => x.path === 'assets[0].projectId'));
  const badMoment = structuredClone(workspace);
  badMoment.moments[0].targetId = 'missing';
  assert.throws(() => importWorkspace(badMoment), ValidationError);
  const badBoard = structuredClone(workspace);
  badBoard.boards[0].projectId = 'p2';
  assert.throws(() => importWorkspace(badBoard), error => error.issues.some(x => /selectionIds/.test(x.path)));
});
