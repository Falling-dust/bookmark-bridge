export const JOURNAL_CHUNK_SIZE = 100;
export const MAX_IMPORT_WRITES = 5_000;
const CURRENT_JOURNAL_VERSION = 2;
const RETAINED_FINISHED_JOBS = 20;
const MAX_JOURNAL_RECORDS = 100_000;
const FINISHED_STATUSES = new Set(['undone', 'failed-empty']);
const WRITE_ACTIONS = new Set(['create-folder', 'create-bookmark', 'update-bookmark']);
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
  const history = (await api.storage.local.get('importHistory')).importHistory ?? [];
  if (!Array.isArray(history)) throw new Error('Import history is damaged. No bookmarks were changed.');
  const ids = new Set();
  for (const job of history) {
    if (!job || typeof job.id !== 'string' || !job.id || ids.has(job.id)) {
      throw new Error('Import history is damaged. No bookmarks were changed.');
    }
    ids.add(job.id);
  }
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
      const count = job[stream.count];
      if (!Number.isInteger(count) || count < 0 || count > MAX_JOURNAL_RECORDS || job[stream.chunks] !== Math.ceil(count / JOURNAL_CHUNK_SIZE)) {
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
      } else if (stream.field === 'updated' && job.updated === undefined) {
        job.updated = [];
      } else if (!Array.isArray(job[stream.field])) {
        throw new Error('An import undo journal is damaged. No bookmarks were changed.');
      }
    }
    for (const record of job.created) {
      if (!record || typeof record.id !== 'string' || !record.id || typeof record.parentId !== 'string' || typeof record.title !== 'string' || (record.url !== undefined && typeof record.url !== 'string')) {
        throw new Error('An import creation journal is damaged. No bookmarks were changed.');
      }
    }
    for (const record of job.updated) {
      if (!record || typeof record.id !== 'string' || !record.id || !isBookmarkSnapshot(record.before) || !isBookmarkSnapshot(record.after)) {
        throw new Error('An import update journal is damaged. No bookmarks were changed.');
      }
    }
    journalCache.set(job, cache);
    return job;
  });
}

export async function saveJob(api, job) {
  const history = await rawHistory(api);
  const index = history.findIndex(item => item.id === job.id);
  const previous = index < 0 ? null : history[index];
  const { created, updated, ...details } = job;
  const summary = { ...details, journalVersion: CURRENT_JOURNAL_VERSION };
  for (const stream of streams) {
    summary[stream.count] = job[stream.field].length;
    summary[stream.chunks] = Math.ceil(job[stream.field].length / JOURNAL_CHUNK_SIZE);
  }
  if (index < 0) history.unshift(summary);
  else history[index] = summary;
  // Unfinished undo records must remain available even beyond the display limit.
  const retained = history.filter((item, i) => i < RETAINED_FINISHED_JOBS || !FINISHED_STATUSES.has(item.status));
  const updates = { importHistory: retained };
  const cached = journalCache.get(job) || {};
  const nextCache = {};
  // Record arrays are append-only during import and replaced after undo. This
  // lets status writes skip chunks and appends rewrite only their active chunk.
  for (const stream of streams) {
    const records = job[stream.field];
    const prior = cached[stream.field];
    const unchanged = prior?.records === records && prior.length === records.length;
    if (!unchanged) {
      const firstChunk = prior?.records === records && prior.length < records.length ? Math.floor(prior.length / JOURNAL_CHUNK_SIZE) : 0;
      for (let i = firstChunk; i < summary[stream.chunks]; i++) {
        updates[stream.key(job.id, i)] = records.slice(i * JOURNAL_CHUNK_SIZE, (i + 1) * JOURNAL_CHUNK_SIZE);
      }
    }
    nextCache[stream.field] = { records, length: records.length };
  }
  await api.storage.local.set(updates);
  journalCache.set(job, nextCache);
  const obsolete = [];
  for (const stream of streams) {
    for (let i = summary[stream.chunks]; i < (previous?.[stream.chunks] || 0); i++) obsolete.push(stream.key(job.id, i));
  }
  const retainedJobs = new Set(retained);
  for (const removed of history) {
    if (retainedJobs.has(removed)) continue;
    for (const stream of streams) {
      for (let i = 0; i < (removed[stream.chunks] || 0); i++) obsolete.push(stream.key(removed.id, i));
    }
  }
  // Metadata stops referencing obsolete chunks before cleanup. A cleanup error
  // cannot justify forgetting an ownership record or repeating a bookmark edit.
  if (obsolete.length && api.storage.local.remove) {
    try {
      await api.storage.local.remove(obsolete);
    } catch {
      // Quota checks still include chunks whose cleanup failed.
    }
  }
}

export async function checkJournalCapacity(api, plan, filename) {
  const writes = plan.actions.filter(action => WRITE_ACTIONS.has(action.type));
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

export function isBookmarkSnapshot(value) {
  return Boolean(value && typeof value.parentId === 'string' && typeof value.title === 'string' && typeof value.url === 'string');
}
