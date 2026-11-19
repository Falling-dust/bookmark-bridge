import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { resolve, join, dirname, basename } from 'node:path';
import { createPreviewServer } from './serve.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
let playwright;
try {
  if (process.env.PLAYWRIGHT_MODULE) {
    const loaded = await import(pathToFileURL(resolve(process.env.PLAYWRIGHT_MODULE)).href);
    playwright = loaded.default ?? loaded;
  } else playwright = createRequire(import.meta.url)('playwright');
  if (!playwright?.chromium) throw new Error('The selected module does not export Playwright Chromium.');
} catch (error) {
  throw new Error('Unable to load Playwright. Run "npm install --no-save playwright" in the source checkout, or set PLAYWRIGHT_MODULE to the path of Playwright\'s index.mjs. ' + error.message, { cause: error });
}
const output = join(root, 'test-results'); await mkdir(output, { recursive: true });
const transferFile = (name, children) => ({ name, mimeType: 'application/json', buffer: Buffer.from(JSON.stringify({ format: 'bookmark-bridge', version: 1, children })) });
const historyRow = (page, filename) => page.locator('.history-item').filter({ has: page.getByText(filename, { exact: true }) });
const conflictRow = (page, incomingTitle) => page.locator('[data-conflict-row]').filter({ hasText: incomingTitle });
async function loadImport(page, filename, children) {
  await page.locator('[data-view="import"]').first().click();
  await page.locator('#import-file').setInputFiles(transferFile(filename, children));
  await page.locator('.file-banner').getByText(filename, { exact: true }).waitFor();
  await page.locator('#preview-button').waitFor();
}
async function preview(page) {
  const previous = await page.$('#apply-import');
  await page.locator('#preview-button').click();
  if (previous) { await page.waitForFunction(element => !element.isConnected, previous); await previous.dispose(); }
  await page.locator('#apply-import').waitFor();
}
async function decide(page, title, value, selector = '[data-conflict-choice]') {
  const row = conflictRow(page, title);
  assert.equal(await row.count(), 1, `One review row for ${title}`);
  const previous = await row.elementHandle();
  await row.locator(selector).selectOption(value);
  // Changing a select updates its DOM value before asynchronous replanning finishes.
  // Wait for the actual replacement row, so assertions cannot inspect the old plan.
  await page.waitForFunction(element => !element.isConnected, previous);
  await previous.dispose();
  await row.waitFor();
  assert.equal(await row.locator(selector).inputValue(), value);
}
async function apply(page, filename) {
  assert.equal(await page.locator('#apply-import').isEnabled(), true, `${filename} is ready to commit`);
  await page.locator('#apply-import').click();
  const row = historyRow(page, filename);
  await row.locator('[data-undo]').waitFor();
  await page.locator('#busy-overlay').waitFor({ state: 'hidden' });
  assert.equal(await row.count(), 1, 'Wait for the exact newly imported file, never a stale history row');
  assert.match(await row.locator('.badge').textContent(), /complete/);
  return row;
}
async function undo(page, filename, partial = false) {
  const row = historyRow(page, filename);
  await row.locator('[data-undo]').click();
  await page.locator('[data-confirm]').click();
  if (partial) await row.getByRole('button', { name: 'Retry undo', exact: true }).waitFor();
  else await row.getByText('No action needed', { exact: true }).waitFor();
  await page.locator('#busy-overlay').waitFor({ state: 'hidden' });
  assert.match(await row.locator('.badge').textContent(), partial ? /undo partial/ : /undone/);
}
async function assertStat(page, label, expected) {
  const card = page.locator('.stat-card').filter({ has: page.getByText(label, { exact: true }) });
  assert.equal(await card.locator('.stat-value').textContent(), String(expected), label);
}
const browser = await playwright.chromium.launch({ headless: true, channel: process.env.BROWSER_CHANNEL || 'msedge' });
const server = createPreviewServer(); await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const base = `http://127.0.0.1:${server.address().port}`;
const errors = [];
try {
  const page = await browser.newPage({ viewport: { width: 1540, height: 1050 } });
  page.on('pageerror', error => errors.push(error.message));
  await page.goto(base); await page.locator('#export-button').waitFor();
  assert.equal(await page.locator('#demo-badge').isVisible(), true);
  await page.locator('[data-action="select-node"][data-id="10"]').check();
  assert.match(await page.locator('#export-button').textContent(), /4 bookmarks/);
  await page.locator('[data-action="select-node"][data-id="20"]').check();
  await page.locator('#export-selection [data-id="20"][data-direction="-1"]').click();
  assert.equal(await page.locator('#export-selection .tree-row').first().getAttribute('data-node-id'), '20');
  await page.locator('[data-action="select-node"][data-id="50"]').check();
  await page.locator('#export-selection [data-id="50"][data-direction="-1"]').click();
  await page.locator('#export-selection [data-id="50"][data-direction="-1"]').click();
  assert.equal(await page.locator('#export-selection .tree-row').first().getAttribute('data-node-id'), '50', 'Export order crosses browser root boundaries');
  // A title/URL cannot inject markup into the extension document.
  await page.evaluate(() => { document.activeElement?.blur(); scrollTo(0, 0); });
  await page.screenshot({ path: join(output, 'export-desktop.png'), fullPage: true });
  const downloadEvent = page.waitForEvent('download'); await page.locator('#export-button').click(); const download = await downloadEvent;
  const exported = await readFile(await download.path(), 'utf8'); assert(exported.includes('NETSCAPE-Bookmark-file-1')); assert(exported.indexOf('Development') < exported.indexOf('Design &amp; inspiration'));
  // The flattened export can be independently reordered.
  await page.locator('#preserve-folders').uncheck();
  const before = await page.locator('#export-selection .tree-row').nth(1).getAttribute('data-node-id');
  await page.locator(`#export-selection [data-id="${before}"][data-direction="-1"]`).click();
  assert.equal(await page.locator('#export-selection .tree-row').first().getAttribute('data-node-id'), before);
  await page.locator('[data-view="import"]').first().click();
  const payload = { format: 'bookmark-bridge', version: 1, children: [
    { id: '__proto__', title: 'Development', children: [{ title: 'GitHub copy', url: 'https://github.com/' }, { title: '<img src=x onerror=alert(1)>', url: 'https://example.org/new' }] },
    { title: 'Personal arrival', url: 'https://example.net/arrival' }
  ] };
  await page.locator('#import-file').setInputFiles({ name: 'test-transfer.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify(payload)) });
  await page.locator('#preview-button').waitFor();
  const placements = page.locator('.destination-select'); await placements.nth(1).selectOption('2');
  await page.locator('#preview-button').click();
  await page.locator('#apply-import').waitFor();
  await assertStat(page, 'New bookmarks', 2); await assertStat(page, 'New folders', 0);
  await assertStat(page, 'Folders merged', 1); await assertStat(page, 'Duplicates skipped', 1);
  assert.equal(await page.locator('#workspace img').count(), 0);
  await page.evaluate(() => { document.activeElement?.blur(); document.querySelector('#toast').classList.remove('visible'); scrollTo(0, 0); });
  await page.screenshot({ path: join(output, 'import-desktop.png'), fullPage: true });
  await apply(page, 'test-transfer.json');
  const demoTree = await page.evaluate(() => JSON.parse(localStorage.getItem('bridge-demo-tree')));
  assert.equal(demoTree[0].children[1].children.at(-1).title, 'Personal arrival');
  await undo(page, 'test-transfer.json');
  const undoneTree = await page.evaluate(() => JSON.parse(localStorage.getItem('bridge-demo-tree')));
  assert.equal(JSON.stringify(undoneTree).includes('example.org/new'), false);
  assert.equal(JSON.stringify(undoneTree).includes('https://github.com/'), true);
  // Standard browser root wrappers can be removed before routing their contents.
  await page.locator('[data-view="import"]').first().click();
  await page.locator('#import-file').setInputFiles({ name: 'wrapped.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify({ format: 'bookmark-bridge', version: 1, children: [{ title: 'Bookmarks bar', children: [{ title: 'One', url: 'https://example.com/one' }, { title: 'Two', url: 'https://example.com/two' }] }] })) });
  await page.locator('.file-banner').getByText('wrapped.json', { exact: true }).waitFor();
  assert.equal(await page.locator('.destination-select').count(), 1);
  await page.locator('[data-action="unwrap-import"]').click();
  assert.equal(await page.locator('.destination-select').count(), 2);
  // Review and update-only undo also work in the local demo adapter.
  await loadImport(page, 'demo-overlap.json', [{ id: 'demo-overlap', title: 'GitHub incoming title', url: 'https://github.com/' }]);
  await page.locator('#default-destination').selectOption('20');
  await page.locator('#duplicate-policy').selectOption('review');
  await preview(page);
  assert.equal(await page.locator('[data-conflict-row]').count(), 1);
  assert.equal(await page.locator('#apply-import').isDisabled(), true, 'Unresolved overlaps cannot be committed');
  const demoConflict = await conflictRow(page, 'GitHub incoming title').textContent();
  assert(demoConflict.includes('GitHub'), 'Review shows the existing title');
  assert(demoConflict.includes('GitHub incoming title'), 'Review shows the incoming title');
  await decide(page, 'GitHub incoming title', 'merge');
  await assertStat(page, 'New bookmarks', 0);
  await apply(page, 'demo-overlap.json');
  const demoMerged = await page.evaluate(() => JSON.parse(localStorage.getItem('bridge-demo-tree'))[0].children[0].children.find(node => node.id === '20').children.find(node => node.id === '21'));
  assert.equal(demoMerged.title, 'GitHub · GitHub incoming title');
  assert.equal(demoMerged.url, 'https://github.com/');
  assert.equal(demoMerged.parentId, '20');
  await undo(page, 'demo-overlap.json');
  const demoRestored = await page.evaluate(() => JSON.parse(localStorage.getItem('bridge-demo-tree'))[0].children[0].children.find(node => node.id === '20').children.find(node => node.id === '21'));
  assert.equal(demoRestored.title, 'GitHub');
  await page.locator('[data-view="export"]').first().click();
  await page.setViewportSize({ width: 760, height: 1000 });
  await page.screenshot({ path: join(output, 'export-narrow.png'), fullPage: true });
  assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), 'Narrow layout should not overflow horizontally');
  assert.deepEqual(errors, []);
  console.log('PASS: browser demo selection, nested/flat ordering, HTML download, placement, deduplication, inert markup, overlap review, update-only merge/undo, narrow layout.');
} finally { await browser.close(); await new Promise(resolve => server.close(resolve)); }

// A unique profile prevents prior test imports/history or a user's bookmarks from
// affecting a run. Only this exact generated child of test-results is removed.
const profilePath = await mkdtemp(join(output, 'edge-test-profile-'));
let extensionContext;
let extensionPage;
try {
extensionContext = await playwright.chromium.launchPersistentContext(profilePath, {
  headless: true, channel: process.env.BROWSER_CHANNEL || 'msedge', viewport: { width: 1440, height: 1000 },
  args: [`--disable-extensions-except=${root}`, `--load-extension=${root}`]
});
  let worker = extensionContext.serviceWorkers()[0];
  if (!worker) worker = await extensionContext.waitForEvent('serviceworker', { timeout: 15000 });
  const id = new URL(worker.url()).host;
  const page = extensionPage = await extensionContext.newPage();
  page.on('pageerror', error => errors.push(error.message));
  await page.goto(`chrome-extension://${id}/manager.html`);
  await page.locator('#export-button').waitFor();
  assert.equal(await page.locator('#demo-badge').isVisible(), false);
  const folders = await worker.evaluate(async () => (await chrome.bookmarks.getTree())[0].children);
  const target = folders.find(node => node.children && !node.unmodifiable);
  assert(target, 'A writable browser bookmark root exists');
  await loadImport(page, 'extension-test.json', [{ title: 'MV3 integration fixture', children: [{ title: 'Actual bookmark API', url: 'https://example.com/mv3-integration' }] }]);
  await page.locator('#default-destination').selectOption(target.id);
  await preview(page); await apply(page, 'extension-test.json');
  assert.equal((await worker.evaluate(() => chrome.bookmarks.search({ url: 'https://example.com/mv3-integration' }))).length, 1);
  await undo(page, 'extension-test.json');
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
  await preview(page);
  assert.equal(await page.locator('[data-conflict-row]').count(), 0);
  await assertStat(page, 'New bookmarks', 1);
  assert.equal(await page.locator('#apply-import').isEnabled(), true);
  await page.locator('#duplicate-scope').selectOption('global');
  await preview(page);
  assert.equal(await page.locator('[data-conflict-row]').count(), 1);
  assert.equal(await page.locator('#apply-import').isDisabled(), true);
  assert.match(await conflictRow(page, 'Incoming scope title').textContent(), /Only in another folder/);
  await decide(page, 'Incoming scope title', 'skip');
  assert.equal(await page.locator('#apply-import').isDisabled(), true, 'An all-skip plan has no writes');
  assert.deepEqual(await snapshot(), beforeReview, 'Preview and decisions never mutate browser bookmarks');

  // All decisions in one real API transaction, including a deliberately chosen
  // match outside the requested destination when searching the whole browser.
  const incoming = ['skip', 'keep', 'replace', 'merge'].map(choice => ({ id: `incoming-${choice}`, title: `Incoming ${choice} title`, url: fixture[choice].url }));
  incoming[3].url = 'HTTPS://OVERLAP.EXAMPLE:443/merge';
  await loadImport(page, 'four-decisions.json', incoming);
  await preview(page);
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
  await decide(page, 'Incoming replace title', fixture.alternate.id, '[data-conflict-target]');
  for (const [index, choice] of ['skip', 'keep', 'replace', 'merge'].entries()) {
    await decide(page, `Incoming ${choice} title`, choice);
    assert.equal(await page.locator('#apply-import').isDisabled(), index < 3, 'Every overlap must be resolved before committing');
  }
  await assertStat(page, 'New bookmarks', 1);
  await assertStat(page, 'Bookmark updates', 2);
  await assertStat(page, 'Duplicates skipped', 1);
  assert.deepEqual(await snapshot(), beforeReview, 'A fully resolved preview still makes no writes');
  await page.screenshot({ path: join(output, 'overlap-resolved-desktop.png'), fullPage: true });
  await apply(page, 'four-decisions.json');
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
  await undo(page, 'four-decisions.json');
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
  await preview(page);
  await decide(page, 'Updated replacement only', 'replace');
  await decide(page, 'Updated merge only', 'merge');
  await assertStat(page, 'New bookmarks', 0);
  await assertStat(page, 'New folders', 0);
  await assertStat(page, 'Bookmark updates', 2);
  await apply(page, 'updates-only.json');
  assert.equal((await getBookmark(fixture.replace.id)).title, 'Updated replacement only');
  assert.equal((await getBookmark(fixture.merge.id)).title, 'Local merge title · Updated merge only');
  await worker.evaluate(async id => chrome.bookmarks.update(id, { title: 'Edited after import by the user', url: 'https://overlap.example/user-edit' }), fixture.merge.id);
  await undo(page, 'updates-only.json', true);
  assert.equal((await getBookmark(fixture.replace.id)).title, fixture.replace.title, 'Undo restores the unedited original title');
  const edited = await getBookmark(fixture.merge.id);
  assert.equal(edited.title, 'Edited after import by the user');
  assert.equal(edited.url, 'https://overlap.example/user-edit');
  assert.equal(edited.parentId, fixture.destination.id);
  assert.deepEqual(errors, [], 'No unhandled browser errors in demo or extension');
  console.log('PASS: actual MV3 extension, isolated profile, exact-file history waits, folder/global overlap scope, skip/keep/replace/merge, multiple-target choice, unchanged preview, update-only import, safe restoration and preservation of later user edits.');
} catch (error) {
  if (extensionPage && !extensionPage.isClosed()) await extensionPage.screenshot({ path: join(output, 'extension-failure.png'), fullPage: true }).catch(() => {});
  throw error;
} finally {
  await extensionContext?.close();
  assert.equal(dirname(profilePath), output, 'Cleanup stays within test-results');
  assert(basename(profilePath).startsWith('edge-test-profile-'), 'Cleanup only removes this run’s generated profile');
  await rm(profilePath, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
}
