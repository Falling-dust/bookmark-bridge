import { countNodes, exportSelection } from '../lib/selection.js';
import { escapeHtml, icon, option } from './html.js';
import { treeMarkup } from './tree.js';

export function libraryMarkup(state) {
  const tree = treeMarkup(state.roots, {
    source: 'export', selection: state.chosen, expanded: state.expanded, query: state.query,
  });
  if (tree) return tree;
  return state.query ? '<p class="empty-state">No matches. Try a different title or URL.</p>'
    : '<p class="empty-state">Your bookmark library is empty.</p>';
}

export function exportMarkup(state) {
  const selected = exportSelection(state);
  const { bookmarks, folders } = countNodes(selected);
  const selection = selected.length
    ? treeMarkup(selected, { source: 'export', selection: state.chosen, expanded: state.expanded, reorder: true })
    : `<div class="empty-state"><span class="empty-icon">${icon('bookmark')}</span>
         <p>Select bookmarks or folders from your library.</p></div>`;
  return `<div class="split-layout">
    <section class="panel">
      <div class="panel-header"><h2>Your library</h2></div>
      <div class="toolbar">
        <input id="library-search" class="search-input" type="search" placeholder="Search titles and URLs"
          aria-label="Search bookmarks and folders" value="${escapeHtml(state.query)}">
        <button class="button ghost small" data-action="select-all">Select all</button>
        <button class="button ghost small" data-action="clear-selection">Clear</button>
      </div>
      <div class="tree library-tree" id="library-tree">${libraryMarkup(state)}</div>
      <p class="panel-footer footer-note">Selecting a folder includes its nested bookmarks.</p>
    </section>
    <aside class="panel">
      <div class="panel-header"><h2>Your export</h2><span class="badge">${bookmarks} links · ${folders} folders</span></div>
      <div class="selection-list" id="export-selection">${selection}</div>
      <div class="panel-body export-options">
        <p class="field-hint">Use ↑ and ↓ to set the exported order.</p>
        <label class="check-field"><input type="checkbox" id="preserve-folders" ${state.preserveFolders ? 'checked' : ''}> Keep folder structure</label>
        <label class="check-field"><input type="checkbox" id="include-roots" ${state.includeRoots ? 'checked' : ''}
          ${!state.preserveFolders ? 'disabled' : ''}> Include browser root folders</label>
        <label class="field"><span class="field-label">File format</span><select class="select" id="export-format">
          ${option('html', 'HTML · browser import', state.format === 'html')}
          ${option('json', 'JSON · Bookmark Bridge backup', state.format === 'json')}
        </select></label>
        <button class="button primary full-width" id="export-button" ${!selected.length ? 'disabled' : ''}>
          Export ${bookmarks} bookmark${bookmarks === 1 ? '' : 's'}</button>
      </div>
    </aside>
  </div>`;
}
