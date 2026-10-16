import { buildImportPlan } from './planner.js';

export const JOURNAL_CHUNK_SIZE = 100;
export const MAX_IMPORT_WRITES = 5_000;
const journalCache = new WeakMap();
const encoder = new TextEncoder();
const byteSize = value => encoder.encode(JSON.stringify(value)).byteLength;
const chunkKey = (id, index) => `importJournal:${id}:${index}`;

async function rawHistory(api) {
  const history = (await api.storage.local.get('importHistory')).importHistory || [];
  if (!Array.isArray(history)) throw new Error('Import history is damaged. No bookmarks were changed.');
  return history;
}

export async function getHistory(api) {
  const history = await rawHistory(api);
  const keys = [];
  for (const job of history) {
    if (job.journalVersion !== 1) continue;
    if (!Number.isInteger(job.createdCount) || job.createdCount < 0 || job.createdCount > 100_000 || job.createdChunkCount !== Math.ceil(job.createdCount / JOURNAL_CHUNK_SIZE)) {
      throw new Error('An import undo journal is damaged. No bookmarks were changed.');
    }
    for (let i = 0; i < job.createdChunkCount; i++) keys.push(chunkKey(job.id, i));
  }
  const chunks = keys.length ? await api.storage.local.get(keys) : {};
  return history.map(stored => {
    const { journalVersion, createdChunkCount, createdCount, ...job } = stored;
    if (journalVersion === 1) {
      job.created = [];
      for (let i = 0; i < createdChunkCount; i++) {
        const chunk = chunks[chunkKey(job.id, i)];
        const expectedLength = Math.min(JOURNAL_CHUNK_SIZE, createdCount - i * JOURNAL_CHUNK_SIZE);
        if (!Array.isArray(chunk) || chunk.length !== expectedLength) throw new Error('An import undo journal is incomplete. No bookmarks were changed.');
        job.created.push(...chunk);
      }
      journalCache.set(job, { records: job.created, length: job.created.length });
    } else if (!Array.isArray(job.created)) {
      throw new Error('An import undo journal is damaged. No bookmarks were changed.');
    }
    return job;
  });
}

async function saveJob(api, job) {
  const history = await rawHistory(api);
  const index = history.findIndex(item => item.id === job.id);
  const previous = index < 0 ? null : history[index];
  const chunkCount = Math.ceil(job.created.length / JOURNAL_CHUNK_SIZE);
  const { created, ...details } = job;
  const summary = { ...details, journalVersion: 1, createdCount: created.length, createdChunkCount: chunkCount };
  if (index < 0) history.unshift(summary); else history[index] = summary;
  // Retain all non-undone imports, since their IDs are needed for safe undo.
  const retained = history.filter((item, i) => i < 20 || !['undone', 'failed-empty'].includes(item.status));
  const updates = { importHistory: retained };
  const cached = journalCache.get(job);
  // Appending changes at most one small chunk; saving pending/status metadata
  // never serializes the entire ownership list. Rebuilt undo lists rewrite once.
  const unchanged = cached?.records === created && cached.length === created.length;
  if (!unchanged) {
    const firstChunk = cached?.records === created && cached.length < created.length ? Math.floor(cached.length / JOURNAL_CHUNK_SIZE) : 0;
    for (let i = firstChunk; i < chunkCount; i++) updates[chunkKey(job.id, i)] = created.slice(i * JOURNAL_CHUNK_SIZE, (i + 1) * JOURNAL_CHUNK_SIZE);
  }
  await api.storage.local.set(updates);
  journalCache.set(job, { records: created, length: created.length });
  const obsolete = [];
  if (previous?.journalVersion === 1) {
    for (let i = chunkCount; i < previous.createdChunkCount; i++) obsolete.push(chunkKey(job.id, i));
  }
  for (const removed of history.filter(item => !retained.includes(item))) {
    if (removed.journalVersion === 1) for (let i = 0; i < removed.createdChunkCount; i++) obsolete.push(chunkKey(removed.id, i));
  }
  // Metadata stops referencing obsolete chunks before cleanup. A cleanup error
  // cannot justify forgetting an ownership record or repeating a bookmark edit.
  if (obsolete.length && api.storage.local.remove) {
    try { await api.storage.local.remove(obsolete); } catch { /* A later storage preflight still counts these bytes. */ }
  }
}

async function checkJournalCapacity(api, plan, filename) {
  const writes = plan.actions.filter(action => action.type === 'create-folder' || action.type === 'create-bookmark');
  if (writes.length > MAX_IMPORT_WRITES) throw new Error(`This import would create ${writes.length.toLocaleString()} items. Select at most ${MAX_IMPORT_WRITES.toLocaleString()} new bookmarks and folders per import, then import the remaining items in another batch.`);
  let estimatedRecords = 0;
  let largestRecord = 0;
  for (const action of writes) {
    // Returned browser IDs and normalized URLs can be longer than their inputs.
    const record = { id: '0'.repeat(64), parentId: '0'.repeat(64), title: action.title, ...(action.url === undefined ? {} : { url: new URL(action.url).href }) };
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
async function recoverPending(api, job) {
  if (!job.pending) return;
  // Never guess ownership from a matching title/URL: a user or sync client could
  // have created that same bookmark between the API call and the journal write.
  job.recoveryWarning = 'A creation was interrupted before its ID was saved. Any unconfirmed item was preserved; review the destination manually.';
  job.pending = null;
}
export async function runImport(api, { entries, options, expectedActions, filename = 'Bookmark import' }) {
  const history = await getHistory(api);
  if (history.some(job => ['running', 'undoing'].includes(job.status))) throw new Error('An earlier operation was interrupted. Use History to undo it before importing again.');
  const plan = buildImportPlan({ entries, existingTree: await api.bookmarks.getTree(), ...options });
  if (JSON.stringify(plan.actions) !== expectedActions) throw new Error('Your bookmarks changed after the preview. Refresh the preview before importing.');
  await checkJournalCapacity(api, plan, filename);
  const job = { id: crypto.randomUUID(), filename, startedAt: Date.now(), status: 'running', stats: plan.stats, created: [], pending: null };
  await saveJob(api, job);
  const refs = new Map();
  try {
    for (const action of plan.actions) {
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
    job.status = job.created.length || job.pending ? 'partial' : 'failed-empty';
    job.error = error.message;
    await saveJob(api, job);
    throw new Error(`Import stopped: ${error.message}. ${job.created.length} items were created. Open History to review or undo this import.`);
  }
}
export async function undoImport(api, id) {
  const job = (await getHistory(api)).find(item => item.id === id);
  if (!job) throw new Error('This import is no longer in history.');
  if (job.status === 'undone') throw new Error('This import was already undone.');
  await recoverPending(api, job);
  job.status = 'undoing';
  await saveJob(api, job);
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
  job.status = preserved.length ? 'undo-partial' : 'undone';
  job.undoAt = Date.now();
  job.removed = (job.removed || 0) + removed;
  job.preserved = preserved.length;
  job.created = preserved.reverse();
  await saveJob(api, job);
  return job;
}
