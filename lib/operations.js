import { buildImportPlan } from './planner.js';

export const JOURNAL_CHUNK_SIZE = 100;
export const MAX_IMPORT_WRITES = 5_000;
const journalCache = new WeakMap();
const encoder = new TextEncoder();
const byteSize = value => encoder.encode(JSON.stringify(value)).byteLength;
const chunkKey = (id, index) => `importJournal:${id}:${index}`;
const updateChunkKey = (id, index) => `importUpdates:${id}:${index}`;
const streams = [
  { field: 'created', count: 'createdCount', chunks: 'createdChunkCount', key: chunkKey },
  { field: 'updated', count: 'updatedCount', chunks: 'updatedChunkCount', key: updateChunkKey },
];

async function rawHistory(api) {
  const history = (await api.storage.local.get('importHistory')).importHistory || [];
  if (!Array.isArray(history)) throw new Error('Import history is damaged. No bookmarks were changed.');
  return history;
}

export async function getHistory(api) {
  const history = await rawHistory(api);
  const keys = [];
  for (const job of history) {
    if (job.journalVersion === undefined) continue;
    if (![1, 2].includes(job.journalVersion)) throw new Error('This import journal requires a newer extension version. No bookmarks were changed.');
    for (const stream of streams) {
      if (stream.field === 'updated' && job.journalVersion === 1) continue;
      if (!Number.isInteger(job[stream.count]) || job[stream.count] < 0 || job[stream.count] > 100_000 || job[stream.chunks] !== Math.ceil(job[stream.count] / JOURNAL_CHUNK_SIZE)) {
        throw new Error('An import undo journal is damaged. No bookmarks were changed.');
      }
      for (let i = 0; i < job[stream.chunks]; i++) keys.push(stream.key(job.id, i));
    }
  }
  const chunks = keys.length ? await api.storage.local.get(keys) : {};
  return history.map(stored => {
    const { journalVersion, createdChunkCount, createdCount, updatedCount, updatedChunkCount, ...job } = stored;
    const cache = {};
    for (const stream of streams) {
      if (journalVersion && !(journalVersion === 1 && stream.field === 'updated')) {
        job[stream.field] = [];
        for (let i = 0; i < stored[stream.chunks]; i++) {
          const chunk = chunks[stream.key(job.id, i)];
          const expectedLength = Math.min(JOURNAL_CHUNK_SIZE, stored[stream.count] - i * JOURNAL_CHUNK_SIZE);
          if (!Array.isArray(chunk) || chunk.length !== expectedLength) throw new Error('An import undo journal is incomplete. No bookmarks were changed.');
          job[stream.field].push(...chunk);
        }
        cache[stream.field] = { records: job[stream.field], length: job[stream.field].length };
      } else if (stream.field === 'updated' && job.updated === undefined) job.updated = [];
      else if (!Array.isArray(job[stream.field])) throw new Error('An import undo journal is damaged. No bookmarks were changed.');
    }
    for (const record of job.updated) {
      if (!record || typeof record.id !== 'string' || !validSnapshot(record.before) || !validSnapshot(record.after)) {
        throw new Error('An import update journal is damaged. No bookmarks were changed.');
      }
    }
    journalCache.set(job, cache);
    return job;
  });
}

async function saveJob(api, job) {
  const history = await rawHistory(api);
  const index = history.findIndex(item => item.id === job.id);
  const previous = index < 0 ? null : history[index];
  const { created, updated, ...details } = job;
  const summary = { ...details, journalVersion: 2 };
  for (const stream of streams) {
    summary[stream.count] = job[stream.field].length;
    summary[stream.chunks] = Math.ceil(job[stream.field].length / JOURNAL_CHUNK_SIZE);
  }
  if (index < 0) history.unshift(summary); else history[index] = summary;
  // Retain all non-undone imports, since their IDs are needed for safe undo.
  const retained = history.filter((item, i) => i < 20 || !['undone', 'failed-empty'].includes(item.status));
  const updates = { importHistory: retained };
  const cached = journalCache.get(job) || {};
  const nextCache = {};
  // Appending changes at most one small chunk; saving pending/status metadata
  // never serializes the entire ownership list. Rebuilt undo lists rewrite once.
  for (const stream of streams) {
    const records = job[stream.field], prior = cached[stream.field];
    const unchanged = prior?.records === records && prior.length === records.length;
    if (!unchanged) {
      const firstChunk = prior?.records === records && prior.length < records.length ? Math.floor(prior.length / JOURNAL_CHUNK_SIZE) : 0;
      for (let i = firstChunk; i < summary[stream.chunks]; i++) updates[stream.key(job.id, i)] = records.slice(i * JOURNAL_CHUNK_SIZE, (i + 1) * JOURNAL_CHUNK_SIZE);
    }
    nextCache[stream.field] = { records, length: records.length };
  }
  await api.storage.local.set(updates);
  journalCache.set(job, nextCache);
  const obsolete = [];
  for (const stream of streams) {
    for (let i = summary[stream.chunks]; i < (previous?.[stream.chunks] || 0); i++) obsolete.push(stream.key(job.id, i));
  }
  for (const removed of history.filter(item => !retained.includes(item))) {
    for (const stream of streams) for (let i = 0; i < (removed[stream.chunks] || 0); i++) obsolete.push(stream.key(removed.id, i));
  }
  // Metadata stops referencing obsolete chunks before cleanup. A cleanup error
  // cannot justify forgetting an ownership record or repeating a bookmark edit.
  if (obsolete.length && api.storage.local.remove) {
    try { await api.storage.local.remove(obsolete); } catch { /* A later storage preflight still counts these bytes. */ }
  }
}

async function checkJournalCapacity(api, plan, filename) {
  const writes = plan.actions.filter(action => ['create-folder', 'create-bookmark', 'update-bookmark'].includes(action.type));
  if (writes.length > MAX_IMPORT_WRITES) throw new Error(`This import would create or update ${writes.length.toLocaleString()} items. Select at most ${MAX_IMPORT_WRITES.toLocaleString()} changes per import, then import the remaining items in another batch.`);
  let estimatedRecords = 0;
  let largestRecord = 0;
  for (const action of writes) {
    // Returned browser IDs and normalized URLs can be longer than their inputs.
    const after = { parentId: '0'.repeat(64), title: action.title, ...(action.url === undefined ? {} : { url: new URL(action.url).href }) };
    const record = action.type === 'update-bookmark' ? { id: action.existingId, key: action.key, before: action.before, after } : { id: '0'.repeat(64), ...after };
    const bytes = byteSize(record) * 3 + 64;
    estimatedRecords += bytes;
    largestRecord = Math.max(largestRecord, bytes);
  }
  const storage = api.storage.local;
  const used = storage.getBytesInUse ? await storage.getBytesInUse(null) : byteSize(await storage.get(null));
  const quota = Number.isFinite(storage.QUOTA_BYTES) && storage.QUOTA_BYTES > 0 ? storage.QUOTA_BYTES : 5 * 1024 * 1024;
  const safeLimit = quota - Math.max(64 * 1024, Math.floor(quota * 0.1));
  const additional = estimatedRecords + largestRecord + byteSize(filename) + Math.ceil(writes.length / JOURNAL_CHUNK_SIZE) * 128 + 8_192;
  if (used + additional > safeLimit) throw new Error('There is not enough local storage to safely retain undo data for this import. Choose a smaller selection. No bookmarks were changed.');
}
function matching(node, record) {
  return node.parentId === record.parentId && node.title === record.title && node.url === record.url;
}
function snapshot({ parentId, title, url }) {
  return { parentId, title, url };
}
function validSnapshot(value) {
  return value && typeof value.parentId === 'string' && typeof value.title === 'string' && typeof value.url === 'string';
}
async function readForUndo(api, id) {
  try { return (await api.bookmarks.get(id))[0]; }
  catch (error) {
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
    if (!id || !validSnapshot(before) || !validSnapshot(after)) throw new Error('The pending bookmark update is incomplete.');
    const node = await readForUndo(api, id);
    if (node && !matching(node, before)) {
      const canonical = { ...after, url: new URL(after.url).href };
      const confirmed = matching(node, after) || matching(node, canonical);
      job.updated.push({ id, key, before, after: confirmed ? snapshot(node) : after });
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
  try { [live] = await api.bookmarks.get(id); }
  catch (error) { job.pending = null; throw error; }
  if (!live || live.unmodifiable || !matching(live, before)) {
    job.pending = null;
    throw new Error('A matching bookmark changed. Review the import again.');
  }
  const changed = await api.bookmarks.update(id, { title: after.title, url });
  const actual = snapshot(changed);
  job.updated.push({ id, key: action.key, before, after: actual });
  actualUpdates.set(id, actual);
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
  const refs = new Map();
  const actualUpdates = new Map();
  try {
    for (const action of plan.actions) {
      if (action.type === 'update-bookmark') {
        await applyUpdate(api, job, action, actualUpdates);
        continue;
      }
      if (!['create-folder', 'create-bookmark'].includes(action.type)) continue;
      const parentId = refs.get(action.parentRef) || action.parentRef;
      const details = { parentId, title: action.title, ...(action.type === 'create-bookmark' ? { url: action.url } : {}), ...(Number.isInteger(action.index) ? { index: action.index } : {}) };
      job.pending = { ...details };
      await saveJob(api, job);
      const node = await api.bookmarks.create(details);
      refs.set(action.key, node.id);
      job.created.push({ id: node.id, parentId: node.parentId, title: node.title, ...(node.url !== undefined ? { url: node.url } : {}) });
      job.pending = null;
      await saveJob(api, job);
    }
    job.status = 'complete';
    job.finishedAt = Date.now();
    await saveJob(api, job);
    return job;
  } catch (error) {
    try { await recoverPending(api, job); } catch { /* Keep the pending record for the next recovery attempt. */ }
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
      const node = await readForUndo(api, id);
      if (!node || matching(node, group.before)) continue;
      if (!node.unmodifiable && matching(node, group.after)) {
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
export async function undoImport(api, id) {
  const job = (await getHistory(api)).find(item => item.id === id);
  if (!job) throw new Error('This import is no longer in history.');
  if (job.status === 'undone') throw new Error('This import was already undone.');
  await recoverPending(api, job);
  job.status = 'undoing';
  await saveJob(api, job);
  const preservedUpdates = await undoUpdates(api, job);
  let removed = 0;
  const preserved = [];
  for (const record of [...job.created].reverse()) {
    let node;
    try { [node] = await api.bookmarks.get(record.id); }
    catch {
      // A transient read failure is not evidence that the bookmark was deleted.
      try {
        const tree = await api.bookmarks.getTree();
        const contains = nodes => nodes.some(item => item.id === record.id || (item.children && contains(item.children)));
        if (contains(tree)) preserved.push(record);
      } catch { preserved.push(record); }
      continue;
    }
    if (!node) continue;
    if (!matching(node, record)) { preserved.push(record); continue; }
    try {
      if (node.url === undefined && (await api.bookmarks.getChildren(node.id)).length) { preserved.push(record); continue; }
      // remove (never removeTree) prevents deletion of folders with newly added content.
      await api.bookmarks.remove(node.id);
      removed++;
    } catch { preserved.push(record); }
  }
  job.status = preserved.length || preservedUpdates ? 'undo-partial' : 'undone';
  job.undoAt = Date.now();
  job.removed = (job.removed || 0) + removed;
  job.preserved = preserved.length + preservedUpdates;
  job.created = preserved.reverse();
  await saveJob(api, job);
  return job;
}
