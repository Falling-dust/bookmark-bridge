import test from 'node:test';
import assert from 'node:assert/strict';
import { buildImportPlan } from '../lib/planner.js';
import { getHistory, runImport, undoImport, JOURNAL_CHUNK_SIZE, MAX_IMPORT_WRITES } from '../lib/operations.js';

const clone = value => structuredClone(value);
const bookmark = (title, url = `https://${title.toLowerCase()}.example/`) => ({ title, url });
const folder = (title, children = []) => ({ title, children });
const entry = (node, destinationId = '1') => ({ node, destinationId });

/** A stateful mock with Chrome-style structured cloning and nonrecursive remove. */
function makeApi({ history = [], failCreateAt = 0, quotaBytes = 10 * 1024 * 1024, storageOverhead = 0 } = {}) {
  const nodes = new Map();
  const data = { importHistory: clone(history) };
  const calls = { creates: [], removes: [], storageWrites: 0, maxJournalChunk: 0, journalRecordsWritten: 0, storageRemovals: [] };
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
