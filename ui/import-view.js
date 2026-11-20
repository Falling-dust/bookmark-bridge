import { countNodes, selectedTree } from '../lib/selection.js';
import { escapeHtml, icon, option, reorderButtons } from './html.js';
import { treeMarkup } from './tree.js';
import { duplicateReviewMarkup } from './duplicate-review.js';

function destinationOptions(folders) {
  const cache = new Map();
  const ids = new Set(folders.map(folder => folder.id));
  return value => {
    if (!cache.has(value)) {
      const missing = value && !ids.has(value) ? option(value, 'Unavailable folder — choose again', true, true) : '';
      cache.set(value, missing + folders.map(folder => option(folder.id, folder.label, value === folder.id)).join(''));
    }
    return cache.get(value);
  };
}

function placementMarkup(state, selected, options) {
  if (!selected.length) return '';
  const items = selected.map((node, index) => `<div class="placement-item">
    <div class="placement-title"><span class="tree-icon">${icon(node.children ? 'folder' : 'bookmark')}</span>
      <strong>${escapeHtml(node.title || 'Untitled')}</strong>${reorderButtons(node, 'import', index, selected.length)}</div>
    <select class="select destination-select" aria-label="Destination for ${escapeHtml(node.title)}"
      data-destination="${escapeHtml(node.id)}">${options(state.destinations[node.id] || state.defaultDestination)}</select>
  </div>`);
  return `<div class="panel-header"><div><h3>Destinations</h3><p class="panel-subtitle">Choose a folder for each top-level item.</p></div></div>
    <div class="placement-list">${items.join('')}</div>`;
}

function preference(id, label, options, hint = '', disabled = false) {
  return `<label class="field"><span class="field-label">${label}</span>
    <select class="select" id="${id}" ${disabled ? 'disabled' : ''}>${options}</select>
    ${hint ? `<span class="field-hint">${hint}</span>` : ''}</label>`;
}

function preferencesMarkup(state, options, canPreview) {
  const choices = (current, items) => items.map(([value, label]) => option(value, label, value === current)).join('');
  return `<aside class="panel import-settings"><div class="panel-header"><h2>Import preferences</h2></div><div class="panel-body">
    ${preference('default-destination', 'Default destination', options(state.defaultDestination), 'Used for items without an individual destination.')}
    ${preference('duplicate-policy', 'When a URL already exists', choices(state.duplicatePolicy, [
      ['skip', 'Skip the incoming duplicate'], ['keep', 'Keep both bookmarks'], ['review', 'Review each match'],
    ]))}
    ${preference('duplicate-scope', 'Look for duplicates', choices(state.duplicateScope, [
      ['destination', 'In each destination folder'], ['global', 'Across the whole browser'],
    ]), 'Query strings, fragments and trailing slashes are significant.', state.duplicatePolicy === 'keep')}
    <label class="check-field"><input type="checkbox" id="merge-folders" ${state.mergeFolders ? 'checked' : ''}> Merge folders with identical names</label>
    ${preference('insert-position', 'Place new items', choices(state.position, [
      ['end', 'At the end of each folder'], ['start', 'At the beginning of each folder'],
    ]))}
    <button class="button primary full-width" id="preview-button" ${canPreview ? '' : 'disabled'}>Review import</button>
  </div></aside>`;
}

function warningsMarkup(warnings) {
  if (!warnings.length) return '';
  return `<div class="notice warning"><div><strong>Some entries need attention</strong>
    <p>${warnings.slice(0, 8).map(escapeHtml).join('<br>')}${warnings.length > 8 ? `<br>…and ${warnings.length - 8} more warnings.` : ''}</p>
  </div></div>`;
}

export function importMarkup(state) {
  const fileInput = '<input type="file" id="import-file" accept=".html,.htm,.json,text/html,application/json" hidden>';
  if (!state.filename) {
    return fileInput + `<section class="panel"><button type="button" class="drop-zone" id="drop-zone">
      <span class="upload-icon" aria-hidden="true">↑</span><strong>Choose a bookmark file</strong>
      <span>or drop it here. HTML or JSON, up to 20 MB.</span></button></section>`;
  }
  const selected = selectedTree(state.importNodes, state.importChosen);
  const folders = state.folders.filter(folder => !folder.locked);
  const options = destinationOptions(folders);
  const counts = countNodes(state.importNodes);
  const canUnwrap = selected.some(node => node.children?.length);
  const tree = treeMarkup(state.importNodes, { source: 'import', selection: state.importChosen, expanded: state.importExpanded });
  return fileInput + `<div class="file-banner">
    <span class="tree-icon">${icon('bookmark')}</span><div><strong>${escapeHtml(state.filename)}</strong>
    <p class="muted">${counts.bookmarks} bookmarks · ${counts.folders} folders</p></div>
    <button class="button secondary small" data-action="unwrap-import" ${canUnwrap ? '' : 'disabled'}
      title="Remove selected top-level folder wrappers to place their contents individually">Use folder contents</button>
    <button class="button secondary small" id="replace-file">Choose another file</button>
  </div><p class="field-hint">Use folder contents to remove one layer of selected folders. Reload the file to restore its original structure.</p>
  ${warningsMarkup(state.warnings)}
  <div class="split-layout">
    <section class="panel"><div class="panel-header"><h2>Incoming bookmarks</h2><div class="top-actions">
      <button class="button ghost small" data-action="import-all">All</button>
      <button class="button ghost small" data-action="import-none">None</button></div></div>
      <div class="tree incoming-tree">${tree || '<p class="empty-state">This file contains an empty collection.</p>'}</div>
      ${placementMarkup(state, selected, options)}
    </section>
    ${preferencesMarkup(state, options, selected.length && folders.length)}
  </div><div id="import-preview">${state.plan ? previewMarkup(state) : ''}</div>`;
}

const actionLabels = {
  'create-folder': 'New folder', 'create-bookmark': 'New bookmark', 'merge-folder': 'Merge folder',
  'update-bookmark': 'Update bookmark', unchanged: 'Already matches', unresolved: 'Choose an action', skip: 'Skip duplicate',
};
const previewLimit = 300;

export function previewMarkup(state) {
  const { plan } = state;
  const { actions, stats } = plan;
  const paths = new Map(state.folders.map(folder => [folder.id, folder.label]));
  const rows = [];
  for (const [index, action] of actions.entries()) {
    const parentPath = paths.get(action.parentRef) || action.parentRef;
    if (action.type === 'create-folder') paths.set(action.key, `${parentPath} / ${action.title}`);
    if (index >= previewLimit) continue;
    rows.push(`<div class="preview-row"><span class="badge">${actionLabels[action.type]}</span>
      <div><strong>${escapeHtml(action.title || 'Untitled')}</strong><p class="muted">${escapeHtml(parentPath)}
        ${action.reason ? ` · ${escapeHtml(action.reason)}` : ''}</p></div></div>`);
  }
  const totals = [[stats.bookmarks, 'New bookmarks'], [stats.folders, 'New folders'], [stats.merged, 'Folders merged'], [stats.skipped, 'Duplicates skipped']];
  if (state.duplicatePolicy === 'review') totals.push([stats.updated || 0, 'Bookmark updates']);
  const hasWrites = Boolean(stats.bookmarks || stats.folders || stats.updated);
  const needsChoice = actions.some(action => action.type === 'unresolved');
  const hint = needsChoice ? 'Choose an action for each match to continue.'
    : hasWrites ? 'You can undo these changes from History.' : 'There are no changes to apply.';
  return `<section class="panel preview-panel"><div class="panel-header"><h2>Import preview</h2>
    <button class="button secondary small" id="download-plan">Save review</button></div>
    ${duplicateReviewMarkup({ plan, decisions: state.decisions, page: state.reviewPage, paths })}
    <div class="stats-grid">${totals.map(([value, label]) => `<div class="stat-card">
      <span class="stat-value">${value}</span><span class="stat-label">${label}</span></div>`).join('')}</div>
    <div class="preview-list">${rows.join('')}</div>
    ${actions.length > previewLimit ? `<p class="footer-note panel-body">Showing ${previewLimit} of ${actions.length} actions. Save review for the full list.</p>` : ''}
    <div class="panel-footer preview-footer"><p class="footer-note">${hint}</p>
    <button class="button primary" id="apply-import" ${!hasWrites || needsChoice ? 'disabled' : ''}>Apply import</button></div></section>`;
}
