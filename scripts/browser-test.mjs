import assert from 'node:assert/strict';
import { mkdir, readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { resolve, join } from 'node:path';
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
  assert.deepEqual(await page.locator('.stat-value').allTextContents(), ['2', '0', '1', '1']);
  assert.equal(await page.locator('#workspace img').count(), 0);
  await page.evaluate(() => { document.activeElement?.blur(); document.querySelector('#toast').classList.remove('visible'); scrollTo(0, 0); });
  await page.screenshot({ path: join(output, 'import-desktop.png'), fullPage: true });
  await page.locator('#apply-import').click(); await page.locator('[data-undo]').waitFor();
  const demoTree = await page.evaluate(() => JSON.parse(localStorage.getItem('bridge-demo-tree')));
  assert.equal(demoTree[0].children[1].children.at(-1).title, 'Personal arrival');
  await page.locator('[data-undo]').click(); await page.locator('[data-confirm]').click();
  await page.getByText('No action needed', { exact: true }).waitFor();
  const undoneTree = await page.evaluate(() => JSON.parse(localStorage.getItem('bridge-demo-tree')));
  assert.equal(JSON.stringify(undoneTree).includes('example.org/new'), false);
  assert.equal(JSON.stringify(undoneTree).includes('https://github.com/'), true);
  // Standard browser root wrappers can be removed before routing their contents.
  await page.locator('[data-view="import"]').first().click();
  await page.locator('#import-file').setInputFiles({ name: 'wrapped.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify({ format: 'bookmark-bridge', version: 1, children: [{ title: 'Bookmarks bar', children: [{ title: 'One', url: 'https://example.com/one' }, { title: 'Two', url: 'https://example.com/two' }] }] })) });
  assert.equal(await page.locator('.destination-select').count(), 1);
  await page.locator('[data-action="unwrap-import"]').click();
  assert.equal(await page.locator('.destination-select').count(), 2);
  await page.locator('[data-view="export"]').first().click();
  await page.setViewportSize({ width: 760, height: 1000 });
  await page.screenshot({ path: join(output, 'export-narrow.png'), fullPage: true });
  assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), 'Narrow layout should not overflow horizontally');
  assert.deepEqual(errors, []);
  console.log('PASS: browser demo selection, nested/flat ordering, HTML download, placement, merge, deduplication, inert markup, import, undo, narrow layout.');
} finally { await browser.close(); await new Promise(resolve => server.close(resolve)); }

// Exercise a genuinely loaded MV3 extension, using a fresh isolated profile.
const extensionContext = await playwright.chromium.launchPersistentContext(join(output, 'edge-test-profile'), {
  headless: true, channel: process.env.BROWSER_CHANNEL || 'msedge', viewport: { width: 1440, height: 1000 },
  args: [`--disable-extensions-except=${root}`, `--load-extension=${root}`]
});
try {
  let worker = extensionContext.serviceWorkers()[0];
  if (!worker) worker = await extensionContext.waitForEvent('serviceworker', { timeout: 15000 });
  const id = new URL(worker.url()).host;
  const page = await extensionContext.newPage(); await page.goto(`chrome-extension://${id}/manager.html`);
  await page.locator('#export-button').waitFor();
  assert.equal(await page.locator('#demo-badge').isVisible(), false);
  const folders = await worker.evaluate(async () => (await chrome.bookmarks.getTree())[0].children);
  const target = folders.find(node => node.children && !node.unmodifiable);
  await page.locator('[data-view="import"]').first().click();
  const payload = { format: 'bookmark-bridge', version: 1, children: [{ title: 'MV3 integration fixture', children: [{ title: 'Actual bookmark API', url: 'https://example.com/mv3-integration' }] }] };
  await page.locator('#import-file').setInputFiles({ name: 'extension-test.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify(payload)) });
  await page.locator('#default-destination').selectOption(target.id);
  await page.locator('#preview-button').click(); await page.locator('#apply-import').click();
  await page.locator('[data-undo]').first().waitFor();
  assert.equal((await worker.evaluate(() => chrome.bookmarks.search({ url: 'https://example.com/mv3-integration' }))).length, 1);
  await page.locator('[data-undo]').first().click(); await page.locator('[data-confirm]').click();
  await page.getByText('No action needed', { exact: true }).first().waitFor();
  assert.equal((await worker.evaluate(() => chrome.bookmarks.search({ url: 'https://example.com/mv3-integration' }))).length, 0);
  console.log('PASS: actual MV3 extension load, bookmarks permission, service worker import messaging, Chrome bookmark creation, persistent journal and undo.');
} finally { await extensionContext.close(); }
