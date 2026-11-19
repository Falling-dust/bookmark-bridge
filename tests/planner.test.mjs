import test from 'node:test';
import assert from 'node:assert/strict';
import { buildImportPlan, normalizeUrl, IMPORT_LIMITS } from '../lib/planner.js';

const link = (title, url = `https://${title.toLowerCase()}.example/`) => ({ title, url });
const folder = (title, children = []) => ({ title, children });
const entry = (node, destinationId = '1') => ({ node, destinationId });
const tree = () => [{ id: '0', title: '', children: [
  { id: '1', title: 'Bookmarks bar', children: [
    { id: '10', title: 'Existing', url: 'https://example.com/a' },
    { id: '11', title: 'Work', children: [
      { id: '12', title: 'Docs', url: 'https://docs.example/' },
      { id: '13', title: 'Research', children: [] },
    ] },
  ] },
  { id: '2', title: 'Other bookmarks', children: [
    { id: '20', title: 'Elsewhere', url: 'https://elsewhere.example/' },
  ] },
] }];
const plan = (entries, options = {}) => buildImportPlan({ entries, existingTree: tree(), ...options });
const writes = result => result.actions.filter(action => action.type.startsWith('create-'));

test('URL normalization preserves meaningful path, query, fragment and protocol differences', () => {
  assert.equal(normalizeUrl('  HTTPS://EXAMPLE.COM:443/a/?b=2&a=1#Part  '), 'https://example.com/a/?b=2&a=1#Part');
  assert.equal(normalizeUrl('http://EXAMPLE.COM:80'), 'http://example.com/');
  assert.equal(normalizeUrl('https://EXAMPLE.COM?q=1'), 'https://example.com/?q=1');
  assert.equal(normalizeUrl('FTP://EXAMPLE.COM:21/file'), 'ftp://example.com/file');
  assert.equal(normalizeUrl('https://EXAMPLE.COM/a/../b'), 'https://example.com/a/../b');
  assert.equal(normalizeUrl('https://EXAMPLE.COM:8443/%2f'), 'https://example.com:8443/%2f');
  for (const [a, b] of [
    ['http://example.com/a', 'https://example.com/a'],
    ['https://example.com/a', 'https://example.com/a/'],
    ['https://example.com/a#one', 'https://example.com/a#two'],
    ['https://example.com/?a=1&b=2', 'https://example.com/?b=2&a=1'],
    ['https://example.com/', 'https://example.com/?utm_source=test'],
  ]) assert.notEqual(normalizeUrl(a), normalizeUrl(b));
});

test('nested folder merging uses existing IDs and retains topological creation order', () => {
  const result = plan([entry(folder('Work', [
    link('Docs'), folder('Research', [folder('Papers', [link('Paper')])]), link('Notes'),
  ]))]);
  assert.deepEqual(result.stats, { bookmarks: 2, folders: 1, merged: 2, skipped: 1 });
  assert.deepEqual(result.actions.map(a => a.type), ['merge-folder', 'skip', 'merge-folder', 'create-folder', 'create-bookmark', 'create-bookmark']);
  assert.equal(result.actions[0].existingId, '11');
  assert.equal(result.actions[2].existingId, '13');
  assert.equal(result.actions[3].parentRef, '13');
  assert.equal(result.actions[4].parentRef, result.actions[3].key);
  assert.equal(result.actions[5].parentRef, '11');
  assert.ok(result.actions.every(a => !Object.hasOwn(a, 'index')));
});

test('destination duplicate matching is direct to each actual destination folder', () => {
  const result = plan([
    entry(link('Same', 'HTTPS://EXAMPLE.COM:443/a')),
    entry(link('Other location', 'https://elsewhere.example/')),
    entry(link('Work docs at bar', 'https://docs.example/')),
    entry(folder('Work', [link('Docs renamed', 'https://docs.example/')])),
  ]);
  assert.equal(result.stats.bookmarks, 2);
  assert.equal(result.stats.skipped, 2);
  assert.deepEqual(result.actions.filter(a => a.type === 'skip').map(a => a.existingId), ['10', '12']);
});

test('global scope finds URLs anywhere and deduplicates across incoming destinations', () => {
  const result = plan([
    entry(link('Elsewhere')),
    entry(link('Brandnew')),
    entry(link('Duplicate batch', 'https://brandnew.example/'), '2'),
  ], { duplicateScope: 'global' });
  assert.deepEqual(result.stats, { bookmarks: 1, folders: 0, merged: 0, skipped: 2 });
  assert.equal(result.actions[0].existingId, '20');
  assert.match(result.actions[2].reason, /already included/);
  assert.equal(result.actions[2].existingId, undefined);
});

test('destination scope permits the same URL in different folders', () => {
  const result = plan([entry(link('New')), entry(link('New'), '2')]);
  assert.equal(result.stats.bookmarks, 2);
  assert.equal(result.stats.skipped, 0);
});

test('same-batch exact folder matches merge and deduplicate nested URLs', () => {
  const result = plan([
    entry(folder('Travel', [link('Rail')])),
    entry(folder('Travel', [link('Rail'), link('Hotel')])),
  ]);
  assert.deepEqual(result.stats, { bookmarks: 2, folders: 1, merged: 1, skipped: 1 });
  const creates = writes(result);
  assert.equal(creates[1].parentRef, creates[0].key);
  assert.equal(creates[2].parentRef, creates[0].key);
});

test('keep policy preserves duplicate bookmarks and merging can be disabled', () => {
  const result = plan([
    entry(link('Existing again', 'https://example.com/a')),
    entry(link('Existing twice', 'https://example.com/a')),
    entry(folder('Work', [link('Docs')])),
    entry(folder('Work', [link('Docs')])),
  ], { duplicatePolicy: 'keep', mergeFolders: false });
  assert.deepEqual(result.stats, { bookmarks: 4, folders: 2, merged: 0, skipped: 0 });
  const folders = result.actions.filter(a => a.type === 'create-folder');
  assert.notEqual(folders[0].key, folders[1].key);
});

test('folder names match exactly including case', () => {
  const result = plan([entry(folder('work')), entry(folder('Work'))]);
  assert.deepEqual(result.actions.map(a => a.type), ['create-folder', 'merge-folder']);
});

test('start insertion indices preserve order separately for every destination', () => {
  const result = plan([
    entry(link('First')),
    entry(link('Dup', 'https://example.com/a')),
    entry(folder('Work', [link('WorkFirst'), link('Docs'), link('WorkSecond')])),
    entry(folder('New', [link('ChildOne'), link('ChildTwo')])),
    entry(link('Third')),
    entry(link('OtherFirst'), '2'),
  ], { position: 'start' });
  assert.deepEqual(writes(result).filter(a => a.parentRef === '1').map(a => [a.title, a.index]), [['First', 0], ['New', 1], ['Third', 2]]);
  assert.deepEqual(writes(result).filter(a => a.parentRef === '11').map(a => a.index), [0, 1]);
  assert.equal(writes(result).find(a => a.parentRef === '2').index, 0);
  const newFolder = writes(result).find(a => a.title === 'New');
  assert.deepEqual(writes(result).filter(a => a.parentRef === newFolder.key).map(a => a.index), [0, 1]);
});

test('input trees and entries are untouched and repeated planning is deterministic', () => {
  const existingTree = tree();
  const entries = [entry(folder('Work', [folder('New', [link('Site')])]))];
  const before = structuredClone({ existingTree, entries });
  const first = buildImportPlan({ existingTree, entries });
  const second = buildImportPlan({ existingTree, entries });
  assert.deepEqual({ existingTree, entries }, before);
  assert.deepEqual(first, second);
});

test('invalid, bookmark, root and managed descendant destinations are rejected', () => {
  assert.throws(() => plan([entry(link('Site'), 'missing')]), /no longer exists/);
  assert.throws(() => plan([entry(link('Site'), '10')]), /must be a folder/);
  assert.throws(() => plan([entry(link('Site'), '0')]), /root is not writable/);
  const existingTree = tree();
  existingTree[0].children.push({ id: '3', title: 'Managed', unmodifiable: 'managed', children: [{ id: '30', title: 'Child', children: [] }] });
  for (const destinationId of ['3', '30']) {
    assert.throws(() => buildImportPlan({ existingTree, entries: [entry(link('Site'), destinationId)] }), /read-only|managed/);
  }
  existingTree[0].children.push({ id: '4', title: 'Managed type', folderType: 'managed', children: [] });
  assert.throws(() => buildImportPlan({ existingTree, entries: [entry(link('Site'), '4')] }), /read-only|managed/);
});

test('merging into a managed folder is rejected; creating a separate folder remains possible', () => {
  const existingTree = tree();
  existingTree[0].children[0].children.push({ id: '50', title: 'Company', unmodifiable: 'managed', children: [] });
  const entries = [entry(folder('Company', [link('Site')]))];
  assert.throws(() => buildImportPlan({ existingTree, entries }), /Cannot merge into read-only/);
  assert.equal(buildImportPlan({ existingTree, entries, mergeFolders: false }).stats.folders, 1);
});

test('unsafe or unknown protocols and malformed URLs are rejected', () => {
  for (const url of ['javascript:alert(1)', ' JAVASCRIPT:alert(1) ', 'data:text/html,test', 'vbscript:alert(1)', 'custom:thing', 'https:example.com', '/relative', '', 'https://exa\nmple.com/', 'https://example.com\\@evil.example/']) {
    assert.throws(() => plan([entry(link('Bad', url))]), /URL|scheme|hostname/);
  }
});

test('supported bookmark protocols remain available', () => {
  const urls = ['https://example.org/', 'http://example.org/', 'ftp://files.example/', 'file:///C:/Docs/a.html', 'mailto:hello@example.org', 'chrome://settings/', 'edge://favorites/', 'about:blank'];
  const result = plan(urls.map((url, i) => entry(link(`Allowed ${i}`, url))));
  assert.equal(result.stats.bookmarks, urls.length);
});

test('malformed nodes, cycles, invalid settings and duplicate existing IDs fail clearly', () => {
  for (const node of [null, [], {}, { title: 1, children: [] }, { title: 'No children' }, { title: 'Both', url: 'https://example.org/', children: [] }]) {
    assert.throws(() => plan([entry(node)]));
  }
  const cycle = folder('Cycle'); cycle.children.push(cycle);
  assert.throws(() => plan([entry(cycle)]), /cycle/);
  assert.throws(() => plan([entry(link('Site'))], { duplicatePolicy: 'replace' }), /Duplicate policy/);
  assert.throws(() => plan([entry(link('Site'))], { duplicateScope: 'somewhere' }), /Duplicate scope/);
  assert.throws(() => plan([entry(link('Site'))], { position: 'middle' }), /position/);
  assert.throws(() => plan([], { mergeFolders: 'yes' }), /merging/);
  const existingTree = tree(); existingTree[0].children[1].id = '1';
  assert.throws(() => buildImportPlan({ existingTree, entries: [] }), /repeated ID/);
});

test('depth and count limits reject oversized imports before planning', () => {
  let nested = link('Leaf');
  for (let i = 0; i <= IMPORT_LIMITS.maxDepth; i++) nested = folder(`Level ${i}`, [nested]);
  assert.throws(() => plan([entry(nested)]), /exceeds depth/);
  const tooMany = Array.from({ length: IMPORT_LIMITS.maxNodes + 1 }, () => entry(link('Site')));
  assert.throws(() => plan(tooMany), /exceeds .* nodes/);
});

test('an empty selection has no actions and a single root object is supported', () => {
  assert.deepEqual(plan([]), { actions: [], stats: { bookmarks: 0, folders: 0, merged: 0, skipped: 0 }, warnings: [] });
  assert.equal(buildImportPlan({ existingTree: tree()[0], entries: [entry(link('Site'))] }).stats.bookmarks, 1);
});

const incoming = (id, title = 'Incoming', url = 'https://example.com/a') => ({ id, title, url });
const review = (entries, options = {}) => plan(entries, { duplicatePolicy: 'review', ...options });

test('review exposes every local URL match, inherited locks, and a destination-first default target', () => {
  const existingTree = tree();
  existingTree[0].children[1].children.push({ id: '21', title: 'Destination copy', url: 'HTTPS://EXAMPLE.COM:443/a' });
  existingTree[0].children.push({ id: '3', title: 'Company', unmodifiable: 'managed', children: [
    { id: '30', title: 'Nested', children: [{ id: '31', title: 'Locked copy', url: 'https://example.com/a' }] },
  ] });
  const result = review([entry(incoming('arrival'), '2')], { existingTree, duplicateScope: 'global' });
  assert.deepEqual(result.stats, { bookmarks: 0, folders: 0, merged: 0, skipped: 0, updated: 0 });
  assert.deepEqual(result.conflicts, [{ key: 'id:arrival', incomingTitle: 'Incoming', incomingUrl: 'https://example.com/a', parentRef: '2', choice: null, targetId: '21', matches: [
    { id: '10', title: 'Existing', url: 'https://example.com/a', parentId: '1', locked: false },
    { id: '21', title: 'Destination copy', url: 'HTTPS://EXAMPLE.COM:443/a', parentId: '2', locked: false },
    { id: '31', title: 'Locked copy', url: 'https://example.com/a', parentId: '30', locked: true },
  ] }]);
  assert.equal(result.actions[0].type, 'unresolved');
  const local = review([entry(incoming('arrival'), '2')], { existingTree });
  assert.deepEqual(local.conflicts[0].matches.map(match => match.id), ['21']);
});

test('review identities prefer incoming IDs and otherwise use unique traversal paths', () => {
  const entries = [entry(incoming('__proto__')), entry(folder('Work', [link('First docs', 'https://docs.example/'), link('Second docs', 'https://docs.example/')]))];
  const result = review(entries);
  assert.deepEqual(result.conflicts.map(conflict => conflict.key), ['id:__proto__', 'path:1/0', 'path:1/1']);
  const decisions = Object.create(null);
  decisions['id:__proto__'] = { choice: 'skip' };
  decisions['path:1/0'] = { choice: 'keep' };
  decisions['path:1/1'] = { choice: 'skip' };
  const resolved = review(entries, { duplicateDecisions: decisions });
  assert.equal(resolved.actions.some(action => action.type === 'unresolved'), false);
  assert.deepEqual(resolved.conflicts.map(conflict => conflict.choice), ['skip', 'keep', 'skip']);
  const reversed = review([entry(incoming('second')), entry(incoming('first'))]);
  assert.deepEqual(reversed.conflicts.map(conflict => conflict.key), ['id:second', 'id:first']);
});

test('review skip and keep retain their selected choices and preserve insertion order', () => {
  const result = review([entry(incoming('skip')), entry(incoming('keep')), entry(link('New'))], {
    position: 'start', duplicateDecisions: { 'id:skip': { choice: 'skip' }, 'id:keep': { choice: 'keep' } },
  });
  assert.deepEqual(result.actions.map(action => action.type), ['skip', 'create-bookmark', 'create-bookmark']);
  assert.deepEqual(writes(result).map(action => action.index), [0, 1]);
  assert.deepEqual(result.conflicts.map(conflict => conflict.choice), ['skip', 'keep']);
  assert.deepEqual(result.stats, { bookmarks: 2, folders: 0, merged: 0, skipped: 1, updated: 0 });
});

test('replace updates the explicitly selected local ID in its actual parent without moving it', () => {
  const existingTree = tree();
  existingTree[0].children[1].children.push({ id: '21', title: 'Second copy', url: 'https://example.com/a' });
  const result = review([entry(incoming('replacement', 'New title', 'HTTPS://EXAMPLE.COM:443/a'))], {
    existingTree, duplicateScope: 'global', duplicateDecisions: { 'id:replacement': { choice: 'replace', targetId: '21' } },
  });
  assert.deepEqual(result.actions[0], {
    type: 'update-bookmark', key: 'review:1', parentRef: '2', existingId: '21', title: 'New title', url: 'HTTPS://EXAMPLE.COM:443/a',
    before: { title: 'Second copy', url: 'https://example.com/a', parentId: '2' }, resolution: 'replace', conflictKey: 'id:replacement',
  });
  assert.equal(result.stats.updated, 1);
  assert.equal(result.stats.bookmarks, 0);
  assert.equal(result.conflicts[0].targetId, '21');
});

test('merge preserves the stored URL and appends distinct titles only once across later imports', () => {
  const existingTree = tree();
  const local = existingTree[0].children[0].children[0];
  local.url = 'HTTPS://EXAMPLE.COM:443/a';
  const entries = [entry(incoming('merge', 'Incoming'))];
  const options = { existingTree, duplicateDecisions: { 'id:merge': { choice: 'merge', targetId: '10' } } };
  const first = review(entries, options);
  assert.equal(first.actions[0].title, 'Existing · Incoming');
  assert.equal(first.actions[0].url, 'HTTPS://EXAMPLE.COM:443/a');
  local.title = first.actions[0].title;
  const second = review(entries, options);
  assert.equal(second.actions[0].type, 'unchanged');
  assert.equal(second.stats.updated, 0);
  assert.equal(second.conflicts[0].choice, 'merge');
  assert.equal(second.conflicts[0].targetId, '10');
});

test('merge handles empty and compound titles without repeated title components', () => {
  const cases = [
    ['Local', '', 'Local', 'unchanged'],
    ['', 'Incoming', 'Incoming', 'update-bookmark'],
    ['', '', '', 'unchanged'],
    ['Local · Incoming', 'Incoming · More · Local', 'Local · Incoming · More', 'update-bookmark'],
    ['  Local  ', 'Local', '  Local  ', 'unchanged'],
  ];
  for (const [localTitle, incomingTitle, expectedTitle, expectedType] of cases) {
    const existingTree = tree(); existingTree[0].children[0].children[0].title = localTitle;
    const result = review([entry(incoming('merge', incomingTitle))], { existingTree, duplicateDecisions: { 'id:merge': { choice: 'merge', targetId: '10' } } });
    assert.equal(result.actions[0].title, expectedTitle);
    assert.equal(result.actions[0].type, expectedType);
  }
});

test('multiple incoming updates predict sequential before states without mutating any inputs', () => {
  const existingTree = tree();
  const entries = [entry(incoming('one', 'First', 'HTTPS://EXAMPLE.COM:443/a')), entry(incoming('two', 'Second')), entry(incoming('three', 'Second'))];
  const duplicateDecisions = {
    'id:one': { choice: 'replace', targetId: '10' }, 'id:two': { choice: 'merge', targetId: '10' }, 'id:three': { choice: 'merge', targetId: '10' },
  };
  const input = { existingTree, duplicateDecisions };
  const before = structuredClone({ entries, ...input });
  const result = review(entries, input);
  assert.deepEqual(result.actions.map(action => action.type), ['update-bookmark', 'update-bookmark', 'unchanged']);
  assert.deepEqual(result.actions[1].before, { title: 'First', url: 'HTTPS://EXAMPLE.COM:443/a', parentId: '1' });
  assert.deepEqual(result.actions[2].before, { title: 'First · Second', url: 'HTTPS://EXAMPLE.COM:443/a', parentId: '1' });
  assert.equal(result.conflicts[1].matches[0].title, 'First');
  assert.equal(result.conflicts[0].matches[0].title, 'Existing');
  assert.equal(result.stats.updated, 2);
  assert.deepEqual({ entries, ...input }, before);
  assert.deepEqual(review(entries, input), result);
});

test('replace and merge require an explicit, in-scope target and never use the suggested default implicitly', () => {
  for (const choice of ['replace', 'merge']) {
    for (const targetId of [undefined, '', 'missing', '20', '11']) {
      const result = review([entry(incoming('target'))], { duplicateDecisions: { 'id:target': { choice, ...(targetId === undefined ? {} : { targetId }) } } });
      assert.equal(result.actions[0].type, 'unresolved', `${choice}: ${targetId}`);
      assert.equal(result.stats.updated, 0);
      assert.equal(result.conflicts[0].choice, choice);
      assert.equal(result.conflicts[0].targetId, targetId || null);
    }
  }
});

test('losing the last target or changing its URL leaves replacement unresolved instead of creating an item', () => {
  const entries = [entry(incoming('stale'))];
  const duplicateDecisions = { 'id:stale': { choice: 'replace', targetId: '10' } };
  for (const change of ['remove', 'change-url']) {
    const existingTree = tree();
    if (change === 'remove') existingTree[0].children[0].children.shift();
    else existingTree[0].children[0].children[0].url = 'https://different.example/';
    const result = review(entries, { existingTree, duplicateDecisions });
    assert.equal(result.actions[0].type, 'unresolved');
    assert.deepEqual(result.conflicts[0].matches, []);
    assert.equal(result.conflicts[0].targetId, '10');
    assert.equal(result.stats.bookmarks, 0);
  }
});

test('target movement leaves destination review unresolved and changes global review before metadata', () => {
  const entries = [entry(incoming('moved'))];
  const duplicateDecisions = { 'id:moved': { choice: 'replace', targetId: '10' } };
  const before = review(entries, { duplicateScope: 'global', duplicateDecisions });
  const existingTree = tree();
  const moved = existingTree[0].children[0].children.shift();
  existingTree[0].children[1].children.push(moved);
  const local = review(entries, { existingTree, duplicateDecisions });
  assert.equal(local.actions[0].type, 'unresolved');
  const global = review(entries, { existingTree, duplicateDecisions, duplicateScope: 'global' });
  assert.equal(global.actions[0].type, 'update-bookmark');
  assert.equal(global.actions[0].parentRef, '2');
  assert.equal(global.actions[0].before.parentId, '2');
  assert.notDeepEqual(global.actions, before.actions);
});

test('managed ancestor matches may be skipped or copied, but cannot be updated', () => {
  const existingTree = tree();
  existingTree[0].children[0].children.shift();
  existingTree[0].children.push({ id: '3', title: 'Managed', folderType: 'managed', children: [
    { id: '30', title: 'Nested', children: [{ id: '31', title: 'Locked', url: 'https://example.com/a' }] },
  ] });
  for (const [choice, expectedType] of [['skip', 'skip'], ['keep', 'create-bookmark'], ['replace', 'unresolved'], ['merge', 'unresolved']]) {
    const result = review([entry(incoming('managed'))], { existingTree, duplicateScope: 'global', duplicateDecisions: { 'id:managed': { choice, targetId: '31' } } });
    assert.equal(result.actions[0].type, expectedType);
    assert.equal(result.conflicts[0].matches[0].locked, true);
  }
});

test('duplicates only within the incoming batch expose no local targets and allow only skip or keep', () => {
  const entries = [entry(incoming('first', 'One', 'https://new.example/')), entry(incoming('second', 'Two', 'https://new.example/'))];
  const undecided = review(entries);
  assert.equal(undecided.conflicts.length, 1);
  assert.deepEqual(undecided.conflicts[0].matches, []);
  assert.equal(undecided.conflicts[0].targetId, null);
  for (const [choice, expectedType] of [['skip', 'skip'], ['keep', 'create-bookmark'], ['replace', 'unresolved'], ['merge', 'unresolved']]) {
    const result = review(entries, { duplicateDecisions: { 'id:second': { choice, targetId: 'new:1' } } });
    assert.equal(result.actions[1].type, expectedType);
  }
});

test('same-value replacements are explicit no-ops and updates do not consume start insertion indices', () => {
  const same = review([entry(incoming('same', 'Existing'))], { duplicateDecisions: { 'id:same': { choice: 'replace', targetId: '10' } } });
  assert.equal(same.actions[0].type, 'unchanged');
  assert.equal(same.conflicts[0].choice, 'replace');
  assert.equal(same.stats.updated, 0);
  const result = review([entry(incoming('update', 'Updated')), entry(link('New'))], {
    position: 'start', duplicateDecisions: { 'id:update': { choice: 'replace', targetId: '10' } },
  });
  assert.equal(result.actions[0].index, undefined);
  assert.equal(result.actions[1].index, 0);
});

test('invalid decision maps fail clearly and invalid individual choices remain unresolved', () => {
  for (const duplicateDecisions of [null, [], 'skip', new Map()]) {
    assert.throws(() => review([], { duplicateDecisions }), /plain object/);
  }
  const result = review([entry(incoming('invalid'))], { duplicateDecisions: { 'id:invalid': { choice: 'overwrite' } } });
  assert.equal(result.conflicts[0].choice, null);
  assert.equal(result.actions[0].type, 'unresolved');
  assert.deepEqual(review([]), { actions: [], stats: { bookmarks: 0, folders: 0, merged: 0, skipped: 0, updated: 0 }, warnings: [], conflicts: [] });
});
