import { MAX_FILE_BYTES, parseBookmarkText, serializeHTML, serializeJSON } from './lib/formats.js';
import { buildImportPlan } from './lib/planner.js';
import { getHistory, runImport, undoImport } from './lib/operations.js';
import { createDemoApi } from './lib/demo.js';
import {
  countNodes, exportSelection, findNode, listFolders, moveExportItem, moveImportItem,
  selectableIds, selectedTree, walk,
} from './lib/selection.js';
import { exportMarkup, libraryMarkup } from './ui/export-view.js';
import { importMarkup, previewMarkup } from './ui/import-view.js';
import { historyMarkup } from './ui/history-view.js';
import { updateMixedCheckboxes } from './ui/tree.js';
import { escapeHtml } from './ui/html.js';

const demo = !globalThis.chrome?.bookmarks;
const api = demo ? createDemoApi() : chrome;
const byId = id => document.getElementById(id);
const workspace = byId('workspace');
const state = {
  view: 'export', tree: [], roots: [], folders: [], busy: false,
  chosen: new Set(), expanded: new Set(), orders: new Map(), query: '',
  preserveFolders: true, includeRoots: false, format: 'html',
  importNodes: [], importChosen: new Set(), importExpanded: new Set(), filename: '', warnings: [],
  destinations: Object.create(null), defaultDestination: '', duplicatePolicy: 'skip',
  duplicateScope: 'destination', mergeFolders: true, position: 'end',
  plan: null, decisions: Object.create(null), reviewPage: 0,
};

const pages = {
  export: ['Export bookmarks', 'Choose bookmarks and set their order in the exported file.'],
  import: ['Import bookmarks', 'Choose destinations and review changes before importing.'],
  history: ['Import history', 'Review or undo imports made in this browser profile.'],
};
const settings = {
  'preserve-folders': 'preserveFolders', 'include-roots': 'includeRoots', 'export-format': 'format',
  'default-destination': 'defaultDestination', 'duplicate-policy': 'duplicatePolicy',
  'duplicate-scope': 'duplicateScope', 'merge-folders': 'mergeFolders', 'insert-position': 'position',
};

let toastTimer;
function notify(message, error = false) {
  const toast = byId('toast');
  toast.textContent = message;
  toast.className = error ? 'visible error' : 'visible';
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => toast.classList.remove('visible'), error ? 12000 : 6500);
}

function download(contents, filename, type) {
  const url = URL.createObjectURL(new Blob([contents], { type }));
  const link = document.createElement('a');
  link.href = url;
  link.download = filename;
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 30000);
}

function setBusy(busy, message) {
  state.busy = busy;
  workspace.inert = busy;
  const overlay = byId('busy-overlay');
  if (busy) overlay.querySelector('p').textContent = message;
  overlay.hidden = !busy;
  for (const button of document.querySelectorAll('nav button, #refresh-button')) button.disabled = busy;
}

async function whileBusy(message, task) {
  setBusy(true, message);
  try { return await task(); } finally { setBusy(false); }
}

function setLibrary(tree) {
  state.tree = tree;
  state.folders = listFolders(tree);
}

async function loadLibrary(expand = false) {
  setLibrary(await api.bookmarks.getTree());
  state.roots = state.tree[0]?.children || [];
  state.orders.clear();
  const ids = new Set();
  walk(state.roots, (node, parent, depth) => {
    ids.add(node.id);
    if (expand && depth < 2 && node.children) state.expanded.add(node.id);
  });
  state.chosen = new Set([...state.chosen].filter(id => ids.has(id)));
  const writable = state.folders.filter(folder => !folder.locked);
  if (!writable.some(folder => folder.id === state.defaultDestination)) {
    state.defaultDestination = writable[0]?.id || '';
  }
  const { bookmarks, folders } = countNodes(state.roots);
  byId('library-summary').textContent = `${bookmarks.toLocaleString()} bookmarks · ${folders.toLocaleString()} folders`;
  state.plan = null;
}

let renderRequest = 0;
async function render() {
  const request = ++renderRequest;
  const [title, subtitle] = pages[state.view];
  byId('view-title').textContent = title;
  byId('view-subtitle').textContent = subtitle;
  for (const button of document.querySelectorAll('nav [data-view]')) {
    if (button.dataset.view === state.view) button.setAttribute('aria-current', 'page');
    else button.removeAttribute('aria-current');
  }
  if (state.view === 'history') {
    workspace.replaceChildren();
    const jobs = await getHistory(api);
    if (request !== renderRequest) return;
    workspace.innerHTML = historyMarkup(jobs);
  } else {
    workspace.innerHTML = state.view === 'import' ? importMarkup(state) : exportMarkup(state);
    updateMixedCheckboxes(workspace);
  }
}

function importPayload() {
  const entries = selectedTree(state.importNodes, state.importChosen).map(node => ({
    node, destinationId: state.destinations[node.id] || state.defaultDestination,
  }));
  const { duplicatePolicy, duplicateScope, mergeFolders, position, filename } = state;
  const options = { duplicatePolicy, duplicateScope, mergeFolders, position };
  if (duplicatePolicy === 'review') options.duplicateDecisions = state.decisions;
  return { entries, options, filename };
}

function rebuildPlan() {
  const { entries, options } = importPayload();
  state.plan = null;
  state.plan = buildImportPlan({ ...options, entries, existingTree: state.tree });
}

async function previewImport() {
  state.plan = null;
  state.decisions = Object.create(null);
  state.reviewPage = 0;
  try {
    setLibrary(await api.bookmarks.getTree());
    rebuildPlan();
  } finally { await render(); }
  byId('import-preview')?.scrollIntoView({ block: 'start' });
}

function redrawReview(field, key) {
  const preview = byId('import-preview');
  try { rebuildPlan(); } finally { preview.innerHTML = state.plan ? previewMarkup(state) : ''; }
  if (field) preview.querySelector(`[data-conflict-${field}="${CSS.escape(key)}"]`)?.focus({ preventScroll: true });
}

async function execute(type, payload) {
  if (demo) return type === 'import' ? runImport(api, payload) : undoImport(api, payload);
  const message = type === 'import' ? { type, payload } : { type, id: payload };
  const response = await chrome.runtime.sendMessage(message);
  if (!response?.ok) throw new Error(response?.error || 'Check History before retrying this operation.');
  return response.result;
}

async function applyImport() {
  if (!state.plan || state.plan.actions.some(action => action.type === 'unresolved')) return;
  const payload = { ...importPayload(), expectedActions: JSON.stringify(state.plan.actions) };
  try {
    const { stats } = await execute('import', payload);
    await loadLibrary();
    state.view = 'history';
    notify(`Import complete. ${stats.bookmarks} bookmarks added, ${stats.updated || 0} updated, ${stats.skipped} skipped.`);
  } finally {
    state.plan = null;
    await render();
  }
}

async function undo(id) {
  const result = await execute('undo', id);
  await loadLibrary();
  await render();
  const preserved = result.preserved ? `, ${result.preserved} preserved` : '';
  notify(`Undo complete. ${result.restored || 0} restored, ${result.removed} removed${preserved}.`);
}

async function readFile(file) {
  if (!file) return;
  if (file.size > MAX_FILE_BYTES) throw new Error('Choose a bookmark file of 20 MB or less.');
  const { nodes, warnings } = parseBookmarkText(await file.text(), file.name);
  state.filename = file.name;
  state.importNodes = nodes;
  state.importChosen = new Set(nodes.flatMap(selectableIds));
  state.importExpanded = new Set(nodes.filter(node => node.children).map(node => node.id));
  state.warnings = warnings;
  state.destinations = Object.create(null);
  state.plan = null;
  await render();
}

function unwrapSelection() {
  state.importNodes = state.importNodes.flatMap(node => {
    if (!node.children?.length || !selectableIds(node).some(id => state.importChosen.has(id))) return [node];
    const destination = state.destinations[node.id];
    if (destination) for (const child of node.children) state.destinations[child.id] = destination;
    delete state.destinations[node.id];
    return node.children;
  });
  notify('Selected folders’ contents can now be placed individually.');
}

function handleTreeAction({ action, id, source, direction }) {
  const importing = source === 'import';
  switch (action) {
    case 'expand': {
      const expanded = importing ? state.importExpanded : state.expanded;
      if (expanded.has(id)) expanded.delete(id);
      else expanded.add(id);
      break;
    }
    case 'reorder':
      if (importing) moveImportItem(state.importNodes, state.importChosen, id, Number(direction));
      else moveExportItem(state, id, Number(direction));
      break;
    case 'select-all': state.chosen = new Set(state.roots.flatMap(selectableIds)); break;
    case 'clear-selection': state.chosen.clear(); state.orders.clear(); break;
    case 'import-all': state.importChosen = new Set(state.importNodes.flatMap(selectableIds)); break;
    case 'import-none': state.importChosen.clear(); break;
    case 'unwrap-import': unwrapSelection(); break;
    default: return false;
  }
  if (action !== 'expand' && (importing || action.startsWith('import-') || action === 'unwrap-import')) state.plan = null;
  return true;
}

async function handleClick(target) {
  const data = target.dataset;
  if (data.view) {
    state.view = data.view;
    return render();
  }
  if (data.undo) {
    const dialog = byId('undo-dialog');
    dialog.dataset.jobId = data.undo;
    dialog.returnValue = 'cancel';
    dialog.showModal();
    return;
  }
  if (data.reviewPage !== undefined) {
    state.reviewPage = Number(data.reviewPage);
    byId('import-preview').innerHTML = previewMarkup(state);
    byId('import-preview').querySelector('[data-conflict-choice]')?.focus();
    return;
  }
  if (data.action && handleTreeAction(data)) return render();
  switch (target.id) {
    case 'preview-button': return whileBusy('Preparing the import preview…', previewImport);
    case 'apply-import': return whileBusy('Importing bookmarks…', applyImport);
    case 'help-button': return byId('help-dialog').showModal();
    case 'drop-zone':
    case 'replace-file': return byId('import-file').click();
    case 'export-button': {
      const nodes = exportSelection(state);
      const html = state.format === 'html';
      download(html ? serializeHTML(nodes) : serializeJSON(nodes),
        `bookmark-bridge-${new Date().toISOString().slice(0, 10)}.${state.format}`,
        html ? 'text/html;charset=utf-8' : 'application/json');
      notify('Export ready. Check your browser’s downloads.');
      break;
    }
    case 'skip-remaining':
      for (const item of state.plan.actions) {
        if (item.type === 'unresolved') state.decisions[item.conflictKey] = { choice: 'skip' };
      }
      return redrawReview();
    case 'download-plan':
      return download(JSON.stringify({ filename: state.filename, ...state.plan }, null, 2),
        'bookmark-bridge-import-review.json', 'application/json');
    case 'refresh-button': return whileBusy('Reading bookmarks…', async () => {
      await loadLibrary(true);
      await render();
      notify('Library refreshed. Export ordering and import preview were reset.');
    });
  }
}

async function handleChange(target) {
  const { conflictChoice, conflictTarget, currentTarget, destination, action, id, source } = target.dataset;
  if (conflictChoice !== undefined) {
    state.decisions[conflictChoice] = { choice: target.value || null, targetId: currentTarget || null };
    return redrawReview('choice', conflictChoice);
  }
  if (conflictTarget !== undefined) {
    const conflict = state.plan.conflicts.find(item => item.key === conflictTarget);
    const match = conflict?.matches.find(item => item.id === target.value);
    if (!match) return;
    const choice = match.locked && ['merge', 'replace'].includes(conflict.choice) ? null : conflict.choice;
    state.decisions[conflictTarget] = { choice, targetId: match.id };
    return redrawReview('target', conflictTarget);
  }
  if (target.id === 'import-file') return whileBusy('Reading bookmark file…', () => readFile(target.files[0]));
  if (action === 'select-node') {
    const importing = source === 'import';
    const node = findNode(importing ? state.importNodes : state.roots, id);
    if (!node) return;
    const selection = importing ? state.importChosen : state.chosen;
    for (const key of selectableIds(node)) {
      if (target.checked) selection.add(key);
      else selection.delete(key);
    }
  } else if (destination !== undefined) {
    state.destinations[destination] = target.value;
  } else if (Object.hasOwn(settings, target.id)) {
    state[settings[target.id]] = target.type === 'checkbox' ? target.checked : target.value;
  } else return;
  if (state.view === 'import') state.plan = null;
  await render();
}

function reportError(error) { notify(error.message, true); }
document.addEventListener('click', event => {
  const button = event.target.closest('button');
  if (button && !state.busy) handleClick(button).catch(reportError);
});
document.addEventListener('change', event => {
  if (!state.busy) handleChange(event.target).catch(reportError);
});
document.addEventListener('input', event => {
  if (event.target.id !== 'library-search') return;
  state.query = event.target.value;
  byId('library-tree').innerHTML = libraryMarkup(state);
  updateMixedCheckboxes(byId('library-tree'));
});
byId('undo-dialog').addEventListener('close', event => {
  const dialog = event.target;
  if (dialog.returnValue === 'undo' && !state.busy) {
    whileBusy('Undoing import…', () => undo(dialog.dataset.jobId)).catch(reportError);
  }
});
document.addEventListener('dragover', event => {
  if (state.view !== 'import') return;
  event.preventDefault();
  if (state.busy) return;
  byId('drop-zone')?.classList.add('drag-over');
});
document.addEventListener('dragleave', event => {
  if (event.target.id === 'drop-zone') event.target.classList.remove('drag-over');
});
document.addEventListener('drop', event => {
  if (state.view !== 'import') return;
  event.preventDefault();
  if (state.busy) return;
  byId('drop-zone')?.classList.remove('drag-over');
  const file = event.dataTransfer.files[0];
  whileBusy('Reading bookmark file…', () => readFile(file)).catch(reportError);
});

byId('demo-badge').hidden = !demo;
try {
  await loadLibrary(true);
  await render();
} catch (error) {
  workspace.innerHTML = `<div class="notice warning"><div><strong>Couldn’t read bookmarks</strong>
    <p>${escapeHtml(error.message)}</p></div></div>`;
}
