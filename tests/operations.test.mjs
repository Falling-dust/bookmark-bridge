import test from 'node:test';
import assert from 'node:assert/strict';
import { buildImportPlan } from '../lib/planner.js';
import { getHistory, runImport, undoImport, JOURNAL_CHUNK_SIZE, MAX_IMPORT_WRITES } from '../lib/operations.js';

const clone = value => structuredClone(value);
const bookmark = (title, url = `https://${title.toLowerCase()}.example/`) => ({ title, url });
const folder = (title, children = []) => ({ title, children });
const entry = (node, destinationId = '1') => ({ node, destinationId });

/** A stateful mock with Chrome-style structured cloning and nonrecursive remove. */
function makeApi({ history = [], failCreateAt = 0, failUpdateAt = 0, canonicalizeUpdates = false, quotaBytes = 10 * 1024 * 1024, storageOverhead = 0 } = {}) {
  const nodes = new Map();
  const data = { importHistory: clone(history) };
  const calls = { creates: [], updates: [], removes: [], storageWrites: 0, maxJournalChunk: 0, journalRecordsWritten: 0, maxUpdateChunk: 0, updateRecordsWritten: 0, storageRemovals: [] };
  let nextId = 100;
  function add(node, parentId) {
    const children = node.children;
    const record = { ...node, ...(parentId ? { parentId } : {}) };
    delete record.children;
    if (record.url === undefined) record.childIds = [];
    nodes.set(record.id, record);
    if (parentId) nodes.get(parentId).childIds.push(record.id);
    for (const child of children ?? []) add(child, record.id);
  }
  add({ id: '0', title: '', children: [
    { id: '1', title: 'Bookmarks bar', children: [
      { id: '10', title: 'Existing', url: 'https://existing.example/' },
      { id: '11', title: 'Work', children: [{ id: '12', title: 'Docs', url: 'https://docs.example/' }] },
    ] },
    { id: '2', title: 'Other bookmarks', children: [] },
  ] });
  function lookup(id) {
    if (!nodes.has(id)) throw new Error(`Can't find bookmark for id: ${id}`);
    return nodes.get(id);
  }
  function copyNode(id, recursive = false) {
    const node = lookup(id);
    const result = { ...node };
    delete result.childIds;
    if (node.parentId) result.index = lookup(node.parentId).childIds.indexOf(id);
    if (recursive && node.childIds) result.children = node.childIds.map(childId => copyNode(childId, true));
    return clone(result);
  }
  function create(details) {
    const parent = lookup(details.parentId);
    if (!parent.childIds) throw new Error('Parent is not a folder.');
    const id = String(nextId++);
    const node = { id, parentId: details.parentId, title: details.title, ...(details.url === undefined ? { childIds: [] } : { url: details.url }) };
    nodes.set(id, node);
    parent.childIds.splice(details.index ?? parent.childIds.length, 0, id);
    return copyNode(id);
  }
  const api = {
    storage: { local: {
      QUOTA_BYTES: quotaBytes,
      async get(keys) {
        if (keys === null) return clone(data);
        if (typeof keys === 'string') return { [keys]: clone(data[keys]) };
        return Object.fromEntries(keys.map(key => [key, clone(data[key])]));
      },
      async set(values) {
        calls.storageWrites++;
        for (const [key, value] of Object.entries(values)) if (key.startsWith('importJournal:')) {
          calls.maxJournalChunk = Math.max(calls.maxJournalChunk, value.length);
          calls.journalRecordsWritten += value.length;
        }
        for (const [key, value] of Object.entries(values)) if (key.startsWith('importUpdates:')) {
          calls.maxUpdateChunk = Math.max(calls.maxUpdateChunk, value.length);
          calls.updateRecordsWritten += value.length;
        }
        Object.assign(data, clone(values));
      },
      async remove(keys) { for (const key of Array.isArray(keys) ? keys : [keys]) { delete data[key]; calls.storageRemovals.push(key); } },
      async getBytesInUse(keys) {
        const selected = keys === null ? data : Object.fromEntries((Array.isArray(keys) ? keys : [keys]).map(key => [key, data[key]]));
        return storageOverhead + new TextEncoder().encode(JSON.stringify(selected)).byteLength;
      },
    } },
    bookmarks: {
      async getTree() { return [copyNode('0', true)]; },
      async get(id) { return [copyNode(id)]; },
      async getChildren(id) { return lookup(id).childIds.map(childId => copyNode(childId)); },
      async create(details) {
        calls.creates.push(clone(details));
        if (failCreateAt && calls.creates.length === failCreateAt) throw new Error('Simulated create failure');
        return create(details);
      },
      async update(id, changes) {
        calls.updates.push({ id, changes: clone(changes) });
        if (failUpdateAt && calls.updates.length === failUpdateAt) throw new Error('Simulated update failure');
        const node = lookup(id);
        if (node.url === undefined) throw new Error('Only bookmarks can be updated by this mock.');
        if (Object.hasOwn(changes, 'title')) node.title = changes.title;
        if (Object.hasOwn(changes, 'url')) node.url = canonicalizeUpdates ? new URL(changes.url).href : changes.url;
        return copyNode(id);
      },
      async remove(id) {
        const node = lookup(id);
        if (node.childIds?.length) throw new Error('Cannot remove a non-empty folder.');
        calls.removes.push(id);
        const parent = lookup(node.parentId);
        parent.childIds.splice(parent.childIds.indexOf(id), 1);
        nodes.delete(id);
      },
    },
  };
  return { api, calls, nodes, storageData: data,
    userCreate: create,
    userEdit(id, updates) { Object.assign(lookup(id), clone(updates)); },
    userMove(id, parentId) {
      const node = lookup(id);
      const oldParent = lookup(node.parentId);
      oldParent.childIds.splice(oldParent.childIds.indexOf(id), 1);
      lookup(parentId).childIds.push(id);
      node.parentId = parentId;
    },
    async preview(entries, options = {}) {
      const plan = buildImportPlan({ entries, existingTree: await api.bookmarks.getTree(), ...options });
      return { entries, options, expectedActions: JSON.stringify(plan.actions), filename: 'test-bookmarks.html' };
    },
  };
}

test('successful import executes only writes, resolves new parents, preserves order and records exact undo IDs', async () => {
  const mock = makeApi();
  const payload = await mock.preview([
    entry(bookmark('First')),
    entry(folder('Work', [bookmark('Docs'), bookmark('NewWork')])),
    entry(folder('Travel', [bookmark('Rail'), bookmark('Hotel')])),
    entry(bookmark('Last')),
  ], { position: 'start' });
  const before = await mock.api.bookmarks.getTree();
  const job = await runImport(mock.api, payload);
  assert.equal(job.status, 'complete');
  assert.deepEqual(job.stats, { bookmarks: 5, folders: 1, merged: 1, skipped: 1 });
  assert.equal(job.created.length, 6);
  assert.equal(mock.calls.creates.length, 6);
  assert.deepEqual((await mock.api.bookmarks.getChildren('1')).map(n => n.title), ['First', 'Travel', 'Last', 'Existing', 'Work']);
  assert.deepEqual((await mock.api.bookmarks.getChildren('11')).map(n => n.title), ['NewWork', 'Docs']);
  const travel = job.created.find(n => n.title === 'Travel');
  assert.deepEqual((await mock.api.bookmarks.getChildren(travel.id)).map(n => n.title), ['Rail', 'Hotel']);
  const stored = (await getHistory(mock.api))[0];
  assert.deepEqual(stored, job);
  assert.ok(mock.calls.storageWrites >= job.created.length * 2 + 2);

  const undone = await undoImport(mock.api, job.id);
  assert.equal(undone.status, 'undone');
  assert.equal(undone.removed, 6);
  assert.deepEqual(await mock.api.bookmarks.getTree(), before);
  assert.deepEqual(mock.calls.removes, job.created.map(n => n.id).reverse());
});

test('changed import decisions invalidate the exact preview before any writes or journal creation', async () => {
  const mock = makeApi();
  const payload = await mock.preview([entry(bookmark('Soon'))]);
  mock.userCreate({ parentId: '1', title: 'Added in another window', url: 'https://soon.example/' });
  await assert.rejects(runImport(mock.api, payload), /changed after the preview/);
  assert.equal(mock.calls.creates.length, 0);
  assert.equal(mock.calls.storageWrites, 0);
  assert.deepEqual(await getHistory(mock.api), []);
});

test('partial failures retain successful creations in history for a later safe undo', async () => {
  const mock = makeApi({ failCreateAt: 3 });
  const payload = await mock.preview([entry(folder('Batch', [bookmark('One'), bookmark('Two')]))]);
  await assert.rejects(runImport(mock.api, payload), /Import stopped.*2 items were created/s);
  const [job] = await getHistory(mock.api);
  assert.equal(job.status, 'partial');
  assert.equal(job.created.length, 2);
  assert.match(job.error, /Simulated create failure/);
  assert.ok(job.created.every(record => mock.nodes.has(record.id)));
  const result = await undoImport(mock.api, job.id);
  assert.equal(result.status, 'undone');
  assert.equal(result.removed, 2);
  assert.ok(job.created.every(record => !mock.nodes.has(record.id)));
});

test('failure before the first creation does not claim ownership of existing items', async () => {
  const mock = makeApi({ failCreateAt: 1 });
  const payload = await mock.preview([entry(bookmark('Fail'))]);
  await assert.rejects(runImport(mock.api, payload), /0 items were created/);
  const [job] = await getHistory(mock.api);
  assert.equal(job.created.length, 0);
  assert.equal(mock.calls.removes.length, 0);
  assert.ok(mock.nodes.has('10'));
});

test('undo preserves renamed, URL-edited and moved items while removing untouched ones', async () => {
  const mock = makeApi();
  const payload = await mock.preview(['Renamed', 'Retargeted', 'Moved', 'Unchanged'].map(title => entry(bookmark(title))));
  const job = await runImport(mock.api, payload);
  const ids = Object.fromEntries(job.created.map(n => [n.title, n.id]));
  mock.userEdit(ids.Renamed, { title: 'A new name' });
  mock.userEdit(ids.Retargeted, { url: 'https://changed.example/' });
  mock.userMove(ids.Moved, '2');
  const result = await undoImport(mock.api, job.id);
  assert.equal(result.status, 'undo-partial');
  assert.equal(result.preserved, 3);
  assert.equal(result.removed, 1);
  assert.deepEqual(result.created.map(n => n.id), [ids.Renamed, ids.Retargeted, ids.Moved]);
  for (const key of ['Renamed', 'Retargeted', 'Moved']) assert.ok(mock.nodes.has(ids[key]));
  assert.equal(mock.nodes.has(ids.Unchanged), false);
  assert.ok(mock.nodes.has('10'));
});

test('undo preserves a newly populated imported folder and its user-owned contents', async () => {
  const mock = makeApi();
  const job = await runImport(mock.api, await mock.preview([entry(folder('Imported', [bookmark('ImportedChild')]))]));
  const importedFolder = job.created.find(n => n.url === undefined);
  const importedChild = job.created.find(n => n.url !== undefined);
  const userChild = mock.userCreate({ parentId: importedFolder.id, title: 'User addition', url: 'https://user.example/' });
  const result = await undoImport(mock.api, job.id);
  assert.equal(result.status, 'undo-partial');
  assert.equal(result.preserved, 1);
  assert.equal(result.removed, 1);
  assert.ok(mock.nodes.has(importedFolder.id));
  assert.ok(mock.nodes.has(userChild.id));
  assert.equal(mock.nodes.has(importedChild.id), false);
});

test('a failed removal stays in the undo journal and can be retried', async () => {
  const mock = makeApi();
  const job = await runImport(mock.api, await mock.preview([entry(bookmark('Retry'))]));
  const remove = mock.api.bookmarks.remove;
  mock.api.bookmarks.remove = async () => { throw new Error('Temporarily unavailable'); };
  const partial = await undoImport(mock.api, job.id);
  assert.equal(partial.status, 'undo-partial');
  assert.equal(partial.created.length, 1);
  mock.api.bookmarks.remove = remove;
  const complete = await undoImport(mock.api, job.id);
  assert.equal(complete.status, 'undone');
  assert.equal(complete.removed, 1);
});

test('transient bookmark read errors preserve ownership records for a later undo', async () => {
  for (const treeAlsoFails of [false, true]) {
    const mock = makeApi();
    const job = await runImport(mock.api, await mock.preview([entry(bookmark('ReadRetry'))]));
    const get = mock.api.bookmarks.get;
    const getTree = mock.api.bookmarks.getTree;
    mock.api.bookmarks.get = async () => { throw new Error('Transient read failure'); };
    if (treeAlsoFails) mock.api.bookmarks.getTree = async () => { throw new Error('Transient tree read failure'); };
    const partial = await undoImport(mock.api, job.id);
    assert.equal(partial.status, 'undo-partial');
    assert.equal(partial.created.length, 1);
    assert.ok(mock.nodes.has(job.created[0].id));
    assert.equal(mock.calls.removes.length, 0);
    mock.api.bookmarks.get = get;
    mock.api.bookmarks.getTree = getTree;
    assert.equal((await undoImport(mock.api, job.id)).status, 'undone');
  }
});

test('a bookmark independently deleted by the user needs no further undo action', async () => {
  const mock = makeApi();
  const job = await runImport(mock.api, await mock.preview([entry(bookmark('Deleted'))]));
  await mock.api.bookmarks.remove(job.created[0].id);
  const removeCallsBeforeUndo = mock.calls.removes.length;
  const result = await undoImport(mock.api, job.id);
  assert.equal(result.status, 'undone');
  assert.equal(result.created.length, 0);
  assert.equal(result.removed, 0);
  assert.equal(mock.calls.removes.length, removeCallsBeforeUndo);
});

test('interrupted running or undoing history blocks additional imports', async () => {
  for (const status of ['running', 'undoing']) {
    const mock = makeApi({ history: [{ id: 'interrupted', status, created: [], pending: null }] });
    const payload = await mock.preview([entry(bookmark('Blocked'))]);
    await assert.rejects(runImport(mock.api, payload), /earlier operation was interrupted/);
    assert.equal(mock.calls.creates.length, 0);
    assert.equal(mock.calls.storageWrites, 0);
  }
});

test('crash recovery never claims a matching unconfirmed item, even when it is the only candidate', async () => {
  const history = [{
    id: 'interrupted', status: 'running', created: [],
    pending: { parentId: '1', title: 'Unconfirmed', url: 'https://unconfirmed.example/', beforeIds: ['10', '11'] },
  }];
  const mock = makeApi({ history });
  // This might belong to a user or another browser window, not the import.
  const uncertain = mock.userCreate({ parentId: '1', title: 'Unconfirmed', url: 'https://unconfirmed.example/' });
  const result = await undoImport(mock.api, 'interrupted');
  assert.ok(mock.nodes.has(uncertain.id));
  assert.equal(mock.calls.removes.length, 0);
  assert.equal(result.created.length, 0);
  assert.match(result.recoveryWarning, /preserv|unconfirm|interrupt|manual/i);
});

test('crash recovery keeps unconfirmed children and consequently preserves their imported parent', async () => {
  const mock = makeApi();
  const parent = mock.userCreate({ parentId: '1', title: 'New folder' });
  const unknown = mock.userCreate({ parentId: parent.id, title: 'Pending', url: 'https://pending.example/' });
  await mock.api.storage.local.set({ importHistory: [{
    id: 'interrupted', status: 'running', created: [{ id: parent.id, parentId: '1', title: 'New folder' }],
    pending: { parentId: parent.id, title: 'Pending', url: 'https://pending.example/', beforeIds: [] },
  }] });
  const result = await undoImport(mock.api, 'interrupted');
  assert.equal(result.status, 'undo-partial');
  assert.equal(result.preserved, 1);
  assert.ok(mock.nodes.has(parent.id));
  assert.ok(mock.nodes.has(unknown.id));
  assert.equal(mock.calls.removes.length, 0);
});

test('unknown and already undone imports fail without deleting bookmarks', async () => {
  const mock = makeApi({ history: [{ id: 'done', status: 'undone', created: [] }] });
  await assert.rejects(undoImport(mock.api, 'missing'), /no longer in history/);
  await assert.rejects(undoImport(mock.api, 'done'), /already undone/);
  assert.equal(mock.calls.removes.length, 0);
});

test('large ownership journals use bounded chunks and hydrate completely after storage reload', async () => {
  const mock = makeApi();
  const entries = Array.from({ length: JOURNAL_CHUNK_SIZE * 2 + 5 }, (_, index) => entry(bookmark(`Item${index}`)));
  const job = await runImport(mock.api, await mock.preview(entries));
  const raw = mock.storageData.importHistory[0];
  assert.equal(raw.created, undefined);
  assert.equal(raw.createdCount, entries.length);
  assert.equal(raw.createdChunkCount, 3);
  assert.equal(mock.calls.maxJournalChunk, JOURNAL_CHUNK_SIZE);
  assert.ok(mock.calls.journalRecordsWritten < entries.length * JOURNAL_CHUNK_SIZE, 'append work stays bounded by chunk size rather than total journal length');
  assert.deepEqual((await getHistory(mock.api))[0], job);

  const writesBefore = mock.calls.journalRecordsWritten;
  await runImport(mock.api, await mock.preview([entry(bookmark('AnotherBatch'))]));
  assert.equal(mock.calls.journalRecordsWritten - writesBefore, 1, 'another import never rewrites an earlier journal');
  assert.deepEqual((await getHistory(mock.api)).find(item => item.id === job.id), job);
});

test('undo rewrites preserved records once and removes unreferenced journal chunks', async () => {
  const mock = makeApi();
  const entries = Array.from({ length: JOURNAL_CHUNK_SIZE * 2 + 5 }, (_, index) => entry(bookmark(`Item${index}`)));
  const job = await runImport(mock.api, await mock.preview(entries));
  mock.userEdit(job.created[0].id, { title: 'Preserve the first item' });
  const writesBefore = mock.calls.journalRecordsWritten;
  const undone = await undoImport(mock.api, job.id);
  assert.equal(undone.status, 'undo-partial');
  assert.equal(undone.created.length, 1);
  assert.equal(mock.calls.journalRecordsWritten - writesBefore, 1);
  assert.equal(mock.storageData.importHistory[0].createdChunkCount, 1);
  const journalKeys = Object.keys(mock.storageData).filter(key => key.startsWith(`importJournal:${job.id}:`));
  assert.equal(journalKeys.length, 1);
  assert.equal(mock.calls.storageRemovals.length, 2);
  assert.deepEqual((await getHistory(mock.api))[0], undone);
  mock.userEdit(job.created[0].id, { title: job.created[0].title });
  assert.equal((await undoImport(mock.api, job.id)).status, 'undone');
  assert.equal(Object.keys(mock.storageData).filter(key => key.startsWith(`importJournal:${job.id}:`)).length, 0);
});

test('a missing journal chunk blocks undo instead of silently forgetting owned items', async () => {
  const mock = makeApi();
  const job = await runImport(mock.api, await mock.preview([entry(bookmark('KeepSafe'))]));
  const key = Object.keys(mock.storageData).find(key => key.startsWith('importJournal:'));
  delete mock.storageData[key];
  await assert.rejects(undoImport(mock.api, job.id), /journal is incomplete/);
  assert.equal(mock.calls.removes.length, 0);
  assert.ok(mock.nodes.has(job.created[0].id));
});

test('quota preflight rejects the full batch before any bookmark or journal write', async () => {
  const mock = makeApi({ storageOverhead: 9 * 1024 * 1024 });
  const payload = await mock.preview([entry(bookmark('TooFull'))]);
  await assert.rejects(runImport(mock.api, payload), /not enough local storage.*smaller selection/i);
  assert.equal(mock.calls.creates.length, 0);
  assert.equal(mock.calls.storageWrites, 0);
  assert.deepEqual(mock.storageData.importHistory, []);
});

test('quota preflight accounts for exceptionally long titles and URLs', async () => {
  const mock = makeApi({ quotaBytes: 128 * 1024 });
  const payload = await mock.preview([entry(bookmark('Large title '.repeat(8_000), `https://large.example/?q=${'x'.repeat(20_000)}`))]);
  await assert.rejects(runImport(mock.api, payload), /not enough local storage/);
  assert.equal(mock.calls.creates.length, 0);
  assert.equal(mock.calls.storageWrites, 0);
});

test('a batch above the write cap fails before mutation with an actionable batching message', async () => {
  const mock = makeApi();
  const entries = Array.from({ length: MAX_IMPORT_WRITES + 1 }, (_, index) => entry(bookmark(`Item${index}`)));
  await assert.rejects(runImport(mock.api, await mock.preview(entries)), /per import.*another batch/);
  assert.equal(mock.calls.creates.length, 0);
  assert.equal(mock.calls.storageWrites, 0);
});

const reviewedBookmark = (id, title, url = 'https://existing.example/') => ({ id, title, url });
const reviewOptions = duplicateDecisions => ({ duplicatePolicy: 'review', duplicateScope: 'global', duplicateDecisions });

test('mixed reviewed choices create, skip, replace and merge exactly the selected bookmarks and undo all changes', async () => {
  const mock = makeApi();
  const before = await mock.api.bookmarks.getTree();
  const entries = [
    entry(reviewedBookmark('skip', 'Skipped docs', 'https://docs.example/')),
    entry(reviewedBookmark('keep', 'Separate copy')),
    entry(reviewedBookmark('replace', 'Replacement title')),
    entry(reviewedBookmark('merge', 'Additional docs title', 'https://docs.example/')),
  ];
  const options = reviewOptions({
    'id:skip': { choice: 'skip' }, 'id:keep': { choice: 'keep' },
    'id:replace': { choice: 'replace', targetId: '10' }, 'id:merge': { choice: 'merge', targetId: '12' },
  });
  const job = await runImport(mock.api, await mock.preview(entries, options));
  assert.equal(job.status, 'complete');
  assert.deepEqual(job.stats, { bookmarks: 1, folders: 0, merged: 0, skipped: 1, updated: 2 });
  assert.equal(job.created.length, 1);
  assert.equal(job.updated.length, 2);
  assert.equal(mock.calls.creates.length, 1);
  assert.deepEqual(mock.calls.updates.map(call => call.id), ['10', '12']);
  assert.equal(mock.nodes.get('10').title, 'Replacement title');
  assert.equal(mock.nodes.get('10').parentId, '1');
  assert.equal(mock.nodes.get('12').title, 'Docs · Additional docs title');
  assert.equal(mock.nodes.get('12').parentId, '11');
  assert.deepEqual((await getHistory(mock.api))[0], job);
  const undone = await undoImport(mock.api, job.id);
  assert.equal(undone.status, 'undone');
  assert.equal(undone.updated.length, 0);
  assert.deepEqual(await mock.api.bookmarks.getTree(), before);
  assert.deepEqual(mock.calls.removes, job.created.map(record => record.id));
});

test('an update-only import persists before and after snapshots and restores the original bookmark ID', async () => {
  const mock = makeApi();
  const options = reviewOptions({ 'id:rename': { choice: 'replace', targetId: '10' } });
  const job = await runImport(mock.api, await mock.preview([entry(reviewedBookmark('rename', 'Replaced'))], options));
  assert.deepEqual(job.created, []);
  assert.equal(job.updated.length, 1);
  assert.equal(job.updated[0].id, '10');
  assert.deepEqual(job.updated[0].before, { title: 'Existing', url: 'https://existing.example/', parentId: '1' });
  assert.deepEqual(job.updated[0].after, { title: 'Replaced', url: 'https://existing.example/', parentId: '1' });
  const raw = mock.storageData.importHistory[0];
  assert.equal(raw.journalVersion, 2);
  assert.equal(raw.createdCount, 0);
  assert.equal(raw.updatedCount, 1);
  assert.equal(raw.updated, undefined);
  const [reloaded] = await getHistory(mock.api);
  assert.deepEqual(reloaded.updated, job.updated);
  const undone = await undoImport(mock.api, reloaded.id);
  assert.equal(undone.status, 'undone');
  assert.equal(mock.nodes.get('10').title, 'Existing');
  assert.equal(mock.nodes.get('10').parentId, '1');
  assert.equal(mock.calls.creates.length, 0);
  assert.equal(mock.calls.removes.length, 0);
  assert.equal(Object.keys(mock.storageData).some(key => key.startsWith(`importUpdates:${job.id}:`)), false);
});

test('resolved no-op replacements and merges never call the update API', async () => {
  for (const choice of ['replace', 'merge']) {
    const mock = makeApi();
    const job = await runImport(mock.api, await mock.preview([entry(reviewedBookmark('same', 'Existing'))], reviewOptions({ 'id:same': { choice, targetId: '10' } })));
    assert.equal(job.stats.updated, 0);
    assert.deepEqual(job.updated, []);
    assert.equal(mock.calls.updates.length, 0);
    assert.equal(mock.calls.creates.length, 0);
  }
});

test('unresolved overlap decisions block all writes and journal creation', async () => {
  const mock = makeApi();
  const entries = [entry(bookmark('WouldCreate')), entry(reviewedBookmark('unresolved', 'Incoming'))];
  await assert.rejects(runImport(mock.api, await mock.preview(entries, reviewOptions({}))), /resolv|decision|review/i);
  assert.equal(mock.calls.creates.length, 0);
  assert.equal(mock.calls.updates.length, 0);
  assert.equal(mock.calls.storageWrites, 0);
  assert.deepEqual(await getHistory(mock.api), []);
});

test('stale reviewed replacement snapshots fail before mutation when target is renamed, moved, or removed', async () => {
  for (const change of ['rename', 'move', 'remove']) {
    const mock = makeApi();
    const payload = await mock.preview([entry(reviewedBookmark('stale', 'Incoming'))], reviewOptions({ 'id:stale': { choice: 'replace', targetId: '10' } }));
    if (change === 'rename') mock.userEdit('10', { title: 'External edit' });
    else if (change === 'move') mock.userMove('10', '2');
    else await mock.api.bookmarks.remove('10');
    await assert.rejects(runImport(mock.api, payload), /changed after the preview|resolv|review/i);
    assert.equal(mock.calls.updates.length, 0);
    assert.equal(mock.calls.creates.length, 0);
    assert.equal(mock.calls.storageWrites, 0);
  }
});

test('update undo preserves bookmarks edited or moved by the user after import', async () => {
  for (const change of ['title', 'url', 'parent']) {
    const mock = makeApi();
    const job = await runImport(mock.api, await mock.preview([entry(reviewedBookmark('change', 'Imported title'))], reviewOptions({ 'id:change': { choice: 'replace', targetId: '10' } })));
    if (change === 'title') mock.userEdit('10', { title: 'User title' });
    else if (change === 'url') mock.userEdit('10', { url: 'https://user-changed.example/' });
    else mock.userMove('10', '2');
    const beforeUndo = clone(mock.nodes.get('10'));
    const callsBefore = mock.calls.updates.length;
    const undone = await undoImport(mock.api, job.id);
    assert.equal(undone.status, 'undo-partial');
    assert.equal(undone.updated.length, 1);
    assert.equal(undone.preserved, 1);
    assert.deepEqual(mock.nodes.get('10'), beforeUndo);
    assert.equal(mock.calls.updates.length, callsBefore);
    assert.equal(mock.calls.removes.length, 0);
  }
});

test('a transient read failure retains an update undo record for a successful retry', async () => {
  const mock = makeApi();
  const job = await runImport(mock.api, await mock.preview([entry(reviewedBookmark('retry', 'Imported title'))], reviewOptions({ 'id:retry': { choice: 'replace', targetId: '10' } })));
  const get = mock.api.bookmarks.get;
  mock.api.bookmarks.get = async () => { throw new Error('Transient bookmark read failure'); };
  const callsBefore = mock.calls.updates.length;
  const partial = await undoImport(mock.api, job.id);
  assert.equal(partial.status, 'undo-partial');
  assert.equal(partial.updated.length, 1);
  assert.equal(mock.calls.updates.length, callsBefore);
  mock.api.bookmarks.get = get;
  assert.equal((await undoImport(mock.api, job.id)).status, 'undone');
  assert.equal(mock.nodes.get('10').title, 'Existing');
});

test('sequential updates to one ID use canonical browser return values and restore the original state once', async () => {
  const mock = makeApi({ canonicalizeUpdates: true });
  const entries = [entry(reviewedBookmark('first', 'First', 'HTTPS://EXISTING.EXAMPLE:443/')), entry(reviewedBookmark('second', 'Second'))];
  const options = reviewOptions({ 'id:first': { choice: 'replace', targetId: '10' }, 'id:second': { choice: 'merge', targetId: '10' } });
  const job = await runImport(mock.api, await mock.preview(entries, options));
  assert.equal(job.updated.length, 2);
  assert.equal(mock.nodes.get('10').title, 'First · Second');
  assert.equal(mock.nodes.get('10').url, 'https://existing.example/');
  assert.deepEqual(job.updated[1].before, job.updated[0].after);
  const undone = await undoImport(mock.api, job.id);
  assert.equal(undone.status, 'undone');
  assert.equal(undone.restored, 1);
  assert.deepEqual(mock.calls.updates.map(call => call.changes.title), ['First', 'First · Second', 'Existing']);
  assert.equal(mock.nodes.get('10').title, 'Existing');
  assert.equal(mock.calls.removes.length, 0);
});

test('a user edit matching an intermediate update state is preserved instead of mistaken for the final imported state', async () => {
  const mock = makeApi();
  const entries = [entry(reviewedBookmark('first', 'First')), entry(reviewedBookmark('second', 'Second'))];
  const options = reviewOptions({ 'id:first': { choice: 'replace', targetId: '10' }, 'id:second': { choice: 'merge', targetId: '10' } });
  const job = await runImport(mock.api, await mock.preview(entries, options));
  mock.userEdit('10', { title: 'First' });
  const partial = await undoImport(mock.api, job.id);
  assert.equal(partial.status, 'undo-partial');
  assert.equal(partial.preserved, 1);
  assert.ok(partial.updated.length > 0);
  assert.equal(mock.nodes.get('10').title, 'First');
  assert.equal(mock.calls.updates.length, 2);
  // Returning to the final imported state permits a safe retry of the group.
  mock.userEdit('10', { title: 'First · Second' });
  const retried = await undoImport(mock.api, job.id);
  assert.equal(retried.status, 'undone');
  assert.equal(retried.restored, 1);
  assert.equal(mock.nodes.get('10').title, 'Existing');
});

test('a target edited between two writes stops the import and keeps the successful first update undoable', async () => {
  const mock = makeApi();
  const entries = [entry(reviewedBookmark('first', 'First update')), entry(reviewedBookmark('second', 'Second update', 'https://docs.example/'))];
  const options = reviewOptions({ 'id:first': { choice: 'replace', targetId: '10' }, 'id:second': { choice: 'replace', targetId: '12' } });
  const payload = await mock.preview(entries, options);
  const update = mock.api.bookmarks.update;
  mock.api.bookmarks.update = async (id, changes) => {
    const result = await update(id, changes);
    if (id === '10') mock.userEdit('12', { title: 'User changed while importing' });
    return result;
  };
  await assert.rejects(runImport(mock.api, payload), /changed|stale|match|review/i);
  const [job] = await getHistory(mock.api);
  assert.equal(job.status, 'partial');
  assert.equal(job.updated.length, 1);
  assert.deepEqual(mock.calls.updates.map(call => call.id), ['10']);
  assert.equal(mock.nodes.get('12').title, 'User changed while importing');
  mock.api.bookmarks.update = update;
  await undoImport(mock.api, job.id);
  assert.equal(mock.nodes.get('10').title, 'Existing');
  assert.equal(mock.nodes.get('12').title, 'User changed while importing');
});

test('a confirmed update survives a post-write journal error and can be undone safely', async () => {
  const mock = makeApi();
  const payload = await mock.preview([entry(reviewedBookmark('journal', 'Changed'))], reviewOptions({ 'id:journal': { choice: 'replace', targetId: '10' } }));
  const set = mock.api.storage.local.set;
  let failed = false;
  mock.api.storage.local.set = async values => {
    if (mock.calls.updates.length && !failed) { failed = true; throw new Error('Simulated post-update journal failure'); }
    return set(values);
  };
  await assert.rejects(runImport(mock.api, payload), /journal failure/);
  assert.equal(failed, true);
  assert.equal(mock.nodes.get('10').title, 'Changed');
  const [job] = await getHistory(mock.api);
  assert.equal(job.status, 'partial');
  assert.equal(job.updated.length, 1);
  assert.equal((await undoImport(mock.api, job.id)).status, 'undone');
  assert.equal(mock.nodes.get('10').title, 'Existing');
});

test('legacy version-one chunk journals still load and undo their confirmed creations', async () => {
  const mock = makeApi();
  const created = mock.userCreate({ parentId: '1', title: 'Legacy created item', url: 'https://legacy.example/' });
  const record = { id: created.id, parentId: created.parentId, title: created.title, url: created.url };
  await mock.api.storage.local.set({
    importHistory: [{ id: 'legacy-v1', status: 'complete', journalVersion: 1, createdCount: 1, createdChunkCount: 1, pending: null }],
    'importJournal:legacy-v1:0': [record],
  });
  const [loaded] = await getHistory(mock.api);
  assert.deepEqual(loaded.created, [record]);
  assert.deepEqual(loaded.updated, []);
  assert.equal((await undoImport(mock.api, loaded.id)).status, 'undone');
  assert.equal(mock.nodes.has(created.id), false);
  assert.equal(mock.nodes.get('10').title, 'Existing');
  assert.equal(mock.calls.updates.length, 0);
});

test('missing update journal chunks block undo without overwriting the updated bookmark', async () => {
  const mock = makeApi();
  const job = await runImport(mock.api, await mock.preview([entry(reviewedBookmark('missing', 'Updated'))], reviewOptions({ 'id:missing': { choice: 'replace', targetId: '10' } })));
  const key = Object.keys(mock.storageData).find(key => key.startsWith(`importUpdates:${job.id}:`));
  assert.ok(key);
  delete mock.storageData[key];
  const callsBefore = mock.calls.updates.length;
  await assert.rejects(undoImport(mock.api, job.id), /journal is incomplete/);
  assert.equal(mock.calls.updates.length, callsBefore);
  assert.equal(mock.nodes.get('10').title, 'Updated');
});

test('worker-crash recovery restores a known pending update only when its current state still matches', async () => {
  for (const outcome of ['applied', 'externally-edited', 'already-reverted']) {
    const mock = makeApi({ canonicalizeUpdates: true });
    const payload = await mock.preview([entry(reviewedBookmark('crash', 'Crash update', 'HTTPS://EXISTING.EXAMPLE:443/'))], reviewOptions({ 'id:crash': { choice: 'replace', targetId: '10' } }));
    const update = mock.api.bookmarks.update;
    let lastPersistedBeforeWrite;
    mock.api.bookmarks.update = async (id, changes) => {
      lastPersistedBeforeWrite = clone(mock.storageData);
      return update(id, changes);
    };
    const job = await runImport(mock.api, payload);
    mock.api.bookmarks.update = update;
    assert.ok(lastPersistedBeforeWrite.importHistory[0].pending, 'pending intent must be durable before update');
    // Emulate termination after the browser write but before persisting its reply.
    for (const key of Object.keys(mock.storageData)) delete mock.storageData[key];
    Object.assign(mock.storageData, lastPersistedBeforeWrite);
    if (outcome === 'externally-edited') mock.userEdit('10', { title: 'User changed after the crash' });
    else if (outcome === 'already-reverted') mock.userEdit('10', { title: 'Existing', url: 'https://existing.example/' });
    const result = await undoImport(mock.api, job.id);
    assert.equal(mock.nodes.has('10'), true);
    assert.equal(mock.calls.removes.length, 0);
    if (outcome === 'externally-edited') {
      assert.equal(result.status, 'undo-partial');
      assert.equal(result.updated.length, 1);
      assert.equal(mock.nodes.get('10').title, 'User changed after the crash');
      assert.equal(mock.calls.updates.length, 1);
    } else {
      assert.equal(result.status, 'undone');
      assert.equal(result.updated.length, 0);
      assert.equal(mock.nodes.get('10').title, 'Existing');
      assert.equal(mock.calls.updates.length, outcome === 'applied' ? 2 : 1);
      assert.equal(result.restored || 0, outcome === 'applied' ? 1 : 0);
    }
  }
});

test('update-only quota failures reject before any changes or undo-journal writes', async () => {
  const mock = makeApi({ storageOverhead: 9 * 1024 * 1024 });
  const payload = await mock.preview([entry(reviewedBookmark('quota', 'Updated'))], reviewOptions({ 'id:quota': { choice: 'replace', targetId: '10' } }));
  await assert.rejects(runImport(mock.api, payload), /not enough local storage/);
  assert.equal(mock.calls.updates.length, 0);
  assert.equal(mock.calls.creates.length, 0);
  assert.equal(mock.calls.storageWrites, 0);
  assert.equal(mock.nodes.get('10').title, 'Existing');
});

test('large update journals use bounded chunks, hydrate fully, and restore every unique bookmark', async () => {
  const mock = makeApi();
  const duplicateDecisions = {};
  const entries = Array.from({ length: JOURNAL_CHUNK_SIZE + 5 }, (_, index) => {
    const local = mock.userCreate({ parentId: '1', title: `Original ${index}`, url: `https://updates.example/${index}` });
    duplicateDecisions[`id:incoming-${index}`] = { choice: 'replace', targetId: local.id };
    return entry(reviewedBookmark(`incoming-${index}`, `Updated ${index}`, local.url));
  });
  const before = await mock.api.bookmarks.getTree();
  const job = await runImport(mock.api, await mock.preview(entries, reviewOptions(duplicateDecisions)));
  assert.equal(mock.storageData.importHistory[0].updatedCount, entries.length);
  assert.equal(mock.storageData.importHistory[0].updatedChunkCount, 2);
  assert.equal(mock.calls.maxUpdateChunk, JOURNAL_CHUNK_SIZE);
  assert.ok(mock.calls.updateRecordsWritten < entries.length * JOURNAL_CHUNK_SIZE);
  assert.deepEqual((await getHistory(mock.api))[0], job);
  const undone = await undoImport(mock.api, job.id);
  assert.equal(undone.status, 'undone');
  assert.equal(undone.restored, entries.length);
  assert.deepEqual(await mock.api.bookmarks.getTree(), before);
  assert.equal(Object.keys(mock.storageData).some(key => key.startsWith(`importUpdates:${job.id}:`)), false);
});
