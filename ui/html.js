import { escapeHtml } from '../lib/html.js';
export { escapeHtml };

export function option(value, label, selected = false, disabled = false) {
  return `<option value="${escapeHtml(value)}" ${selected ? 'selected' : ''} ${disabled ? 'disabled' : ''}>${escapeHtml(label)}</option>`;
}

export function icon(kind = 'folder') {
  const path = kind === 'folder'
    ? 'M3 7a2 2 0 0 1 2-2h5l2 2h7a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2Z'
    : 'M8 3h8a1 1 0 0 1 1 1v17l-5-4-5 4V4a1 1 0 0 1 1-1Z';
  return `<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="1.6" aria-hidden="true"><path d="${path}"/></svg>`;
}

export function reorderButtons(node, source, index, count) {
  const button = (direction, label, glyph, disabled) => `<button class="icon-button"
    data-action="reorder" data-source="${source}" data-id="${escapeHtml(node.id)}" data-direction="${direction}"
    aria-label="Move ${escapeHtml(node.title)} ${label}" title="Move ${label}" ${disabled ? 'disabled' : ''}>${glyph}</button>`;
  return `<span class="row-actions">${button(-1, 'up', '↑', index === 0)}${button(1, 'down', '↓', index === count - 1)}</span>`;
}
