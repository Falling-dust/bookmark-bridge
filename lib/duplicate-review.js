const pageSize = 20;

function option(value, label, selected, disabled, escape) {
  return `<option value="${escape(value)}" ${selected ? 'selected' : ''} ${disabled ? 'disabled' : ''}>${escape(label)}</option>`;
}

function bookmarkDetails(label, title, url, folder, escape) {
  return `<div class="match-bookmark">
    <span class="field-label">${escape(label)}</span>
    <strong>${escape(title || 'Untitled')}</strong>
    <span class="match-url">${escape(url)}</span>
    <span class="match-folder">${escape(folder)}</span>
  </div>`;
}

function matchCard(conflict, action, decision, paths, escape) {
  const { key, incomingTitle, incomingUrl, matches, choice } = conflict;
  const selectedId = decision?.targetId ?? conflict.targetId;
  const selected = matches.find(match => match.id === selectedId);
  // An obsolete explicit selection must be chosen again, even if one other copy remains.
  const target = selected || (!selectedId && (matches.find(match => !match.locked) || matches[0]));
  const localFolder = id => paths.get(id) || 'Browser library';
  const targetOptions = matches.map(match => option(match.id,
    `${localFolder(match.parentId)} / ${match.title || 'Untitled'}${match.locked ? ' (read-only)' : ''}`,
    match.id === target?.id, false, escape)).join('');
  const targetControl = matches.length > 1 || (matches.length && !target)
    ? `<label class="field"><span class="field-label">Matching local copy</span><select class="select" data-conflict-target="${escape(key)}">
          ${!target ? option('', 'Choose a local bookmark', true, true, escape) : ''}${targetOptions}</select></label>`
    : '';
  const canEdit = Boolean(target && !target.locked);
  const choices = [
    option('', 'Choose an action', !choice, false, escape),
    option('skip', 'Skip incoming', choice === 'skip', false, escape),
    option('keep', 'Keep both', choice === 'keep', false, escape),
  ];
  if (matches.length) {
    choices.push(option('replace', 'Replace local details', choice === 'replace', !canEdit, escape));
    choices.push(option('merge', 'Merge titles', choice === 'merge', !canEdit, escape));
  }
  let explanation = '';
  if (choice === 'keep') explanation = 'A copy will be added to the incoming destination.';
  else if (choice === 'skip') explanation = 'The incoming bookmark will be skipped.';
  else if (action?.type === 'unchanged') explanation = 'The local bookmark already has these details.';
  else if (action?.type === 'update-bookmark') explanation = `After import: ${action.title || 'Untitled'} — ${action.url}`;
  else if (target?.locked) explanation = 'This local bookmark is read-only. Choose Skip or Keep both.';
  else if (canEdit) explanation = 'Replace uses the incoming title and URL. Merge joins distinct titles and keeps the local URL.';
  return `<article class="match-card" data-conflict-row="${escape(key)}">
    <div class="match-compare">
      ${bookmarkDetails('Incoming bookmark', incomingTitle, incomingUrl, localFolder(conflict.parentRef), escape)}
      ${target ? bookmarkDetails('Matching local bookmark', target.title, target.url, localFolder(target.parentId), escape)
        : `<div class="match-bookmark"><span class="field-label">Match</span><p>${matches.length ? 'Choose a matching copy below.' : escape(action?.reason || 'This URL also occurs in the incoming file.')}</p></div>`}
    </div>
    <div class="match-controls">${targetControl}<label class="field"><span class="field-label">Action for ${escape(incomingTitle || incomingUrl)}</span>
      <select class="select" data-conflict-choice="${escape(key)}" data-current-target="${escape(target?.id || '')}">${choices.join('')}</select></label>
    </div>${explanation ? `<p class="match-result">${escape(explanation)}</p>` : ''}
  </article>`;
}

export function duplicateReviewMarkup({ plan, decisions, page, paths, escape }) {
  if (!plan.conflicts?.length) return '';
  const total = plan.conflicts.length;
  const remaining = plan.actions.filter(action => action.type === 'unresolved').length;
  const pages = Math.ceil(total / pageSize);
  const current = Math.min(Math.max(0, page), pages - 1);
  const actions = new Map(plan.actions.map(action => [action.conflictKey, action]));
  const cards = plan.conflicts.slice(current * pageSize, (current + 1) * pageSize).map(conflict =>
    matchCard(conflict, actions.get(conflict.key), decisions[conflict.key], paths, escape));
  return `<section class="duplicate-review" aria-label="Review matching bookmarks">
    <div class="match-heading"><div><h3 class="panel-title">Matching bookmarks</h3>
      <p class="panel-subtitle" role="status">${remaining ? `${remaining} of ${total} still need a choice.` : `All ${total} ${total === 1 ? 'match' : 'matches'} reviewed.`}</p></div>
      ${remaining > 1 ? '<button type="button" class="button secondary small" id="skip-remaining">Skip remaining matches</button>' : ''}
    </div>${cards.join('')}
    ${pages > 1 ? `<div class="match-pages"><button class="button secondary small" data-review-page="${current - 1}" ${current === 0 ? 'disabled' : ''}>Previous</button>
      <span>Page ${current + 1} of ${pages}</span><button class="button secondary small" data-review-page="${current + 1}" ${current + 1 >= pages ? 'disabled' : ''}>Next</button></div>` : ''}
  </section>`;
}
