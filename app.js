import { parseBookmarkText, serializeHTML, serializeJSON } from './lib/formats.js';
import { buildImportPlan } from './lib/planner.js';
import { getHistory, runImport, undoImport } from './lib/operations.js';
import { createDemoApi } from './lib/demo.js';

const demo = !globalThis.chrome?.bookmarks;
const api = demo ? createDemoApi() : chrome;
const $ = selector => document.querySelector(selector);
const esc = value => String(value ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const icon = (kind = 'folder') => kind === 'folder' ? '<svg viewBox="0 0 24 24" width="19" height="19" fill="none" stroke="currentColor" stroke-width="1.6" aria-hidden="true"><path d="M3 7a2 2 0 0 1 2-2h5l2 2h7a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2Z"/></svg>' : '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="1.6" aria-hidden="true"><path d="M8 3h8a1 1 0 0 1 1 1v17l-5-4-5 4V4a1 1 0 0 1 1-1Z"/></svg>';
const state = { view: 'export', tree: [], roots: [], chosen: new Set(), expanded: new Set(), query: '', preserveFolders: true, includeRoots: false, format: 'html', importNodes: [], importChosen: new Set(), importExpanded: new Set(), filename: '', warnings: [], destinations: {}, defaultDestination: '', duplicatePolicy: 'skip', duplicateScope: 'destination', mergeFolders: true, position: 'end', plan: null, busy: false };
function walk(nodes, fn, parent = null, depth = 0) { for (const node of nodes) { fn(node, parent, depth); if (node.children) walk(node.children, fn, node, depth + 1); } }
function count(nodes) { let bookmarks = 0, folders = 0; walk(nodes, node => node.url !== undefined ? bookmarks++ : folders++); return { bookmarks, folders }; }
function units(node) { return node.url !== undefined || !node.children?.length ? [node.id] : node.children.flatMap(units); }
function prune(nodes, selection) { return nodes.flatMap(node => { if (node.url !== undefined || !node.children?.length) return selection.has(node.id) ? [structuredClone(node)] : []; const children = prune(node.children, selection); return children.length ? [{ ...node, children }] : []; }); }
function flatBookmarks(nodes) { const result = []; walk(nodes, node => { if (node.url !== undefined) result.push(node); }); return result; }
const exportOrders = new Map();
state.destinations = Object.create(null);
function exportNodes() {
  let nodes = prune(state.roots, state.chosen);
  if (!state.includeRoots) nodes = nodes.flatMap(node => node.children || [node]);
  if (!state.preserveFolders) nodes = flatBookmarks(nodes);
  const arrange = (siblings, key) => {
    const order = exportOrders.get(key);
    if (order) { const rank = new Map(order.map((id, index) => [id, index])); siblings.sort((a, b) => (rank.get(a.id) ?? order.length) - (rank.get(b.id) ?? order.length)); }
    for (const node of siblings) if (node.children) arrange(node.children, node.id);
    return siblings;
  };
  return arrange(nodes, state.preserveFolders ? 'top' : 'flat');
}
function getFolders() { const folders = []; const visit = (nodes, path = [], blocked = false) => { for (const node of nodes) { const locked = blocked || Boolean(node.unmodifiable) || node.folderType === 'managed'; if (node.url !== undefined) continue; const next = node.title ? [...path, node.title] : path; if (node.id !== '0' && !locked) folders.push({ id: node.id, label: next.join(' / ') || 'Untitled folder' }); visit(node.children || [], next, locked); } }; visit(state.tree); return folders; }
function folderOptions(value) { const folders = getFolders(); const missing = value && !folders.some(folder => folder.id === value); return (missing ? `<option value="${esc(value)}" selected disabled>Unavailable folder — choose again</option>` : '') + folders.map(folder => `<option value="${esc(folder.id)}"${folder.id === value ? ' selected' : ''}>${esc(folder.label)}</option>`).join(''); }
function toast(message, error = false) { $('#toast').textContent = message; $('#toast').className = `toast visible${error ? ' error' : ''}`; clearTimeout(toast.timer); toast.timer = setTimeout(() => $('#toast').classList.remove('visible'), error ? 12000 : 6500); }
function download(text, filename, type) { const url = URL.createObjectURL(new Blob([text], { type })); const a = document.createElement('a'); a.href = url; a.download = filename; a.click(); setTimeout(() => URL.revokeObjectURL(url), 30000); }
function setBusy(value) { state.busy = value; $('#busy-overlay').hidden = !value; $('#workspace').inert = value; document.querySelectorAll('[data-view], #refresh-button').forEach(button => button.disabled = value); }
async function loadTree(reset = false) {
  exportOrders.clear();
  state.tree = await api.bookmarks.getTree();
  state.roots = structuredClone(state.tree[0]?.children || []);
  const ids = new Set(); walk(state.roots, (node, parent, depth) => { ids.add(node.id); if (reset && depth < 2 && node.children) state.expanded.add(node.id); });
  state.chosen = new Set([...state.chosen].filter(id => ids.has(id)));
  const folders = getFolders(); if (!folders.some(folder => folder.id === state.defaultDestination)) state.defaultDestination = folders[0]?.id || '';
  const stats = count(state.roots);
  $('#library-summary').textContent = `${stats.bookmarks.toLocaleString()} bookmarks · ${stats.folders.toLocaleString()} folders`;
  state.plan = null;
}
function matches(node, query) { return `${node.title} ${node.url || ''}`.toLowerCase().includes(query) || node.children?.some(child => matches(child, query)); }
function treeMarkup(nodes, { source = 'export', depth = 0, reorder = false, check = true, query = '' } = {}) {
  const selection = source === 'import' ? state.importChosen : state.chosen;
  const expanded = source === 'import' ? state.importExpanded : state.expanded;
  return nodes.filter(node => !query || matches(node, query)).map((node, index, visible) => {
    const folder = node.url === undefined;
    const keys = units(node), checkedCount = keys.filter(id => selection.has(id)).length;
    const isExpanded = reorder || expanded.has(node.id) || !!query;
    let domain = ''; if (!folder) { try { domain = new URL(node.url).hostname || new URL(node.url).protocol; } catch { domain = node.url; } }
    const stats = folder ? count(node.children || []) : null;
    return `<div class="tree-row${checkedCount ? ' is-selected' : ''}" style="--depth:${depth}" data-node-id="${esc(node.id)}">
      ${folder && node.children?.length && !reorder ? `<button class="tree-toggle" data-action="expand" data-source="${source}" data-id="${esc(node.id)}" aria-label="${isExpanded ? 'Collapse' : 'Expand'} ${esc(node.title)}" aria-expanded="${isExpanded}">${isExpanded ? '⌄' : '›'}</button>` : '<span class="tree-toggle-spacer"></span>'}
      ${check ? `<input class="tree-check" type="checkbox" data-action="select-node" data-source="${source}" data-id="${esc(node.id)}" aria-label="Select ${esc(node.title)}" ${checkedCount === keys.length ? 'checked' : ''} ${checkedCount && checkedCount !== keys.length ? 'data-mixed="true"' : ''}>` : ''}
      <span class="tree-icon${folder ? '' : ' site-icon'}">${folder ? icon() : esc((domain || node.title || '?')[0].toUpperCase())}</span>
      <span class="tree-content"><span class="tree-title" title="${esc(node.title)}">${esc(node.title || 'Untitled')}</span>${!folder ? `<span class="tree-url" title="${esc(node.url)}">${esc(domain)}</span>` : ''}</span>
      ${folder ? `<span class="tree-meta">${stats.bookmarks} links</span>` : ''}
      ${reorder ? `<span class="row-actions"><button class="icon-button" data-action="reorder" data-source="${source}" data-id="${esc(node.id)}" data-direction="-1" aria-label="Move ${esc(node.title)} up" title="Move up" ${index === 0 ? 'disabled' : ''}>↑</button><button class="icon-button" data-action="reorder" data-source="${source}" data-id="${esc(node.id)}" data-direction="1" aria-label="Move ${esc(node.title)} down" title="Move down" ${index === visible.length - 1 ? 'disabled' : ''}>↓</button></span>` : ''}
      </div>${folder && isExpanded ? treeMarkup(node.children || [], { source, depth: depth + 1, reorder, check, query: query && `${node.title}`.toLowerCase().includes(query) ? '' : query }) : ''}`;
  }).join('');
}
function updateMixed() { document.querySelectorAll('[data-mixed]').forEach(input => input.indeterminate = true); }
function render() {
  const titles = { export: ['A little order. A fresh start.', 'Bring the bookmarks you love. Leave the clutter behind.'], import: ['Make room for what’s next.', 'Place incoming bookmarks exactly where they belong.'], history: ['Every transfer, accounted for.', 'Review imports and undo the items they created.'] };
  $('#view-title').textContent = titles[state.view][0]; $('#view-subtitle').textContent = titles[state.view][1];
  document.querySelectorAll('[data-view]').forEach(button => { button.classList.toggle('active', button.dataset.view === state.view); if (button.dataset.view === state.view) button.setAttribute('aria-current', 'page'); else button.removeAttribute('aria-current'); });
  if (state.view === 'export') renderExport(); else if (state.view === 'import') renderImport(); else renderHistory().catch(error => toast(error.message, true));
  updateMixed();
}
function renderExport() {
  const selected = exportNodes(), stats = count(selected);
  $('#workspace').innerHTML = `<div class="workspace-intro"><div><span class="eyebrow">CURATE YOUR NEXT CHAPTER</span><h2>Your bookmarks, your way.</h2><p class="muted">Choose a few favorites or a whole folder. The structure travels with you.</p></div><span class="chip">${icon('bookmark')} Local & private</span></div>
    <div class="split-layout export-layout"><section class="panel library-panel"><div class="panel-header"><div><h3 class="panel-title">Your library</h3><p class="panel-subtitle">Select folders or individual bookmarks</p></div><span class="badge">THIS BROWSER</span></div>
    <div class="toolbar"><input id="library-search" class="search-input" type="search" placeholder="Search bookmarks and folders…" aria-label="Search bookmarks and folders" value="${esc(state.query)}"><button class="button ghost small" data-action="select-all">Select all</button><button class="button ghost small" data-action="clear-selection">Clear</button></div>
    <div class="tree library-tree" id="library-tree">${treeMarkup(state.roots, { query: state.query.toLowerCase() }) || '<div class="empty-state">No bookmarks found.</div>'}</div><div class="panel-footer footer-note">${icon()} Folder selections include their nested bookmarks.</div></section>
    <aside class="panel export-tray"><div class="panel-header"><div><h3 class="panel-title">Your export</h3><p class="panel-subtitle">A collection worth taking with you</p></div><span class="badge accent">${stats.bookmarks} LINKS</span></div>
    <div class="selection-list" id="export-selection">${selected.length ? treeMarkup(selected, { reorder: true, check: false }) : `<div class="empty-state"><span class="empty-icon">${icon('bookmark')}</span><h3>Start with a favorite</h3><p>Select bookmarks from your library.<br>Your export takes shape here.</p></div>`}</div>
    <div class="panel-body export-options"><p class="footer-note">Use ↑ and ↓ to set the exported order.</p><label class="check-field"><input type="checkbox" id="preserve-folders" ${state.preserveFolders ? 'checked' : ''}> Keep folder structure</label><label class="check-field"><input type="checkbox" id="include-roots" ${state.includeRoots ? 'checked' : ''} ${!state.preserveFolders ? 'disabled' : ''}> Include “Bookmarks bar” / root folders</label><div class="field"><label class="field-label" for="export-format">File format</label><select class="select" id="export-format"><option value="html" ${state.format === 'html' ? 'selected' : ''}>HTML · works with all major browsers</option><option value="json" ${state.format === 'json' ? 'selected' : ''}>JSON · Bookmark Bridge backup</option></select></div><button class="button primary full-width" id="export-button" ${!selected.length ? 'disabled' : ''}>↓ &nbsp; Export ${stats.bookmarks} bookmark${stats.bookmarks === 1 ? '' : 's'}</button><p class="footer-note center">${stats.folders} folders · Saved directly to your computer</p></div></aside></div>
    <div class="notice"><span class="notice-symbol">↗</span><div><strong>A familiar home, on any computer.</strong><p>Export here, open Bookmark Bridge on your other computer, and choose Import to give every folder its place.</p></div></div>`;
}
function renderImport() {
  const hasFile = !!state.filename;
  const selected = prune(state.importNodes, state.importChosen);
  $('#workspace').innerHTML = `<div class="workspace-intro"><div><span class="eyebrow">A THOUGHTFUL ARRIVAL</span><h2>Bring your collection home.</h2><p class="muted">Review every addition before it reaches your browser.</p></div><span class="chip">${icon()} Existing bookmarks stay in place</span></div>
    <input type="file" id="import-file" accept=".html,.htm,.json,text/html,application/json" hidden>
    ${!hasFile ? `<section class="panel"><div class="drop-zone" id="drop-zone" tabindex="0" role="button" aria-label="Choose a bookmark file"><span class="upload-icon">↑</span><h3>Drop your bookmarks here</h3><p>or <span class="text-accent">browse your files</span></p><span class="footer-note">Netscape HTML or JSON · up to 20 MB</span></div><div class="panel-footer"><strong>Coming from another browser?</strong><p class="muted">Export bookmarks as HTML from Chrome, Edge, Firefox, or Safari, then open that file here.</p></div></section>` : `
    <div class="file-banner"><span class="file-icon">${icon('bookmark')}</span><div><strong>${esc(state.filename)}</strong><p class="muted">${count(state.importNodes).bookmarks} bookmarks · ${count(state.importNodes).folders} folders</p></div><button class="button secondary small" data-action="unwrap-import" title="Remove selected top-level folder wrappers so their contents can have individual destinations" ${selected.some(node => node.children?.length) ? '' : 'disabled'}>Use folder contents</button><button class="button secondary small" id="replace-file">Choose another file</button></div><p class="footer-note">Importing a “Bookmarks bar” wrapper? Use folder contents to place its selected contents individually. Repeat for deeper folders, or reload the file to restore its structure.</p>
    ${state.warnings.length ? `<div class="notice warning"><div><strong>Some entries need attention</strong><p>${state.warnings.slice(0, 8).map(esc).join('<br>')}${state.warnings.length > 8 ? `<br>…and ${state.warnings.length - 8} more warnings.` : ''}</p></div></div>` : ''}
    <div class="split-layout import-layout"><section class="panel"><div class="panel-header"><div><h3 class="panel-title">Incoming collection</h3><p class="panel-subtitle">Choose what to bring and arrange its order</p></div><div class="top-actions"><button class="button ghost small" data-action="import-all">All</button><button class="button ghost small" data-action="import-none">None</button></div></div><div class="tree incoming-tree">${treeMarkup(state.importNodes, { source: 'import' }) || '<div class="empty-state">This file contains an empty collection.</div>'}</div>
    ${selected.length ? `<div class="panel-header placement-heading"><div><h3 class="panel-title">Choose a home</h3><p class="panel-subtitle">Each selected top-level item can go to a different folder. Nested folders keep their structure.</p></div></div><div class="placement-list">${selected.map((node, index) => `<div class="placement-item"><div class="placement-title"><span class="tree-icon">${icon(node.url !== undefined ? 'bookmark' : 'folder')}</span><strong>${esc(node.title || 'Untitled')}</strong><span class="row-actions"><button class="icon-button" data-action="reorder" data-source="import" data-id="${esc(node.id)}" data-direction="-1" aria-label="Move ${esc(node.title)} up" ${index === 0 ? 'disabled' : ''}>↑</button><button class="icon-button" data-action="reorder" data-source="import" data-id="${esc(node.id)}" data-direction="1" aria-label="Move ${esc(node.title)} down" ${index === selected.length - 1 ? 'disabled' : ''}>↓</button></span></div><label class="sr-only" for="dest-${esc(node.id)}">Destination for ${esc(node.title)}</label><select class="select destination-select" id="dest-${esc(node.id)}" data-destination="${esc(node.id)}">${folderOptions(state.destinations[node.id] || state.defaultDestination)}</select></div>`).join('')}</div>` : ''}</section>
    <aside class="panel import-settings"><div class="panel-header"><div><h3 class="panel-title">Import preferences</h3><p class="panel-subtitle">You decide how it all fits together</p></div></div><div class="panel-body">
    <div class="field"><label class="field-label" for="default-destination">Default destination</label><select class="select" id="default-destination">${folderOptions(state.defaultDestination)}</select><p class="field-hint">Applies to items without an individual destination.</p></div>
    <div class="field"><label class="field-label" for="duplicate-policy">When a URL already exists</label><select class="select" id="duplicate-policy"><option value="skip" ${state.duplicatePolicy === 'skip' ? 'selected' : ''}>Skip the incoming duplicate</option><option value="keep" ${state.duplicatePolicy === 'keep' ? 'selected' : ''}>Keep both bookmarks</option></select></div>
    <div class="field"><label class="field-label" for="duplicate-scope">Look for duplicates</label><select class="select" id="duplicate-scope" ${state.duplicatePolicy === 'keep' ? 'disabled' : ''}><option value="destination" ${state.duplicateScope === 'destination' ? 'selected' : ''}>In each destination folder</option><option value="global" ${state.duplicateScope === 'global' ? 'selected' : ''}>Across the whole browser</option></select><p class="field-hint">Different query strings, fragments, and trailing slashes stay distinct.</p></div>
    <label class="check-field"><input type="checkbox" id="merge-folders" ${state.mergeFolders ? 'checked' : ''}> Merge folders with identical names</label><p class="field-hint">Combines contents recursively within the chosen destination.</p>
    <div class="field"><label class="field-label" for="insert-position">Place new items</label><select class="select" id="insert-position"><option value="end" ${state.position === 'end' ? 'selected' : ''}>At the end of each folder</option><option value="start" ${state.position === 'start' ? 'selected' : ''}>At the beginning of each folder</option></select></div><button class="button primary full-width" id="preview-button" ${!selected.length || !getFolders().length ? 'disabled' : ''}>Review import &nbsp; →</button><p class="footer-note center">Preview first. Import when you’re ready.</p></div></aside></div><div id="import-preview">${state.plan ? previewMarkup() : ''}</div>`}`;
  updateMixed();
}
function previewMarkup() {
  const { stats, actions } = state.plan;
  const labels = { 'create-folder': 'New folder', 'create-bookmark': 'New bookmark', 'merge-folder': 'Merge folder', skip: 'Skip duplicate' };
  const paths = new Map(getFolders().map(folder => [folder.id, folder.label]));
  const previewPaths = actions.map(action => { const parentPath = paths.get(action.parentRef) || action.parentRef; if (action.type === 'create-folder') paths.set(action.key, `${parentPath} / ${action.title}`); return parentPath; });
  return `<section class="panel preview-panel"><div class="panel-header"><div><span class="eyebrow">READY WHEN YOU ARE</span><h3 class="panel-title">Here’s what will happen</h3><p class="panel-subtitle">No existing bookmarks will be deleted or moved.</p></div><button class="button secondary small" id="download-plan">Save review</button></div><div class="stats-grid">${[[stats.bookmarks, 'New bookmarks'], [stats.folders, 'New folders'], [stats.merged, 'Folders merged'], [stats.skipped, 'Duplicates skipped']].map(([value, label]) => `<div class="stat-card"><span class="stat-value">${value}</span><span class="stat-label">${label}</span></div>`).join('')}</div>
    <div class="preview-list">${actions.slice(0, 300).map((action, index) => `<div class="preview-row"><span class="badge ${action.type === 'skip' ? '' : 'accent'}">${labels[action.type]}</span><div><strong>${esc(action.title || 'Untitled')}</strong><p class="muted">${esc(previewPaths[index])}${action.reason ? ` · ${esc(action.reason)}` : ''}</p></div></div>`).join('') || '<div class="empty-state">There are no changes to apply.</div>'}</div>${actions.length > 300 ? `<p class="footer-note panel-body">Showing the first 300 of ${actions.length} actions. Save review to inspect the complete plan.</p>` : ''}<div class="panel-footer preview-footer"><p class="footer-note">You can undo created items from History.</p><button class="button primary" id="apply-import" ${!stats.bookmarks && !stats.folders ? 'disabled' : ''}>Import ${stats.bookmarks} bookmarks &nbsp; →</button></div></section>`;
}
async function renderHistory() {
  const history = await getHistory(api); if (state.view !== 'history') return;
  $('#workspace').innerHTML = `<div class="workspace-intro"><div><span class="eyebrow">YOUR TRANSFER JOURNAL</span><h2>A clear trail. An easy way back.</h2><p class="muted">Import history is stored on this computer.</p></div></div><section class="panel"><div class="panel-header"><div><h3 class="panel-title">Import history</h3><p class="panel-subtitle">Undo removes unchanged items created by that import. Edited items and folders with added contents are preserved.</p></div></div><div class="history-list">${history.length ? history.map(job => `<article class="history-item"><span class="tree-icon">${icon()}</span><div class="history-details"><strong>${esc(job.filename)}</strong><p class="muted">${new Date(job.startedAt).toLocaleString()} · ${job.stats.bookmarks} bookmarks · ${job.stats.folders} folders</p><span class="badge">${esc(job.status.replaceAll('-', ' '))}</span>${job.error ? `<p class="error-text">${esc(job.error)}</p>` : ''}${job.preserved ? `<p class="muted">${job.preserved} edited or nonempty items preserved.</p>` : ''}${job.recoveryWarning ? `<p class="muted">${esc(job.recoveryWarning)}</p>` : ''}</div>${!['undone', 'failed-empty'].includes(job.status) ? `<button class="button secondary small" data-undo="${esc(job.id)}">${job.status === 'undo-partial' ? 'Retry undo' : 'Undo import'}</button>` : '<span class="muted">No action needed</span>'}</article>`).join('') : '<div class="empty-state"><span class="empty-icon">↶</span><h3>A fresh page</h3><p>Your imports will appear here, with a way to undo each one.</p><button class="button secondary" data-view="import">Import bookmarks</button></div>'}</div></section><div class="notice"><div><strong>A small precaution for a big collection</strong><p>For a full backup, select all bookmarks in Export and save an HTML or JSON copy before importing.</p></div></div>`;
}
async function readFile(file) {
  if (!file) return;
  if (file.size > 20 * 1024 * 1024) throw new Error('Choose a bookmark file smaller than 20 MB.');
  const parsed = parseBookmarkText(await file.text(), file.name);
  state.importNodes = parsed.nodes; state.filename = file.name; state.warnings = parsed.warnings;
  state.importChosen = new Set(parsed.nodes.flatMap(units)); state.importExpanded.clear();
  walk(parsed.nodes, (node, parent, depth) => { if (node.children && depth < 1) state.importExpanded.add(node.id); });
  state.destinations = Object.create(null); state.plan = null; render(); toast(`Loaded ${count(parsed.nodes).bookmarks} bookmarks. Choose their destinations, then review.`);
}
function importPayload() { return { entries: prune(state.importNodes, state.importChosen).map(node => ({ node, destinationId: state.destinations[node.id] || state.defaultDestination })), options: { duplicatePolicy: state.duplicatePolicy, duplicateScope: state.duplicateScope, mergeFolders: state.mergeFolders, position: state.position }, filename: state.filename }; }
async function previewImport() { state.plan = null; state.tree = await api.bookmarks.getTree(); const payload = importPayload(); try { state.plan = buildImportPlan({ ...payload.options, entries: payload.entries, existingTree: state.tree }); } catch (error) { renderImport(); throw error; } renderImport(); $('#import-preview').scrollIntoView({ behavior: 'smooth', block: 'start' }); }
async function execute(type, payload) {
  if (demo) return type === 'import' ? runImport(api, payload) : undoImport(api, payload);
  const response = await chrome.runtime.sendMessage(type === 'import' ? { type, payload } : { type, id: payload });
  if (!response?.ok) throw new Error(response?.error || 'The operation did not complete. Check History before retrying.');
  return response.result;
}
async function applyImport() {
  if (!state.plan || state.busy) return;
  const payload = { ...importPayload(), expectedActions: JSON.stringify(state.plan.actions) };
  setBusy(true);
  try { const result = await execute('import', payload); await loadTree(); state.view = 'history'; render(); toast(`Import complete: ${result.stats.bookmarks} bookmarks added, ${result.stats.skipped} duplicates skipped.`); }
  catch (error) { state.plan = null; toast(error.message, true); render(); }
  finally { setBusy(false); }
}
function findNode(nodes, id) { let found; walk(nodes, node => { if (node.id === id) found = node; }); return found; }
function reorderNode(source, id, direction) {
  if (source === 'export') {
    const arrange = (nodes, key) => {
      const at = nodes.findIndex(node => node.id === id);
      if (at >= 0) { const target = at + direction; if (target < 0 || target >= nodes.length) return true; [nodes[at], nodes[target]] = [nodes[target], nodes[at]]; exportOrders.set(key, nodes.map(node => node.id)); return true; }
      return nodes.some(node => node.children && arrange(node.children, node.id));
    };
    arrange(exportNodes(), state.preserveFolders ? 'top' : 'flat'); render(); return;
  }
  const roots = source === 'import' ? state.importNodes : state.roots;
  const chosen = source === 'import' ? state.importChosen : state.chosen;
  const swap = nodes => { const index = nodes.findIndex(node => node.id === id); if (index >= 0) { const visible = nodes.filter(node => units(node).some(key => chosen.has(key))); const at = visible.findIndex(node => node.id === id); const neighbor = visible[at + direction]; if (!neighbor) return true; const target = nodes.findIndex(node => node.id === neighbor.id); [nodes[index], nodes[target]] = [nodes[target], nodes[index]]; return true; } return nodes.some(node => node.children && swap(node.children)); };
  swap(roots); state.plan = null; render();
}
function help() {
  const dialog = document.createElement('dialog'); dialog.className = 'help-dialog';
  dialog.innerHTML = `<span class="eyebrow">A QUICK FIELD GUIDE</span><h2>One collection. Anywhere you go.</h2><ol class="help-steps"><li><strong>Choose & arrange.</strong><p>Select bookmarks or entire folders in Export. Use the arrow controls to arrange the exported order. Your browser’s existing order stays unchanged.</p></li><li><strong>Take your file with you.</strong><p>Save as HTML for universal browser import, or JSON for a Bookmark Bridge backup. Transfer the file to your other computer.</p></li><li><strong>Give it a home.</strong><p>Open Import on the other computer, choose the file, and select a destination for each top-level item. Review duplicates and folder merges before importing.</p></li></ol><p class="muted">Everything is processed locally. No accounts, uploads, analytics, or access to the pages you visit. Export files contain your bookmark titles and URLs.</p><p class="muted">HTML and JSON support folders and URLs. Browser-specific tags, favicons, and bookmark keywords are not transferred. Undo is available for imports made by this extension.</p><div class="dialog-actions"><button class="button primary" id="close-help">Got it</button></div>`;
  document.body.append(dialog); dialog.showModal(); dialog.querySelector('#close-help').onclick = () => dialog.close(); dialog.addEventListener('close', () => dialog.remove());
}

document.addEventListener('click', async event => {
  const target = event.target.closest('button, [data-action], #drop-zone'); if (!target || state.busy) return;
  try {
    if (target.dataset.view) { state.view = target.dataset.view; render(); return; }
    const action = target.dataset.action, source = target.dataset.source;
    if (action === 'expand') { const expanded = source === 'import' ? state.importExpanded : state.expanded; expanded.has(target.dataset.id) ? expanded.delete(target.dataset.id) : expanded.add(target.dataset.id); render(); }
    if (action === 'select-all') { state.chosen = new Set(state.roots.flatMap(units)); render(); }
    if (action === 'clear-selection') { state.chosen.clear(); exportOrders.clear(); render(); }
    if (action === 'import-all' || action === 'import-none') { state.importChosen = new Set(action === 'import-all' ? state.importNodes.flatMap(units) : []); state.plan = null; render(); }
    if (action === 'unwrap-import') {
      state.importNodes = state.importNodes.flatMap(node => {
        if (!node.children?.length || !units(node).some(id => state.importChosen.has(id))) return [node];
        if (state.destinations[node.id]) for (const child of node.children) state.destinations[child.id] = state.destinations[node.id];
        delete state.destinations[node.id]; return node.children;
      });
      state.plan = null; render(); toast('Selected folder wrappers removed from the preview. Their contents can now be placed individually.');
    }
    if (action === 'reorder') reorderNode(source, target.dataset.id, Number(target.dataset.direction));
    if (target.id === 'export-button') { const nodes = exportNodes(); const filename = `bookmark-bridge-${new Date().toISOString().slice(0, 10)}.${state.format}`; download(state.format === 'html' ? serializeHTML(nodes) : serializeJSON(nodes), filename, state.format === 'html' ? 'text/html;charset=utf-8' : 'application/json'); toast('Your export is ready. Check your browser’s downloads.'); }
    if (target.id === 'drop-zone' || target.id === 'replace-file') $('#import-file').click();
    if (target.id === 'preview-button') await previewImport();
    if (target.id === 'apply-import') await applyImport();
    if (target.id === 'download-plan') download(JSON.stringify({ filename: state.filename, ...state.plan }, null, 2), 'bookmark-bridge-import-review.json', 'application/json');
    if (target.id === 'refresh-button') { await loadTree(true); render(); toast('Library refreshed. Export ordering and import preview were reset.'); }
    if (target.id === 'help-button') help();
    if (target.dataset.undo) {
      const dialog = document.createElement('dialog'); dialog.className = 'help-dialog'; dialog.innerHTML = '<h2>Undo this import?</h2><p>This removes unchanged bookmarks and empty folders created by this import. Edited or moved items, and folders with other contents, are preserved.</p><div class="dialog-actions"><button class="button secondary" data-cancel>Keep import</button><button class="button danger" data-confirm>Undo import</button></div>'; document.body.append(dialog); dialog.showModal(); dialog.querySelector('[data-cancel]').onclick = () => dialog.close(); dialog.addEventListener('close', () => dialog.remove()); dialog.querySelector('[data-confirm]').onclick = async () => { dialog.close(); setBusy(true); try { const result = await execute('undo', target.dataset.undo); await loadTree(); render(); toast(`Undo complete. ${result.removed} items removed${result.preserved ? `; ${result.preserved} changed or nonempty items preserved` : ''}.`); } catch (error) { toast(error.message, true); } finally { setBusy(false); } };
    }
  } catch (error) { toast(error.message, true); }
});
document.addEventListener('change', async event => {
  const target = event.target; if (state.busy) return;
  try {
    if (target.dataset.action === 'select-node') { const source = target.dataset.source; const node = findNode(source === 'import' ? state.importNodes : state.roots, target.dataset.id); const selection = source === 'import' ? state.importChosen : state.chosen; for (const id of units(node)) target.checked ? selection.add(id) : selection.delete(id); state.plan = null; render(); return; }
    const fields = { 'preserve-folders': ['preserveFolders', true], 'include-roots': ['includeRoots', true], 'export-format': ['format'], 'default-destination': ['defaultDestination'], 'duplicate-policy': ['duplicatePolicy'], 'duplicate-scope': ['duplicateScope'], 'merge-folders': ['mergeFolders', true], 'insert-position': ['position'] };
    if (fields[target.id]) { const [key, boolean] = fields[target.id]; state[key] = boolean ? target.checked : target.value; state.plan = null; render(); }
    if (target.dataset.destination) { state.destinations[target.dataset.destination] = target.value; state.plan = null; render(); }
    if (target.id === 'import-file') await readFile(target.files[0]);
  } catch (error) { toast(error.message, true); }
});
document.addEventListener('input', event => { if (event.target.id === 'library-search') { state.query = event.target.value; $('#library-tree').innerHTML = treeMarkup(state.roots, { query: state.query.toLowerCase() }) || '<div class="empty-state">No matches. Try a different title or URL.</div>'; updateMixed(); } });
document.addEventListener('keydown', event => { if (event.target.id === 'drop-zone' && ['Enter', ' '].includes(event.key)) { event.preventDefault(); $('#import-file').click(); } });
document.addEventListener('dragover', event => { if (state.view === 'import' && !state.busy) { event.preventDefault(); $('#drop-zone')?.classList.add('drag-over'); } });
document.addEventListener('dragleave', event => { if (event.target.id === 'drop-zone') event.target.classList.remove('drag-over'); });
document.addEventListener('drop', async event => { if (state.view !== 'import' || state.busy) return; event.preventDefault(); try { await readFile(event.dataTransfer.files[0]); } catch (error) { toast(error.message, true); } });

if (demo) { $('#demo-badge').hidden = false; $('#demo-badge').textContent = 'DEMO · SAMPLE BOOKMARKS'; }
try { await loadTree(true); render(); } catch (error) { $('#workspace').innerHTML = `<div class="notice warning"><div><strong>Couldn’t read your bookmarks</strong><p>${esc(error.message)}</p><p>Load this folder as an unpacked extension, then click its toolbar icon.</p></div></div>`; }
