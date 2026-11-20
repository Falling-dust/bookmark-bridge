import { escapeHtml, icon } from './html.js';

function historyItem(job) {
  const finished = ['undone', 'failed-empty'].includes(job.status);
  const { bookmarks = 0, folders = 0, updated = 0 } = job.stats || {};
  return `<article class="history-item"><span class="tree-icon">${icon()}</span>
    <div class="history-details"><strong>${escapeHtml(job.filename)}</strong>
      <p>${escapeHtml(new Date(job.startedAt).toLocaleString())} · ${bookmarks} bookmarks · ${folders} folders · ${updated} updates</p>
      <span class="badge">${escapeHtml(job.status.replaceAll('-', ' '))}</span>
      ${job.error ? `<p class="error-text">${escapeHtml(job.error)}</p>` : ''}
      ${job.preserved ? `<p>${job.preserved} changed or unavailable items preserved.</p>` : ''}
      ${job.recoveryWarning ? `<p>${escapeHtml(job.recoveryWarning)}</p>` : ''}
    </div>${finished ? '<span class="muted">No action needed</span>' : `<button class="button secondary small"
      data-undo="${escapeHtml(job.id)}">${job.status === 'undo-partial' ? 'Retry undo' : 'Undo import'}</button>`}</article>`;
}

export function historyMarkup(history) {
  if (!history.length) return `<section class="panel empty-state"><p>No imports in this browser profile yet.</p>
    <button class="button secondary" data-view="import">Import bookmarks</button></section>`;
  return `<section class="panel history-list">${history.map(historyItem).join('')}</section>`;
}
