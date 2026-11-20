import { buildImportPlan } from './planner.js';
import { getHistory, saveJob, checkJournalCapacity, isBookmarkSnapshot } from './journal.js';

export { getHistory, JOURNAL_CHUNK_SIZE, MAX_IMPORT_WRITES } from './journal.js';

function bookmarkStateMatches(node, record) {
  return node.parentId === record.parentId && node.title === record.title && node.url === record.url;
}
function bookmarkSnapshot({ parentId, title, url }) {
  return { parentId, title, url };
}
async function readBookmarkIfPresent(api, id) {
  try {
    return (await api.bookmarks.get(id))[0];
  } catch (error) {
    // A failed lookup alone does not prove deletion. Preserve the undo record
    // unless the full tree confirms the ID is absent.
    const tree = await api.bookmarks.getTree();
    const contains = nodes => nodes.some(node => node.id === id || (node.children && contains(node.children)));
    if (contains(tree)) throw error;
    return null;
  }
}
async function recoverPending(api, job) {
  if (!job.pending) return;
  if (job.pending.type === 'update') {
    const { id, before, after, key } = job.pending;
    if (!id || !isBookmarkSnapshot(before) || !isBookmarkSnapshot(after)) throw new Error('The pending bookmark update is incomplete.');
    const node = await readBookmarkIfPresent(api, id);
    if (node && !bookmarkStateMatches(node, before)) {
      const canonical = { ...after, url: new URL(after.url).href };
      const confirmed = bookmarkStateMatches(node, after) || bookmarkStateMatches(node, canonical);
      job.updated.push({ id, key, before, after: confirmed ? bookmarkSnapshot(node) : after });
      if (!confirmed) job.recoveryWarning = 'A bookmark changed while an update was interrupted. Review its current details.';
    }
    job.pending = null;
    return;
  }
  // Never guess ownership from a matching title/URL: a user or sync client could
  // have created that same bookmark between the API call and the journal write.
  job.recoveryWarning = 'A creation was interrupted before its ID was saved. Any unconfirmed item was preserved; review the destination manually.';
  job.pending = null;
}
async function applyUpdate(api, job, action, actualUpdates) {
  const id = action.existingId;
  // A browser may canonicalize the URL it returns. Use that actual snapshot
  // when the same bookmark is updated again in this transaction.
  const before = actualUpdates.get(id) || action.before;
  const url = action.resolution === 'merge' ? before.url : action.url;
  const after = { parentId: before.parentId, title: action.title, url };
  const pending = { type: 'update', id, key: action.key, before, after };
  job.pending = pending;
  await saveJob(api, job);
  let live;
  try {
    [live] = await api.bookmarks.get(id);
  } catch (error) {
    job.pending = null;
    throw error;
  }
  if (!live || live.unmodifiable || !bookmarkStateMatches(live, before)) {
    job.pending = null;
    throw new Error('A matching bookmark changed. Review the import again.');
  }
  const changed = await api.bookmarks.update(id, { title: after.title, url });
  const actual = bookmarkSnapshot(changed);
  job.updated.push({ id, key: action.key, before, after: actual });
  actualUpdates.set(id, actual);
  job.pending = null;
  await saveJob(api, job);
}

async function applyCreation(api, job, action, folderRefs) {
  const parentId = folderRefs.get(action.parentRef) || action.parentRef;
  const details = {
    parentId,
    title: action.title,
    ...(action.type === 'create-bookmark' ? { url: action.url } : {}),
    ...(Number.isInteger(action.index) ? { index: action.index } : {}),
  };
  job.pending = details;
  await saveJob(api, job);
  const node = await api.bookmarks.create(details);
  folderRefs.set(action.key, node.id);
  job.created.push({
    id: node.id,
    parentId: node.parentId,
    title: node.title,
    ...(node.url !== undefined ? { url: node.url } : {}),
  });
  job.pending = null;
  await saveJob(api, job);
}

export async function runImport(api, { entries, options, expectedActions, filename = 'Bookmark import' }) {
  const history = await getHistory(api);
  if (history.some(job => ['running', 'undoing'].includes(job.status))) throw new Error('An earlier operation was interrupted. Use History to undo it before importing again.');
  const plan = buildImportPlan({ entries, existingTree: await api.bookmarks.getTree(), ...options });
  if (JSON.stringify(plan.actions) !== expectedActions) throw new Error('Your bookmarks changed after the preview. Refresh the preview before importing.');
  if (plan.actions.some(action => action.type === 'unresolved')) throw new Error('Resolve every matching bookmark in the preview before importing.');
  await checkJournalCapacity(api, plan, filename);
  const job = { id: crypto.randomUUID(), filename, startedAt: Date.now(), status: 'running', stats: plan.stats, created: [], updated: [], pending: null };
  await saveJob(api, job);
  const folderRefs = new Map();
  const actualUpdates = new Map();
  try {
    for (const action of plan.actions) {
      if (action.type === 'update-bookmark') {
        await applyUpdate(api, job, action, actualUpdates);
      } else if (action.type === 'create-folder' || action.type === 'create-bookmark') {
        await applyCreation(api, job, action, folderRefs);
      }
    }
    job.status = 'complete';
    job.finishedAt = Date.now();
    await saveJob(api, job);
    return job;
  } catch (error) {
    try {
      await recoverPending(api, job);
    } catch {
      // Keep unresolved intent available for recovery from History.
    }
    job.status = job.created.length || job.updated.length || job.pending ? 'partial' : 'failed-empty';
    job.error = error.message;
    await saveJob(api, job);
    throw new Error(`Import stopped: ${error.message}. ${job.created.length} items were created and ${job.updated.length} updates were recorded. Open History to review or undo this import.`);
  }
}
async function undoUpdates(api, job) {
  const groups = new Map();
  for (const record of job.updated) {
    const group = groups.get(record.id);
    if (group) group.after = record.after;
    else groups.set(record.id, { before: record.before, after: record.after });
  }
  const preserve = new Set();
  let restored = 0;
  for (const [id, group] of groups) {
    try {
      const node = await readBookmarkIfPresent(api, id);
      if (!node || bookmarkStateMatches(node, group.before)) continue;
      if (!node.unmodifiable && bookmarkStateMatches(node, group.after)) {
        await api.bookmarks.update(id, { title: group.before.title, url: group.before.url });
        restored++;
      } else preserve.add(id);
    } catch {
      // A failed read or write can be retried from History.
      preserve.add(id);
    }
  }
  job.updated = job.updated.filter(record => preserve.has(record.id));
  job.restored = (job.restored || 0) + restored;
  return preserve.size;
}

async function undoCreations(api, records) {
  let removed = 0;
  const preserved = [];
  for (const record of [...records].reverse()) {
    let node;
    try {
      node = await readBookmarkIfPresent(api, record.id);
    } catch {
      preserved.push(record);
      continue;
    }
    if (!node) continue;
    if (!bookmarkStateMatches(node, record)) {
      preserved.push(record);
      continue;
    }
    try {
      if (node.url === undefined && (await api.bookmarks.getChildren(node.id)).length) {
        preserved.push(record);
        continue;
      }
      // remove (never removeTree) prevents deletion of folders with newly added content.
      await api.bookmarks.remove(node.id);
      removed++;
    } catch {
      preserved.push(record);
    }
  }
  return { removed, preserved: preserved.reverse() };
}

export async function undoImport(api, id) {
  const job = (await getHistory(api)).find(item => item.id === id);
  if (!job) throw new Error('This import is no longer in history.');
  if (job.status === 'undone') throw new Error('This import was already undone.');
  await recoverPending(api, job);
  job.status = 'undoing';
  await saveJob(api, job);
  const preservedUpdates = await undoUpdates(api, job);
  const { removed, preserved } = await undoCreations(api, job.created);
  job.status = preserved.length || preservedUpdates ? 'undo-partial' : 'undone';
  job.undoAt = Date.now();
  job.removed = (job.removed || 0) + removed;
  job.preserved = preserved.length + preservedUpdates;
  job.created = preserved;
  await saveJob(api, job);
  return job;
}
