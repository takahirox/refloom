import {
  createAsset, createBoard, createMoment, createProject, createReference, createSelection,
  createTarget, deleteProject, deleteReference, exportBoardMarkdown, exportCreativeDirection,
  recordSignal, removeFromBoard, reorderBoard, updateProject, updateReference,
  updateWorkspaceSettings
} from './domain.js';
import { BLOB_PREFIX, RevisionConflictError, WorkspaceRepository, blobIdFromLocator } from './storage.js';
import {
  displayReference, formatMoment, formatSignal, safeExternalWebsiteUrl, safeFilename
} from './ui-format.js';
import {
  addReferenceTags, filterLibraryReferences, listReferenceTags, listReferenceTagSuggestions
} from './reference-library.js';
import { createMediaPreviewController, orderPreviewAssets } from './media-preview.js';

const $ = selector => document.querySelector(selector);
const repository = new WorkspaceRepository();
let workspace;
let projectId = readStoredProject();
let objectUrls = [];
let statusTimer;
let dialogReturnFocus;
let urlTagEditor;
const previewControllers = new Set();
const previewControls = new Map();
let previewObserver;
let activePreviewController;
let previewCards = new WeakMap();
const captureStates = new Map();
const captureLabels = {
  queued: 'Queued', capturing: 'Capturing', complete: 'Complete', partial: 'Partially complete',
  failed: 'Failed', cancelled: 'Cancelled', skipped: 'Skipped', idle: 'Not started'
};
const MAX_CARD_TAGS = 3;

function readStoredProject() {
  try { return globalThis.localStorage?.getItem('refloom.project') ?? undefined; }
  catch { return undefined; }
}

function storeProject(value) {
  try {
    if (value) globalThis.localStorage?.setItem('refloom.project', value);
    else globalThis.localStorage?.removeItem('refloom.project');
  } catch {
    // Project selection is a convenience only; shared workspace storage is authoritative.
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

function tagEditor(initialTags = [], key = 'reference') {
  let tags = [...initialTags];
  let suggestions = [];
  const inputId = `field-tags-${key}`;
  const helpId = `${inputId}-help`;
  const statusId = `${inputId}-status`;
  const suggestionId = `${inputId}-suggestions`;
  const chips = element('div', { className: 'tag-chip-list', role: 'list', 'aria-label': 'Selected tags' });
  const input = element('input', {
    id: inputId, type: 'text', list: suggestionId, placeholder: 'Type a tag',
    autocomplete: 'off', 'aria-describedby': `${helpId} ${statusId}`
  });
  const datalist = element('datalist', { id: suggestionId });
  const status = element('span', { id: statusId, className: 'sr-only', 'aria-live': 'polite' });

  const renderTags = () => {
    chips.replaceChildren(...tags.map(tag => {
      const remove = element('button', {
        type: 'button', className: 'tag-chip tag-remove', text: `${tag} ×`,
        'aria-label': `Remove tag ${tag}`
      });
      remove.addEventListener('click', () => {
        tags = tags.filter(value => value !== tag);
        status.textContent = `${tag} removed.`;
        renderTags();
        input.focus();
      });
      return element('span', { role: 'listitem' }, [remove]);
    }));
    datalist.replaceChildren(...suggestions.filter(tag => !tags.includes(tag))
      .map(tag => element('option', { value: tag })));
  };
  const consume = value => {
    const next = addReferenceTags(tags, value);
    const added = next.filter(tag => !tags.includes(tag));
    tags = next;
    input.value = '';
    input.setCustomValidity('');
    if (added.length) status.textContent = `${added.join(', ')} added.`;
    renderTags();
  };
  const consumeOrReport = () => {
    try { consume(input.value); }
    catch (error) { input.setCustomValidity(error.message); input.reportValidity(); }
  };
  input.addEventListener('keydown', event => {
    if (event.isComposing || !['Enter', ','].includes(event.key)) return;
    event.preventDefault();
    consumeOrReport();
  });
  input.addEventListener('input', () => {
    input.setCustomValidity('');
    if (input.value.includes(',')) consumeOrReport();
  });
  input.addEventListener('change', consumeOrReport);
  renderTags();

  return {
    node: element('div', { className: 'field tag-field' }, [
      element('label', { for: inputId, text: 'Tags (optional)' }), chips, input, datalist,
      element('p', { id: helpId, className: 'hint', text: 'Press Enter or comma to add a tag. Choose existing tags for consistent organization.' }), status
    ]),
    values() { if (input.value.trim()) consume(input.value); return [...tags]; },
    clear() { tags = []; input.value = ''; input.setCustomValidity(''); renderTags(); },
    setSuggestions(values) { suggestions = [...values]; renderTags(); }
  };
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

async function commit(next, additions = [], message = '', options = {}) {
  let result;
  try { result = await repository.mutate(next, additions, options); }
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
  return result;
}

const delay = ms => new Promise(resolve => setTimeout(resolve, ms));

function applyCaptureDefault() {
  const enabled = workspace.settings.automaticWebsiteCapture;
  $('#capture-website').checked = enabled;
  $('#automatic-website-capture').checked = enabled;
}

async function monitorCapture(referenceId, running) {
  let last = captureStates.get(referenceId)?.status;
  while (running.value) {
    try {
      const state = await repository.captureStatus(referenceId);
      if (state.status !== last) {
        last = state.status;
        captureStates.set(referenceId, state);
        await render();
      }
      if (!['queued', 'capturing'].includes(state.status)) return;
    } catch { return; }
    await delay(250);
  }
}

async function captureWebsite(referenceId, settings, control) {
  if (control) control.disabled = true;
  const running = { value: true };
  captureStates.set(referenceId, { referenceId, status: 'queued' });
  await render();
  const request = repository.captureWebsite(referenceId, settings);
  const monitoring = monitorCapture(referenceId, running);
  try {
    const result = await request;
    captureStates.set(referenceId, { referenceId, ...result });
    workspace = await repository.load();
    await render();
    const messages = {
      complete: 'Website capture complete',
      partial: 'Website capture partially completed',
      cancelled: 'Website capture cancelled',
      failed: `Website capture failed (${result.code || 'CAPTURE_FAILED'}); the saved URL is still available`,
      busy: 'Website capture is already running'
    };
    announce(messages[result.status] || 'Website capture did not start',
      !['complete', 'cancelled'].includes(result.status));
  } catch {
    captureStates.set(referenceId, { referenceId, status: 'failed', code: 'CAPTURE_FAILED' });
    workspace = await repository.load();
    await render();
    announce('Website capture failed (CAPTURE_FAILED); the saved URL is still available', true);
  } finally {
    running.value = false;
    await monitoring;
    if (control?.isConnected) control.disabled = false;
  }
}

async function waitForScheduledCapture(referenceId, initial, control) {
  if (control) control.disabled = true;
  let state = initial;
  captureStates.set(referenceId, state);
  await render();
  try {
    for (let attempt = 0; attempt < 400
      && ['queued', 'capturing'].includes(state.status); attempt += 1) {
      await delay(250);
      const previous = state.status;
      state = await repository.captureStatus(referenceId);
      captureStates.set(referenceId, state);
      if (state.status !== previous) await render();
    }
    workspace = await repository.load();
    await render();
    const message = state.status === 'complete' ? 'Website capture complete'
      : state.status === 'partial' ? 'Website capture partially completed'
        : state.status === 'cancelled' ? 'Website capture cancelled'
          : `Website capture failed (${state.code || 'CAPTURE_FAILED'}); the saved URL is still available`;
    announce(message, !['complete', 'cancelled'].includes(state.status));
  } catch {
    captureStates.set(referenceId, {
      referenceId, status: 'failed', code: 'CAPTURE_FAILED'
    });
    announce('Website capture failed (CAPTURE_FAILED); the saved URL is still available', true);
  } finally { if (control?.isConnected) control.disabled = false; }
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

function websiteCaptureEditor(reference, control) {
  const preset = element('select', { id: 'field-capture-preset', name: 'preset' }, [
    element('option', { value: 'desktop', text: 'Desktop · 1440 × 900' }),
    element('option', { value: 'tablet', text: 'Tablet · 1024 × 768' }),
    element('option', { value: 'mobile', text: 'Mobile · 390 × 844' })
  ]);
  const mode = element('select', { id: 'field-capture-mode', name: 'mode' }, [
    element('option', { value: 'interactive-auto', text: 'Interactive Auto · Passive WebGL' }),
    element('option', { value: 'viewport', text: 'Initial viewport' }),
    element('option', { value: 'full-page', text: 'Full page' }),
    element('option', { value: 'section', text: 'First main section' }),
    element('option', { value: 'hero', text: 'Hero' })
  ]);
  const interactionMode = element('select', { id: 'field-interaction-mode', name: 'interactionMode' }, [
    element('option', { value: 'passive', text: 'Passive · observe only' }),
    element('option', { value: 'guided', text: 'Guided · exact safe buttons' })
  ]);
  openEditor('Capture website', [
    element('div', { className: 'field' }, [element('label', { for: 'field-capture-preset', text: 'Responsive preset' }), preset]),
    element('div', { className: 'field' }, [element('label', { for: 'field-capture-mode', text: 'Capture mode' }), mode]),
    element('div', { className: 'field' }, [element('label', { for: 'field-interaction-mode', text: 'Interactive Auto behavior' }), interactionMode]),
    field('Exact guided button labels (comma-separated)', 'guidedLabels', '', { placeholder: 'English, Start' }),
    element('p', { className: 'hint', text: 'Passive only observes. Guided may click at most three exact semantic buttons for safe language/start gates within five seconds; forms, accounts, wallets, purchases, uploads, permissions, downloads, and cross-origin changes remain blocked.' })
  ], data => captureWebsite(reference.id, {
    preset: data.get('preset'), mode: data.get('mode'), readinessMs: 1000,
    settleMs: 500, maxRedirects: 10,
    ...(data.get('mode') === 'interactive-auto' ? {
      interactionMode: data.get('interactionMode'), observationMs: 10_000,
      sampleIntervalMs: 500, representativeMoments: 4,
      stabilitySamples: 3, stabilityThreshold: 0.015,
      ...(data.get('interactionMode') === 'guided' ? {
        guidedActions: String(data.get('guidedLabels') || '').split(',')
          .map(label => label.trim()).filter(Boolean).slice(0, 3)
          .map(label => ({ type: 'click', role: 'button', label }))
      } : {})
    } : {})
  }, control));
}

function referenceEditor(reference) {
  const tags = tagEditor(reference.tags, reference.id);
  tags.setSuggestions(listReferenceTagSuggestions(projectItems('references')).map(({ tag }) => tag));
  openEditor('Reference details', [
    field('Title', 'title', reference.title), field('Source URL', 'sourceUrl', reference.sourceUrl, { type: 'url' }),
    field('Creator', 'creator', reference.creator), field('Notes', 'notes', reference.notes, { type: 'textarea' }),
    tags.node
  ], async data => {
    const changes = Object.fromEntries(data);
    changes.tags = tags.values();
    let next = updateReference(workspace, reference.id, changes);
    const fields = ['title', 'sourceUrl', 'creator', 'notes'].filter(name => data.get(name));
    if (changes.tags.join('\0') !== reference.tags.join('\0')) fields.push('tags');
    next = signal(next, 'enrich', { type: 'reference', id: reference.id }, { fields });
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

function createPreviewUrl(blob) {
  const url = URL.createObjectURL(blob);
  objectUrls.push(url);
  return url;
}

function revokePreviewUrl(url) {
  const index = objectUrls.indexOf(url);
  if (index >= 0) objectUrls.splice(index, 1);
  URL.revokeObjectURL(url);
}

function syncPreviewControl(controller, active) {
  const control = previewControls.get(controller);
  if (!control) return;
  control.textContent = active ? 'Stop preview' : 'Preview';
  control.setAttribute('aria-label', active ? 'Stop preview' : 'Preview'); control.setAttribute('aria-pressed', String(active));
  if (!active) delete control.dataset.manual;
}

function claimPreview(controller) {
  if (activePreviewController && activePreviewController !== controller) activePreviewController.stop();
  activePreviewController = controller;
  syncPreviewControl(controller, true);
  return true;
}

function releasePreview(controller) {
  if (activePreviewController === controller) activePreviewController = undefined;
  syncPreviewControl(controller, false);
}

function resetMediaPreviews() {
  previewObserver?.disconnect();
  previewObserver = undefined;
  for (const controller of previewControllers) controller.destroy();
  previewControllers.clear();
  previewControls.clear();
  previewCards = new WeakMap();
  activePreviewController = undefined;
  for (const url of [...objectUrls]) revokePreviewUrl(url);
}

function previewElement(asset, url) {
  const attributes = { 'data-asset-id': asset.id, 'data-object-url': url };
  if (asset.kind === 'video') {
    const video = element('video', { className: 'preview video', src: url, controls: '', muted: '', loop: '', playsinline: '', preload: 'metadata', 'aria-label': 'Captured video preview', ...attributes });
    video.muted = true;
    video.loop = true;
    video.playsInline = true;
    return video;
  }
  return element('img', { className: 'preview', src: url, alt: '', ...attributes });
}

async function mediaPreview(asset) {
  if (!asset) return element('div', { className: 'placeholder', text: 'URL reference' });
  const binaryId = blobIdFromLocator(asset.locator);
  if (!binaryId) return element('div', { className: 'placeholder', text: asset.kind.toUpperCase() });
  try {
    const blob = await repository.blob(binaryId);
    return previewElement(asset, createPreviewUrl(blob));
  } catch { return element('div', { className: 'placeholder', text: 'Binary unavailable' }); }
}

function sourceCue() {
  return element('span', { className: 'media-source', 'aria-hidden': 'true' }, [
    element('span', { className: 'external-cue', text: '↗' })
  ]);
}

function iconControl(options, glyph) {
  return element('button', { type: 'button', ...options }, [
    element('span', { className: 'icon-glyph', 'aria-hidden': 'true', text: glyph })
  ]);
}

function formatPreviewDuration(seconds) {
  if (!Number.isFinite(seconds)) return 'Video preview';
  const total = Math.max(0, Math.round(seconds));
  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, '0')}`;
}

async function renderLibrary() {
  resetMediaPreviews();
  if ('IntersectionObserver' in globalThis) {
    previewObserver = new IntersectionObserver(entries => {
      for (const entry of entries) if (!entry.isIntersecting) previewCards.get(entry.target)?.stop();
    });
  }
  const allReferences = projectItems('references');
  const tags = listReferenceTags(allReferences);
  const suggestions = listReferenceTagSuggestions(allReferences).map(({ tag }) => tag);
  const currentTag = $('#library-tag').value;
  $('#library-tag').replaceChildren(element('option', { value: '', text: 'All tags' }),
    ...tags.map(tag => element('option', { value: tag, text: tag })));
  $('#library-tag').value = tags.includes(currentTag) ? currentTag : '';
  urlTagEditor.setSuggestions(suggestions);
  const query = $('#library-search').value;
  const exactTag = $('#library-tag').value;
  const references = filterLibraryReferences(allReferences, { query, tag: exactTag });
  const cards = [];
  for (const reference of references) {
    const assets = workspace.assets.filter(asset => asset.referenceId === reference.id);
    const previewAssets = orderPreviewAssets(assets.filter(asset => blobIdFromLocator(asset.locator)));
    const imageCount = previewAssets.filter(asset => asset.kind === 'image').length;
    const hasVideo = previewAssets.some(asset => asset.kind === 'video');
    const interactivePreview = imageCount > 1 || hasVideo;
    const cardTags = reference.tags.slice(0, MAX_CARD_TAGS);
    const remainingTags = reference.tags.length - cardTags.length;
    const previewAsset = previewAssets[0] ?? assets[0];
    const name = displayReference(reference);
    const edit = iconControl({
      className: 'icon-button', title: 'Edit details', 'aria-label': `Edit details for ${name}`
    }, '✎');
    edit.addEventListener('click', () => referenceEditor(reference));
    const add = element('button', { type: 'button', text: 'Add assets' });
    add.addEventListener('click', () => { $('#file-input').dataset.referenceId = reference.id; $('#file-input').click(); });
    const websiteUrl = safeExternalWebsiteUrl(reference.sourceUrl);
    const websiteCapture = reference.sourceUrl ? element('button', { type: 'button', text: assets.some(asset => asset.provenance?.captureStrategy) ? 'Recapture website' : 'Capture website' }) : null;
    websiteCapture?.addEventListener('click', () => websiteCaptureEditor(reference, websiteCapture));
    const captureState = captureStates.get(reference.id);
    if (websiteCapture && captureState && ['queued', 'capturing'].includes(captureState.status)) {
      websiteCapture.disabled = true;
    }
    const captureBadge = captureState ? element('p', {
      className: 'capture-status capture-badge',
      text: `Capture status: ${captureState.cancelRequested
        ? 'Cancelling' : captureLabels[captureState.status] || captureState.status}${
        captureState.code ? ` (${captureState.code})` : ''}`
    }) : null;
    const cancelCapture = captureState && ['queued', 'capturing'].includes(captureState.status)
      ? element('button', { type: 'button', text: 'Cancel capture' }) : null;
    cancelCapture?.addEventListener('click', async () => {
      try {
        const result = await repository.cancelCapture(reference.id);
        captureStates.set(reference.id, result);
        await render();
        announce('Website capture cancellation requested');
      } catch (error) { announce(error.message, true); }
    });
    const select = element('button', { type: 'button', className: 'primary card-select', text: 'Select for board' });
    select.addEventListener('click', () => selectionEditor(reference));
    const remove = element('button', { type: 'button', className: 'danger', text: 'Delete' });
    remove.addEventListener('click', async () => {
      if (!await confirmAction(`Delete “${name}” and all its assets and selections?`)) return;
      await commit(deleteReference(workspace, reference.id), [], 'Reference deleted');
    });
    const morePanel = element('div', { className: 'more-panel', id: `more-${reference.id}` }, [add, websiteCapture, cancelCapture, remove]);
    morePanel.hidden = true;
    const moreToggle = iconControl({
      className: 'icon-button more-toggle', 'aria-expanded': 'false', 'aria-controls': morePanel.id, title: 'More actions', 'aria-label': `More actions for ${name}`
    }, '⋯');
    moreToggle.addEventListener('click', () => {
      const expanded = morePanel.hidden;
      morePanel.hidden = !expanded;
      moreToggle.setAttribute('aria-expanded', String(expanded));
    });
    const preview = await mediaPreview(previewAsset);
    const isVideoPreview = preview.classList.contains('video');
    const sourceName = `Open the ${name} source website in a new tab`;
    const mediaLink = websiteUrl && !isVideoPreview ? element('a', {
      className: 'media-link', href: websiteUrl, target: '_blank', rel: 'noopener noreferrer',
      title: 'Open source website in a new tab', 'aria-label': sourceName
    }, [preview, sourceCue()]) : null;
    const sourceLink = websiteUrl && isVideoPreview ? element('a', {
      className: 'source-link', href: websiteUrl, target: '_blank', rel: 'noopener noreferrer',
      title: 'Open source website in a new tab', 'aria-label': sourceName
    }, [sourceCue()]) : null;
    const momentText = imageCount > 1 ? `${imageCount} Moments` : '';
    const previewCue = interactivePreview ? element('p', {
      className: 'meta preview-cue', text: momentText || 'Video preview'
    }) : null;
    const previewControl = interactivePreview ? element('button', {
      className: 'preview-control', type: 'button', text: 'Preview', 'aria-label': `Preview ${name}`,
      'aria-pressed': 'false'
    }) : null;
    const card = element('article', { className: 'reference-card' }, [
      element('div', { className: 'card-media' }, [mediaLink ?? preview, sourceLink, captureBadge]),
      element('div', { className: 'card-body' }, [
        element('h2', { className: 'card-title', text: name }),
        element('p', { className: 'meta', text: [reference.creator, `${assets.length} asset${assets.length === 1 ? '' : 's'}`, new Date(reference.capturedAt).toLocaleString()].filter(Boolean).join(' · ') }),
        previewCue,
        previewControl,
        cardTags.length ? element('div', { className: 'card-tags', role: 'list', 'aria-label': 'Tags' }, [
          ...cardTags.map(tag => element('span', { className: 'tag-chip', role: 'listitem', text: tag })),
          remainingTags ? element('span', {
            className: 'tag-chip tag-overflow', role: 'listitem', text: `+${remainingTags}`,
            'aria-label': `${remainingTags} more tag${remainingTags === 1 ? '' : 's'}`
          }) : null
        ]) : null,
        reference.notes ? element('p', { className: 'card-note', text: reference.notes }) : null
      ]),
      element('footer', { className: 'card-actions' }, [
        select,
        element('div', { className: 'card-tools' }, [edit, moreToggle, morePanel])
      ])
    ]);
    if (interactivePreview) {
      const cardMedia = card.querySelector('.card-media');
      const reducedMotion = globalThis.matchMedia?.('(prefers-reduced-motion: reduce)').matches ?? false;
      const coarsePointer = globalThis.matchMedia?.('(pointer: coarse)').matches ?? false;
      let controller, currentPreview = preview, activeMediaLink = mediaLink;
      let activeSourceLink = sourceLink, posterFailed = !preview.matches('img,video');
      const sourceAnchor = (className, child) => element('a', {
        className, href: websiteUrl, target: '_blank', rel: 'noopener noreferrer',
        title: 'Open source website in a new tab', 'aria-label': sourceName
      }, [child]);
      const mountPreview = node => {
        activeMediaLink?.remove();
        activeSourceLink?.remove();
        currentPreview.remove();
        if (websiteUrl && node.matches('video')) {
          cardMedia.prepend(node);
          activeMediaLink = null;
          activeSourceLink = sourceAnchor('source-link', sourceCue());
          cardMedia.insertBefore(activeSourceLink, captureBadge);
        } else if (websiteUrl) {
          activeMediaLink = sourceAnchor('media-link', node);
          activeMediaLink.append(sourceCue());
          cardMedia.prepend(activeMediaLink);
          activeSourceLink = null;
        } else {
          cardMedia.prepend(node);
        }
        currentPreview = node;
      };
      const restorePoster = () => {
        const poster = !posterFailed ? preview : element('div', {
          className: 'placeholder', text: 'Binary unavailable',
          'data-asset-id': previewAsset?.id
        });
        if (poster.matches('video')) {
          poster.pause();
          try { poster.currentTime = 0; } catch {}
        }
        mountPreview(poster);
      };
      const watchMedia = (node, asset) => {
        if (node.matches('video')) node.addEventListener('loadedmetadata', () => {
          if (node === currentPreview) previewCue.textContent = [momentText, formatPreviewDuration(node.duration)].filter(Boolean).join(' · ');
        });
        node.addEventListener('error', () => {
          if (asset === previewAsset) posterFailed = true;
          controller?.failed(asset);
          if (node === currentPreview) restorePoster();
        }, { once: true });
        return node;
      };
      controller = createMediaPreviewController({
        assets: previewAssets,
        initialUrl: preview.dataset.objectUrl,
        reducedMotion,
        async load(asset) {
          const binaryId = blobIdFromLocator(asset.locator);
          if (!binaryId) throw new Error('Binary unavailable');
          return repository.blob(binaryId);
        },
        createUrl: createPreviewUrl,
        revokeUrl: revokePreviewUrl,
        show({ asset, url, playing }) {
          if (!url) { restorePoster(); return; }
          const node = watchMedia(previewElement(asset, url), asset);
          mountPreview(node);
          if (node.matches('video')) {
            node.muted = true;
            if (playing) node.play().catch(() => {});
            else {
              node.pause();
              try { node.currentTime = 0; } catch {}
            }
          }
        },
        claim: claimPreview,
        release: releasePreview
      });
      watchMedia(preview, previewAsset);
      previewControllers.add(controller);
      previewControls.set(controller, previewControl);
      previewCards.set(card, controller);
      previewObserver?.observe(card);
      card.addEventListener('pointerenter', event => {
        if (!coarsePointer && event.pointerType !== 'touch') controller.start();
      });
      card.addEventListener('pointerleave', () => {
        if (!card.contains(document.activeElement)) controller.stop();
      });
      card.addEventListener('focusin', () => controller.start());
      card.addEventListener('focusout', event => {
        if (!card.contains(event.relatedTarget)) controller.stop();
      });
      previewControl.addEventListener('click', async () => {
        if (activePreviewController === controller && previewControl.dataset.manual === 'true') {
          controller.stop();
          return;
        }
        if (activePreviewController === controller) controller.stop(); controller.start({ immediate: true });
        previewControl.dataset.manual = 'true';
        await controller.manual();
      });
    }
    cards.push(card);
  }
  const filtering = query.trim() || exactTag;
  $('#reference-list').replaceChildren(...(cards.length ? cards : [element('p', { className: 'empty', text: filtering ? 'No references match these filters.' : 'No references yet. Save a URL, choose a file, drop one here, or paste an image.' })]));
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
  resetMediaPreviews();
  if (projectId && !find('projects', projectId)) projectId = workspace.projects[0]?.id;
  const project = activeProject();
  $('#project-select').replaceChildren(...workspace.projects.map(item => element('option', { value: item.id, text: item.title })));
  if (project) $('#project-select').value = project.id;
  $('#project-select').disabled = !project;
  $('#edit-project').disabled = !project;
  $('#project-brief').textContent = project?.brief || '';
  $('#automatic-website-capture').checked = workspace.settings.automaticWebsiteCapture;
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
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') activePreviewController?.stop();
  });
  window.addEventListener('hashchange', render);
  $('#new-project').addEventListener('click', () => projectEditor()); $('#welcome-create').addEventListener('click', () => projectEditor()); $('#edit-project').addEventListener('click', () => projectEditor(activeProject()));
  $('#project-select').addEventListener('change', event => { projectId = event.target.value; location.hash = 'library'; render(); });
  $('#url-form').addEventListener('submit', async event => {
    event.preventDefault();
    const form = event.currentTarget;
    const data = new FormData(form);
    const url = data.get('url');
    let tags;
    try { tags = urlTagEditor.values(); }
    catch (error) { announce(error.message, true); return; }
    let next = createReference(workspace, { projectId, sourceUrl: url, tags, captureMethod: 'url' });
    const reference = next.references.at(-1);
    next = createAsset(next, { referenceId: reference.id, kind: 'url', locator: url, provenance: { captureMethod: 'manual-url' } });
    next = signal(next, 'capture', { type: 'reference', id: reference.id }, { method: 'url' });
    const optedIn = data.get('captureWebsite') === 'on';
    const submit = form.querySelector('[type="submit"]');
    submit.disabled = true;
    try {
      const result = await commit(next, [], 'URL saved', { capture: optedIn });
      form.reset();
      urlTagEditor.clear();
      applyCaptureDefault();
      const capture = result.captures?.find(item => item.referenceId === reference.id)
        ?? { referenceId: reference.id, status: 'skipped', reason: 'explicit_opt_out' };
      captureStates.set(reference.id, capture);
      if (optedIn) await waitForScheduledCapture(reference.id, capture, submit);
    } catch (error) { submit.disabled = false; announce(error.message, true); return; }
    if (!optedIn) submit.disabled = false;
  });
  $('#automatic-website-capture').addEventListener('change', async event => {
    const enabled = event.currentTarget.checked;
    try {
      await commit(updateWorkspaceSettings(workspace, {
        automaticWebsiteCapture: enabled
      }), [], `Automatic website capture default ${enabled ? 'enabled' : 'disabled'}`);
      applyCaptureDefault();
    } catch (error) {
      event.currentTarget.checked = workspace.settings.automaticWebsiteCapture;
      announce(error.message, true);
    }
  });
  $('#choose-files').addEventListener('click', () => { delete $('#file-input').dataset.referenceId; $('#file-input').click(); });
  $('#file-input').addEventListener('change', async event => { try { await captureFiles(event.target.files, event.target.dataset.referenceId); } catch (error) { announce(error.message, true); } event.target.value = ''; delete event.target.dataset.referenceId; });
  const drop = $('#drop-zone');
  for (const name of ['dragenter', 'dragover']) drop.addEventListener(name, event => { event.preventDefault(); drop.classList.add('dragging'); });
  for (const name of ['dragleave', 'drop']) drop.addEventListener(name, event => { event.preventDefault(); drop.classList.remove('dragging'); });
  drop.addEventListener('drop', event => captureFiles(event.dataTransfer.files).catch(error => announce(error.message, true)));
  drop.addEventListener('keydown', event => { if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); $('#choose-files').click(); } });
  document.addEventListener('paste', event => { if (!activeProject() || event.target.matches('input,textarea')) return; const files = [...event.clipboardData.files]; if (files.length) { event.preventDefault(); captureFiles(files).catch(error => announce(error.message, true)); } });
  $('#library-search').addEventListener('input', renderLibrary); $('#library-tag').addEventListener('change', renderLibrary);
  $('#aspect-filter').addEventListener('change', renderBoard);
  $('#export-json').addEventListener('click', () => exportBoard('json')); $('#export-markdown').addEventListener('click', () => exportBoard('markdown'));
  $('#backup').addEventListener('click', async () => { try { download('refloom-workspace-backup.json', await repository.exportBackup(workspace), 'application/json'); announce('Workspace backup downloaded'); } catch (error) { announce(error.message, true); } });
  $('#restore-file').addEventListener('change', async event => { try { if (!await confirmAction('Replace the current workspace with this backup?')) return; workspace = await repository.importBackup(await event.target.files[0].text()); projectId = workspace.projects[0]?.id; location.hash = 'library'; applyCaptureDefault(); await render(); announce('Workspace restored'); } catch (error) { announce(`Import failed: ${error.message}`, true); } finally { event.target.value = ''; } });
  $('#delete-project').addEventListener('click', async () => { const project = activeProject(); if (!project || !await confirmAction(`Delete project “${project.title}” and all of its workspace data?`)) return; const next = deleteProject(workspace, project.id); projectId = next.projects[0]?.id; await commit(next, [], 'Project deleted'); });
  $('#reset').addEventListener('click', async () => { if (!await confirmAction('Permanently reset every project, reference, binary, board, and activity record in the shared workspace? This affects every client using it.')) return; workspace = await repository.reset(); projectId = undefined; storeProject(); location.hash = 'library'; applyCaptureDefault(); await render(); announce('The shared Refloom workspace was reset'); });
}

async function start() {
  bindEvents();
  try {
    await repository.open();
    workspace = await repository.load();
    urlTagEditor = tagEditor([], 'capture');
    $('#url-tags').replaceChildren(urlTagEditor.node);
    applyCaptureDefault();
    await render();
  }
  catch (error) { $('#fatal').hidden = false; $('#fatal').textContent = error.message; for (const control of document.querySelectorAll('button,input,select,textarea')) control.disabled = true; }
}

window.addEventListener('beforeunload', () => { resetMediaPreviews(); repository.close(); });
start();
