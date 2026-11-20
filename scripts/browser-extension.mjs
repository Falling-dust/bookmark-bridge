import assert from 'node:assert/strict';
import { join } from 'node:path';
import { loadImport, previewImport, chooseConflict, applyImport, undoImport, assertStat, conflictRow } from './browser-helpers.mjs';

export async function checkExtension(page, worker, output) {
  await page.locator('#export-button').waitFor();
  assert.equal(await page.locator('#demo-badge').isVisible(), false);
  const folders = await worker.evaluate(async () => (await chrome.bookmarks.getTree())[0].children);
  const target = folders.find(node => node.children && !node.unmodifiable);
  assert(target, 'A writable browser bookmark root exists');
  await loadImport(page, 'extension-test.json', [{ title: 'MV3 integration fixture', children: [{ title: 'Actual bookmark API', url: 'https://example.com/mv3-integration' }] }]);
  await page.locator('#default-destination').selectOption(target.id);
  await previewImport(page);
  await applyImport(page, 'extension-test.json');
  assert.equal((await worker.evaluate(() => chrome.bookmarks.search({ url: 'https://example.com/mv3-integration' }))).length, 1);
  await undoImport(page, 'extension-test.json');
  assert.equal((await worker.evaluate(() => chrome.bookmarks.search({ url: 'https://example.com/mv3-integration' }))).length, 0);

  const fixture = await worker.evaluate(async parentId => {
    const destination = await chrome.bookmarks.create({ parentId, title: 'Review destination' });
    const elsewhere = await chrome.bookmarks.create({ parentId, title: 'Elsewhere in this browser' });
    const result = { destination, elsewhere };
    for (const choice of ['skip', 'keep', 'replace', 'merge']) {
      result[choice] = await chrome.bookmarks.create({ parentId: destination.id, title: `Local ${choice} title`, url: `https://overlap.example/${choice}` });
    }
    result.alternate = await chrome.bookmarks.create({ parentId: elsewhere.id, title: 'Other local replace title', url: 'https://overlap.example/replace' });
    result.scope = await chrome.bookmarks.create({ parentId: elsewhere.id, title: 'Only in another folder', url: 'https://overlap.example/scope' });
    return result;
  }, target.id);
  const getBookmark = id => worker.evaluate(async nodeId => (await chrome.bookmarks.get(nodeId))[0], id);
  const findURL = url => worker.evaluate(value => chrome.bookmarks.search({ url: value }), url);
  const snapshot = async () => worker.evaluate(() => chrome.bookmarks.getTree());
  const beforeReview = await snapshot();
  await page.locator('[data-view="export"]').first().click();
  await page.locator('#refresh-button').click();
  await page.locator('#library-tree').getByText('Review destination', { exact: true }).waitFor();

  // Destination matching does not confuse a bookmark in a different folder.
  await loadImport(page, 'scope-review.json', [{ title: 'Incoming scope title', url: fixture.scope.url }]);
  await page.locator('#default-destination').selectOption(fixture.destination.id);
  await page.locator('#duplicate-policy').selectOption('review');
  await page.locator('#duplicate-scope').selectOption('destination');
  await previewImport(page);
  assert.equal(await page.locator('[data-conflict-row]').count(), 0);
  await assertStat(page, 'New bookmarks', 1);
  assert.equal(await page.locator('#apply-import').isEnabled(), true);
  await page.locator('#duplicate-scope').selectOption('global');
  await previewImport(page);
  assert.equal(await page.locator('[data-conflict-row]').count(), 1);
  assert.equal(await page.locator('#apply-import').isDisabled(), true);
  assert.match(await conflictRow(page, 'Incoming scope title').textContent(), /Only in another folder/);
  await chooseConflict(page, 'Incoming scope title', 'skip');
  assert.equal(await page.locator('#apply-import').isDisabled(), true, 'An all-skip plan has no writes');
  assert.deepEqual(await snapshot(), beforeReview, 'Preview and decisions never mutate browser bookmarks');

  // Resolve all four choices, including a target outside the destination folder.
  const incoming = ['skip', 'keep', 'replace', 'merge'].map(choice => ({ id: `incoming-${choice}`, title: `Incoming ${choice} title`, url: fixture[choice].url }));
  incoming[3].url = 'HTTPS://OVERLAP.EXAMPLE:443/merge';
  await loadImport(page, 'four-decisions.json', incoming);
  await previewImport(page);
  assert.equal(await page.locator('[data-conflict-row]').count(), 4);
  assert.equal(await page.locator('#apply-import').isDisabled(), true);
  for (const choice of ['skip', 'keep', 'replace', 'merge']) {
    const text = await conflictRow(page, `Incoming ${choice} title`).textContent();
    assert(text.includes(`Incoming ${choice} title`), 'Incoming title is visible in its review row');
    assert(text.includes(`Local ${choice} title`), 'Existing title is visible in the same review row');
  }
  await page.screenshot({ path: join(output, 'overlap-review-desktop.png'), fullPage: true });
  const replacementOptions = await conflictRow(page, 'Incoming replace title').locator('[data-conflict-target] option').evaluateAll(options => options.map(option => option.value));
  assert(replacementOptions.includes(fixture.replace.id) && replacementOptions.includes(fixture.alternate.id), 'Multiple matches can be distinguished by actual target IDs');
  await chooseConflict(page, 'Incoming replace title', fixture.alternate.id, '[data-conflict-target]');
  for (const [index, choice] of ['skip', 'keep', 'replace', 'merge'].entries()) {
    await chooseConflict(page, `Incoming ${choice} title`, choice);
    assert.equal(await page.locator('#apply-import').isDisabled(), index < 3, 'Every overlap must be resolved before committing');
  }
  await assertStat(page, 'New bookmarks', 1);
  await assertStat(page, 'Bookmark updates', 2);
  await assertStat(page, 'Duplicates skipped', 1);
  assert.deepEqual(await snapshot(), beforeReview, 'A fully resolved preview still makes no writes');
  await page.screenshot({ path: join(output, 'overlap-resolved-desktop.png'), fullPage: true });
  await applyImport(page, 'four-decisions.json');
  assert.equal((await findURL(fixture.skip.url)).length, 1);
  assert.deepEqual(await getBookmark(fixture.skip.id), fixture.skip, 'Skip preserves the original bookmark exactly');
  const kept = await findURL(fixture.keep.url);
  assert.equal(kept.length, 2);
  const added = kept.find(node => node.id !== fixture.keep.id);
  assert.equal(added.title, 'Incoming keep title');
  assert.equal(added.parentId, fixture.destination.id);
  assert.deepEqual(await getBookmark(fixture.keep.id), fixture.keep);
  const replaced = await getBookmark(fixture.alternate.id);
  assert.equal(replaced.title, 'Incoming replace title');
  assert.equal(replaced.id, fixture.alternate.id);
  assert.equal(replaced.parentId, fixture.elsewhere.id, 'Replacing a globally matched bookmark preserves its folder');
  assert.equal(replaced.url, fixture.alternate.url);
  assert.equal((await getBookmark(fixture.replace.id)).title, fixture.replace.title, 'The other matching bookmark was not changed');
  const merged = await getBookmark(fixture.merge.id);
  assert.equal(merged.title, 'Local merge title · Incoming merge title');
  assert.equal(merged.url, fixture.merge.url, 'Merge preserves the stored URL');
  assert.equal(merged.parentId, fixture.destination.id);
  assert.equal((await findURL(fixture.merge.url)).length, 1, 'Merge updates the existing ID without creating a duplicate');
  await undoImport(page, 'four-decisions.json');
  assert.equal((await getBookmark(fixture.alternate.id)).title, fixture.alternate.title);
  assert.equal((await getBookmark(fixture.merge.id)).title, fixture.merge.title);
  assert.equal((await findURL(fixture.keep.url)).length, 1);
  assert.equal((await getBookmark(fixture.keep.id)).title, fixture.keep.title);

  // A transaction containing only updates is actionable. Undo restores an
  // untouched update while preserving a subsequent user edit to another one.
  await loadImport(page, 'updates-only.json', [
    { title: 'Updated replacement only', url: fixture.replace.url },
    { title: 'Updated merge only', url: fixture.merge.url }
  ]);
  await page.locator('#duplicate-scope').selectOption('destination');
  await previewImport(page);
  await chooseConflict(page, 'Updated replacement only', 'replace');
  await chooseConflict(page, 'Updated merge only', 'merge');
  await assertStat(page, 'New bookmarks', 0);
  await assertStat(page, 'New folders', 0);
  await assertStat(page, 'Bookmark updates', 2);
  await applyImport(page, 'updates-only.json');
  assert.equal((await getBookmark(fixture.replace.id)).title, 'Updated replacement only');
  assert.equal((await getBookmark(fixture.merge.id)).title, 'Local merge title · Updated merge only');
  await worker.evaluate(async id => chrome.bookmarks.update(id, { title: 'Edited after import by the user', url: 'https://overlap.example/user-edit' }), fixture.merge.id);
  await undoImport(page, 'updates-only.json', true);
  assert.equal((await getBookmark(fixture.replace.id)).title, fixture.replace.title, 'Undo restores the unedited original title');
  const edited = await getBookmark(fixture.merge.id);
  assert.equal(edited.title, 'Edited after import by the user');
  assert.equal(edited.url, 'https://overlap.example/user-edit');
  assert.equal(edited.parentId, fixture.destination.id);
}
