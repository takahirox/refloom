import {
  createAsset, createBoard, createMoment, createProject, createReference, createSelection,
  createTarget, deleteProject, deleteReference, exportBoardMarkdown, exportCreativeDirection,
  recordSignal, removeFromBoard, reorderBoard, updateProject, updateReference
} from './domain.js';
import { BLOB_PREFIX, RevisionConflictError, WorkspaceRepository, blobIdFromLocator, isEmptyWorkspace, readLegacyMigration } from './storage.js';
import { displayReference, formatMoment, formatSignal, safeFilename } from './ui-format.js';

const $ = selector => document.querySelector(selector);
const repository = new WorkspaceRepository();
let workspace;
let projectId = readStoredProject();
let objectUrls = [];
let statusTimer;
let dialogReturnFocus;

function readStoredProject() {
  try { return globalThis.localStorage?.getItem('refloom.project') ?? undefined; }
  catch { return undefined; }
}

function storeProject(value) {
  try {
    if (value) globalThis.localStorage?.setItem('refloom.project', value);
    else globalThis.localStorage?.removeItem('refloom.project');
  } catch {
    // Project selection is a convenience only; the localhost file store is authoritative.
  }
}

function element(tag, options = {}, children = []) {
  const node = document.createElement(tag);
  for (const [name, value] of Object.entries(options)) {
    if (name === 'className') node.className = value;
    else if (name === 'text') node.textContent = value;
    else if (name === 'value') node.value = value;
    else if (name === 'checked') node.checked = value;
    else if (name === 'disabled') node.disabled = value;
    else if (value !== undefined && value !== null) node.setAttribute(name, String(value));
  }
  node.append(...children.filter(Boolean));
  return node;
}

function field(label, name, value = '', options = {}) {
  const id = `field-${name}`;
  const control = options.type === 'textarea'
    ? element('textarea', { id, name, placeholder: options.placeholder, required: options.required }, [])
    : element('input', { id, name, type: options.type || 'text', placeholder: options.placeholder, required: options.required, min: options.min, step: options.step }, []);
  control.value = value ?? '';
  return element('div', { className: 'field' }, [element('label', { for: id, text: label }), control]);
}

function activeProject() { return workspace.projects.find(project => project.id === projectId); }
function projectItems(collection) { return workspace[collection].filter(item => item.projectId === projectId); }
function find(collection, id) { return workspace[collection].find(item => item.id === id); }

function announce(message, error = false) {
  const status = $('#status');
  status.textContent = message;
  status.style.background = error ? '#7b1717' : '';
  status.classList.add('visible');
  clearTimeout(statusTimer);
  statusTimer = setTimeout(() => status.classList.remove('visible'), 4500);
}

async function commit(next, additions = [], message = '') {
  try { await repository.mutate(next, additions); }
  catch (error) {
    if (error instanceof RevisionConflictError) {
      workspace = await repository.load();
      await render();
    }
    throw error;
  }
  workspace = next;
  await render();
  if (message) announce(message);
}

async function captureWebsite(referenceId, settings, control) {
  control.disabled = true;
  try {
    const result = await repository.captureWebsite(referenceId, settings);
    workspace = await repository.load();
    await render();
    announce(result.status === 'complete' ? 'Website capture complete' : 'Website capture partially completed', result.status === 'partial');
  } catch {
    workspace = await repository.load();
    await render();
    announce('Website capture failed; the saved URL is still available', true);
  } finally { if (control.isConnected) control.disabled = false; }
}

function signal(next, event, subject, facts = {}) {
  return recordSignal(next, { projectId, event, subject, facts });
}

function openEditor(title, fields, onSave) {
  dialogReturnFocus = document.activeElement;
  $('#dialog-title').textContent = title;
  $('#editor-fields').replaceChildren(...fields);
  const dialog = $('#editor-dialog');
  dialog.showModal();
  dialog.querySelector('input,textarea,select')?.focus();
  dialog.onclose = async () => {
    if (dialog.returnValue === 'default') {
      try { await onSave(new FormData($('#editor-form'))); } catch (error) { announce(error.message, true); }
    }
    dialogReturnFocus?.focus();
  };
}

function confirmAction(message) {
  return new Promise(resolve => {
    dialogReturnFocus = document.activeElement;
    $('#confirm-message').textContent = message;
    const dialog = $('#confirm-dialog');
    dialog.showModal();
    dialog.querySelector('[value="cancel"]').focus();
    dialog.onclose = () => { resolve(dialog.returnValue === 'confirm'); dialogReturnFocus?.focus(); };
  });
}

function projectEditor(project) {
  openEditor(project ? 'Edit project' : 'New project', [
    field('Project title', 'title', project?.title, { required: true }),
    field('Brief (optional)', 'brief', project?.brief, { type: 'textarea' })
  ], async data => {
    let next;
    if (project) next = updateProject(workspace, project.id, { title: data.get('title'), brief: data.get('brief') });
    else {
      next = createProject(workspace, { title: data.get('title'), brief: data.get('brief') });
      projectId = next.projects.at(-1).id;
      next = createBoard(next, { projectId, title: 'Creative direction' });
    }
    storeProject(projectId);
    await commit(next, [], project ? 'Project updated' : 'Project created');
  });
}

async function captureFiles(files, referenceId) {
  const accepted = [...files].filter(file => file.type.startsWith('image/') || file.type.startsWith('video/'));
  if (!accepted.length) throw new TypeError('Choose image or video files');
  let next = workspace;
  const additions = [];
  for (const file of accepted) {
    let refId = referenceId;
    if (!refId) {
      next = createReference(next, { projectId, captureMethod: 'file' });
      refId = next.references.at(-1).id;
    }
    const binaryId = crypto.randomUUID();
    next = createAsset(next, { referenceId: refId, kind: file.type.startsWith('video/') ? 'video' : 'image', locator: `${BLOB_PREFIX}${binaryId}`, mediaType: file.type, provenance: { filename: file.name, captureMethod: 'local-file' } });
    additions.push({ id: binaryId, blob: file, name: file.name });
    if (!referenceId) next = signal(next, 'capture', { type: 'reference', id: refId }, { method: 'file', mediaType: file.type });
  }
  await commit(next, additions, `${accepted.length} file${accepted.length === 1 ? '' : 's'} captured`);
}

function referenceEditor(reference) {
  openEditor('Reference details', [
    field('Title', 'title', reference.title), field('Source URL', 'sourceUrl', reference.sourceUrl, { type: 'url' }),
    field('Creator', 'creator', reference.creator), field('Notes', 'notes', reference.notes, { type: 'textarea' })
  ], async data => {
    let next = updateReference(workspace, reference.id, Object.fromEntries(data));
    next = signal(next, 'enrich', { type: 'reference', id: reference.id }, { fields: ['title', 'sourceUrl', 'creator', 'notes'].filter(name => data.get(name)) });
    await commit(next, [], 'Reference updated');
  });
}

function selectionEditor(reference) {
  const assets = workspace.assets.filter(asset => asset.referenceId === reference.id);
  const select = element('select', { id: 'field-asset', name: 'asset' }, [element('option', { value: '', text: 'Whole reference' })]);
  for (const asset of assets) select.append(element('option', { value: asset.id, text: `${asset.kind}: ${asset.provenance?.filename || asset.locator}` }));
  openEditor('Add selection to board', [
    element('div', { className: 'field' }, [element('label', { for: 'field-asset', text: 'Target' }), select]),
    field('Aspect', 'aspect', '', { required: true, placeholder: 'e.g. color, motion, typography' }),
    field('Intent', 'intent', '', { type: 'textarea', required: true, placeholder: 'What should this evidence guide?' }),
    field('Moment start in seconds (optional)', 'start', '', { type: 'number', min: '0', step: '0.01' }),
    field('Moment end in seconds (optional)', 'end', '', { type: 'number', min: '0', step: '0.01' }),
    field('Moment label (optional)', 'momentLabel')
  ], async data => {
    const assetId = data.get('asset') || undefined;
    let next = createTarget(workspace, { referenceId: reference.id, assetId, kind: assetId ? 'asset' : 'reference' });
    const target = next.targets.at(-1);
    let momentId;
    if (data.get('start') || data.get('end') || data.get('momentLabel')) {
      next = createMoment(next, { targetId: target.id, start: data.get('start') === '' ? undefined : Number(data.get('start')), end: data.get('end') === '' ? undefined : Number(data.get('end')), label: data.get('momentLabel') });
      momentId = next.moments.at(-1).id;
    }
    next = createSelection(next, { projectId, targetId: target.id, momentId, aspect: data.get('aspect'), intent: data.get('intent') });
    const selection = next.selections.at(-1);
    let board = next.boards.find(item => item.projectId === projectId);
    if (!board) { next = createBoard(next, { projectId, title: 'Creative direction' }); board = next.boards.at(-1); }
    next = reorderBoard({ ...next, boards: next.boards.map(item => item.id === board.id ? { ...item, selectionIds: [...item.selectionIds, selection.id] } : item) }, board.id, [...board.selectionIds, selection.id]);
    next = signal(next, 'selection.create', { type: 'selection', id: selection.id }, { aspect: selection.aspect });
    next = signal(next, 'board.change', { type: 'board', id: board.id }, { action: 'add', selectionId: selection.id });
    await commit(next, [], 'Selection added to board');
  });
}

async function mediaPreview(asset) {
  if (!asset) return element('div', { className: 'placeholder', text: 'URL reference' });
  const binaryId = blobIdFromLocator(asset.locator);
  if (!binaryId) return element('div', { className: 'placeholder', text: asset.kind.toUpperCase() });
  try {
    const blob = await repository.blob(binaryId);
    const url = URL.createObjectURL(blob);
    objectUrls.push(url);
    if (asset.kind === 'video') return element('video', { className: 'preview video', src: url, controls: '', preload: 'metadata', 'aria-label': 'Captured video preview' });
    return element('img', { className: 'preview', src: url, alt: '' });
  } catch { return element('div', { className: 'placeholder', text: 'Binary unavailable' }); }
}

async function renderLibrary() {
  const query = $('#library-search').value.trim().toLowerCase();
  const references = projectItems('references').filter(reference => [reference.title, reference.sourceUrl, reference.creator, reference.notes].filter(Boolean).join(' ').toLowerCase().includes(query));
  const cards = [];
  for (const reference of references) {
    const assets = workspace.assets.filter(asset => asset.referenceId === reference.id);
    const previewAsset = assets.find(asset => blobIdFromLocator(asset.locator)) ?? assets[0];
    const edit = element('button', { type: 'button', text: 'Edit details' });
    edit.addEventListener('click', () => referenceEditor(reference));
    const add = element('button', { type: 'button', text: 'Add assets' });
    add.addEventListener('click', () => { $('#file-input').dataset.referenceId = reference.id; $('#file-input').click(); });
    const websiteCapture = reference.sourceUrl ? element('button', { type: 'button', text: assets.some(asset => asset.provenance?.captureStrategy) ? 'Recapture website' : 'Capture website' }) : null;
    websiteCapture?.addEventListener('click', () => captureWebsite(reference.id, {
      width: 1440, height: 900, checkpoints: 3, readinessMs: 1000, settleMs: 500, maxRedirects: 10
    }, websiteCapture));
    const select = element('button', { type: 'button', className: 'primary', text: 'Select for board' });
    select.addEventListener('click', () => selectionEditor(reference));
    const remove = element('button', { type: 'button', className: 'danger', text: 'Delete' });
    remove.addEventListener('click', async () => {
      if (!await confirmAction(`Delete “${displayReference(reference)}” and all its assets and selections?`)) return;
      await commit(deleteReference(workspace, reference.id), [], 'Reference deleted');
    });
    const card = element('article', { className: 'reference-card' }, [
      await mediaPreview(previewAsset), element('h2', { text: displayReference(reference) }),
      element('p', { className: 'meta', text: [reference.creator, `${assets.length} asset${assets.length === 1 ? '' : 's'}`, new Date(reference.capturedAt).toLocaleString()].filter(Boolean).join(' · ') }),
      reference.notes ? element('p', { text: reference.notes }) : null,
      element('div', { className: 'actions' }, [edit, add, websiteCapture, select, remove])
    ]);
    cards.push(card);
  }
  $('#reference-list').replaceChildren(...(cards.length ? cards : [element('p', { className: 'empty', text: query ? 'No references match this filter.' : 'No references yet. Save a URL, choose a file, drop one here, or paste an image.' })]));
}

function renderBoard() {
  const board = workspace.boards.find(item => item.projectId === projectId);
  const aspects = [...new Set(projectItems('selections').map(item => item.aspect))].sort();
  const currentFilter = $('#aspect-filter').value;
  $('#aspect-filter').replaceChildren(element('option', { value: '', text: 'All aspects' }), ...aspects.map(aspect => element('option', { value: aspect, text: aspect })));
  $('#aspect-filter').value = aspects.includes(currentFilter) ? currentFilter : '';
  if (!board?.selectionIds.length) { $('#board-list').replaceChildren(element('li', { className: 'empty', text: 'The board is empty. Select evidence from the library to begin.' })); return; }
  const nodes = board.selectionIds.map((id, index) => {
    const selection = find('selections', id);
    if ($('#aspect-filter').value && selection.aspect !== $('#aspect-filter').value) return null;
    const target = find('targets', selection.targetId);
    const reference = find('references', target.referenceId);
    const asset = target.assetId ? find('assets', target.assetId) : null;
    const moment = selection.momentId ? find('moments', selection.momentId) : null;
    const up = element('button', { type: 'button', 'aria-label': `Move ${selection.aspect} up`, text: '↑', disabled: index === 0 });
    const down = element('button', { type: 'button', 'aria-label': `Move ${selection.aspect} down`, text: '↓', disabled: index === board.selectionIds.length - 1 });
    const move = async offset => {
      const ids = [...board.selectionIds]; [ids[index], ids[index + offset]] = [ids[index + offset], ids[index]];
      let next = reorderBoard(workspace, board.id, ids); next = signal(next, 'board.change', { type: 'board', id: board.id }, { action: 'reorder' });
      await commit(next, [], 'Board reordered');
    };
    up.addEventListener('click', () => move(-1)); down.addEventListener('click', () => move(1));
    const remove = element('button', { type: 'button', className: 'danger', text: 'Remove' });
    remove.addEventListener('click', async () => { let next = removeFromBoard(workspace, board.id, id); next = signal(next, 'board.change', { type: 'board', id: board.id }, { action: 'remove', selectionId: id }); await commit(next, [], 'Removed from board'); });
    return element('li', { className: 'board-item' }, [element('div', { className: 'order-controls' }, [up, down]), element('div', {}, [element('p', { className: 'eyebrow', text: selection.aspect }), element('h2', { text: selection.intent }), moment ? element('p', { text: `Moment: ${formatMoment(moment)}` }) : null, element('p', { className: 'provenance', text: `From ${displayReference(reference)}${reference.creator ? ` by ${reference.creator}` : ''}${asset ? ` · ${asset.provenance?.filename || asset.kind}` : ' · whole reference'}` })]), element('div', { className: 'actions' }, [remove])]);
  }).filter(Boolean);
  $('#board-list').replaceChildren(...(nodes.length ? nodes : [element('li', { className: 'empty', text: 'No selections match this aspect.' })]));
}

function renderActivity() {
  const signals = projectItems('signals').sort((a, b) => b.occurredAt.localeCompare(a.occurredAt));
  $('#activity-list').replaceChildren(...(signals.length ? signals.map(item => element('li', {}, [element('strong', { text: formatSignal(item) }), element('br'), element('time', { datetime: item.occurredAt, text: new Date(item.occurredAt).toLocaleString() })])) : [element('li', { className: 'empty', text: 'Activity appears here as you capture, enrich, select, arrange, and export.' })]));
}

async function render() {
  for (const url of objectUrls) URL.revokeObjectURL(url); objectUrls = [];
  if (projectId && !find('projects', projectId)) projectId = workspace.projects[0]?.id;
  const project = activeProject();
  $('#project-select').replaceChildren(...workspace.projects.map(item => element('option', { value: item.id, text: item.title })));
  if (project) $('#project-select').value = project.id;
  $('#project-select').disabled = !project;
  $('#edit-project').disabled = !project;
  $('#project-brief').textContent = project?.brief || '';
  $('#welcome').hidden = Boolean(project);
  const route = location.hash.slice(1) || 'library';
  for (const view of document.querySelectorAll('.view')) view.hidden = !project || view.id !== route;
  for (const link of document.querySelectorAll('nav a')) link.setAttribute('aria-current', link.hash === `#${route}` ? 'page' : 'false');
  if (!project) return;
  storeProject(projectId);
  if (route === 'library') await renderLibrary();
  if (route === 'board') renderBoard();
  if (route === 'activity') renderActivity();
}

function download(name, contents, type) {
  const url = URL.createObjectURL(new Blob([contents], { type }));
  const link = element('a', { href: url, download: name });
  document.body.append(link); link.click(); link.remove(); URL.revokeObjectURL(url);
}

async function exportBoard(kind) {
  const board = workspace.boards.find(item => item.projectId === projectId);
  if (!board) return announce('Create a board selection before exporting', true);
  const project = activeProject();
  const contents = kind === 'json' ? JSON.stringify(exportCreativeDirection(workspace, board.id), null, 2) : exportBoardMarkdown(workspace, board.id);
  download(safeFilename(`${project.title}-creative-direction`, kind === 'json' ? 'json' : 'md'), contents, kind === 'json' ? 'application/json' : 'text/markdown');
  await commit(signal(workspace, 'export', { type: 'board', id: board.id }, { format: kind }), [], `${kind.toUpperCase()} downloaded`);
}

function bindEvents() {
  $('#nav-toggle').addEventListener('click', event => { const open = $('#primary-nav').classList.toggle('open'); event.currentTarget.setAttribute('aria-expanded', String(open)); });
  window.addEventListener('hashchange', render);
  $('#new-project').addEventListener('click', () => projectEditor()); $('#welcome-create').addEventListener('click', () => projectEditor()); $('#edit-project').addEventListener('click', () => projectEditor(activeProject()));
  $('#project-select').addEventListener('change', event => { projectId = event.target.value; location.hash = 'library'; render(); });
  $('#url-form').addEventListener('submit', async event => {
    event.preventDefault();
    const form = event.currentTarget;
    const data = new FormData(form);
    const url = data.get('url');
    let next = createReference(workspace, { projectId, sourceUrl: url, captureMethod: 'url' });
    const reference = next.references.at(-1);
    next = createAsset(next, { referenceId: reference.id, kind: 'url', locator: url, provenance: { captureMethod: 'manual-url' } });
    next = signal(next, 'capture', { type: 'reference', id: reference.id }, { method: 'url' });
    const optedIn = data.get('captureWebsite') === 'on';
    const settings = Object.fromEntries(['width', 'height', 'checkpoints', 'readinessMs', 'settleMs'].map(key => [key, Number(data.get(key))]));
    const submit = form.querySelector('[type="submit"]');
    try {
      await commit(next, [], 'URL captured');
      form.reset();
      $('#capture-settings').hidden = true;
    } catch (error) { announce(error.message, true); return; }
    if (optedIn) await captureWebsite(reference.id, { ...settings, maxRedirects: 10 }, submit);
  });
  $('#capture-website').addEventListener('change', event => { $('#capture-settings').hidden = !event.currentTarget.checked; });
  $('#choose-files').addEventListener('click', () => { delete $('#file-input').dataset.referenceId; $('#file-input').click(); });
  $('#file-input').addEventListener('change', async event => { try { await captureFiles(event.target.files, event.target.dataset.referenceId); } catch (error) { announce(error.message, true); } event.target.value = ''; delete event.target.dataset.referenceId; });
  const drop = $('#drop-zone');
  for (const name of ['dragenter', 'dragover']) drop.addEventListener(name, event => { event.preventDefault(); drop.classList.add('dragging'); });
  for (const name of ['dragleave', 'drop']) drop.addEventListener(name, event => { event.preventDefault(); drop.classList.remove('dragging'); });
  drop.addEventListener('drop', event => captureFiles(event.dataTransfer.files).catch(error => announce(error.message, true)));
  drop.addEventListener('keydown', event => { if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); $('#choose-files').click(); } });
  document.addEventListener('paste', event => { if (!activeProject() || event.target.matches('input,textarea')) return; const files = [...event.clipboardData.files]; if (files.length) { event.preventDefault(); captureFiles(files).catch(error => announce(error.message, true)); } });
  $('#library-search').addEventListener('input', renderLibrary); $('#aspect-filter').addEventListener('change', renderBoard);
  $('#export-json').addEventListener('click', () => exportBoard('json')); $('#export-markdown').addEventListener('click', () => exportBoard('markdown'));
  $('#backup').addEventListener('click', async () => { try { download('refloom-workspace-backup.json', await repository.exportBackup(workspace), 'application/json'); announce('Workspace backup downloaded'); } catch (error) { announce(error.message, true); } });
  $('#restore-file').addEventListener('change', async event => { try { if (!await confirmAction('Replace the current workspace with this backup?')) return; workspace = await repository.importBackup(await event.target.files[0].text()); projectId = workspace.projects[0]?.id; location.hash = 'library'; await render(); announce('Workspace restored'); } catch (error) { announce(`Import failed: ${error.message}`, true); } finally { event.target.value = ''; } });
  $('#delete-project').addEventListener('click', async () => { const project = activeProject(); if (!project || !await confirmAction(`Delete project “${project.title}” and all of its local data?`)) return; const next = deleteProject(workspace, project.id); projectId = next.projects[0]?.id; await commit(next, [], 'Project deleted'); });
  $('#reset').addEventListener('click', async () => { if (!await confirmAction('Permanently reset every project, reference, binary, board, and activity record on this device?')) return; workspace = await repository.reset(); projectId = undefined; storeProject(); location.hash = 'library'; await render(); announce('All local Refloom data was reset'); });
}

async function start() {
  bindEvents();
  try {
    await repository.open();
    workspace = await repository.load();
    if (isEmptyWorkspace(workspace)) {
      const legacy = await readLegacyMigration();
      if (legacy && await confirmAction('Refloom found workspace data from the previous browser-only version. Copy it into the local companion now? The legacy copy will be kept for recovery.')) {
        await repository.mutate(legacy.workspace, legacy.binaries);
        workspace = legacy.workspace;
        announce('Legacy workspace copied; the original browser copy was preserved');
      }
    }
    await render();
  }
  catch (error) { $('#fatal').hidden = false; $('#fatal').textContent = error.message; for (const control of document.querySelectorAll('button,input,select,textarea')) control.disabled = true; }
}

window.addEventListener('beforeunload', () => { for (const url of objectUrls) URL.revokeObjectURL(url); repository.close(); });
start();
