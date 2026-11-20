import { countNodes, selectableIds } from '../lib/selection.js';
import { escapeHtml, icon, reorderButtons } from './html.js';

function matches(node, query) {
  return `${node.title} ${node.url || ''}`.toLowerCase().includes(query)
    || node.children?.some(child => matches(child, query));
}

function domainLabel(url) {
  try {
    const parsed = new URL(url);
    return parsed.hostname || parsed.protocol;
  } catch {
    return url;
  }
}

export function treeMarkup(nodes, { source, selection, expanded, reorder = false, query = '' }) {
  function renderLevel(siblings, depth, filter) {
    const visible = filter ? siblings.filter(node => matches(node, filter)) : siblings;
    return visible.map((node, index) => {
      const folder = node.url === undefined;
      const title = escapeHtml(node.title || 'Untitled');
      const id = escapeHtml(node.id);
      const ids = selectableIds(node);
      const selected = ids.filter(key => selection.has(key)).length;
      const open = reorder || expanded.has(node.id) || Boolean(filter);
      const domain = folder ? '' : domainLabel(node.url);
      const toggle = node.children?.length && !reorder
        ? `<button class="tree-toggle" data-action="expand" data-source="${source}" data-id="${id}"
              aria-label="${open ? 'Collapse' : 'Expand'} ${title}" aria-expanded="${open}">${open ? '⌄' : '›'}</button>`
        : '<span class="tree-toggle-spacer"></span>';
      const check = reorder ? '' : `<input class="tree-check" type="checkbox" data-action="select-node"
        data-source="${source}" data-id="${id}" aria-label="Select ${title}" ${selected === ids.length ? 'checked' : ''}
        ${selected && selected !== ids.length ? 'data-mixed' : ''}>`;
      const siteIcon = escapeHtml((domain || node.title || '?')[0].toUpperCase());
      const row = `<div class="tree-row${selected ? ' is-selected' : ''}" style="--depth:${depth}" data-node-id="${id}">
        ${toggle}${check}<span class="tree-icon${folder ? '' : ' site-icon'}">${folder ? icon() : siteIcon}</span>
        <span class="tree-content"><span class="tree-title" title="${title}">${title}</span>
          ${folder ? '' : `<span class="tree-url" title="${escapeHtml(node.url)}">${escapeHtml(domain)}</span>`}
        </span>
        ${folder && !reorder ? `<span class="tree-meta">${countNodes(node.children || []).bookmarks} links</span>` : ''}
        ${reorder ? reorderButtons(node, source, index, visible.length) : ''}
      </div>`;
      if (!node.children?.length || !open) return row;
      const childFilter = filter && node.title.toLowerCase().includes(filter) ? '' : filter;
      return row + renderLevel(node.children, depth + 1, childFilter);
    }).join('');
  }
  return renderLevel(nodes, 0, query.toLowerCase());
}

export function updateMixedCheckboxes(container) {
  for (const checkbox of container.querySelectorAll('[data-mixed]')) checkbox.indeterminate = true;
}
