import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { loadImport, previewImport, chooseConflict, applyImport, undoImport, assertStat, conflictRow } from './browser-helpers.mjs';

async function checkOverlappingDrops(page) {
  await page.locator('[data-view="import"]').click();
  const result = await page.evaluate(() => {
    function drop(file) {
      const dataTransfer = new DataTransfer();
      dataTransfer.items.add(file);
      document.dispatchEvent(new DragEvent('drop', { dataTransfer, cancelable: true }));
    }
    // Both drops arrive in one turn, before the first File.text() can finish.
    drop(new File(['[]'], 'first.json'));
    const reading = document.querySelector('#workspace').inert;
    drop(new File(['[]'], 'second.json'));
    return reading;
  });
  assert.equal(result, true, 'Reading a file prevents another transfer from starting');
  await page.locator('#busy-overlay').waitFor({ state: 'hidden' });
  assert.equal(await page.locator('.file-banner strong').textContent(), 'first.json');
}

export async function checkDemo(page, output) {
  await page.locator('#export-button').waitFor();
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
  await page.evaluate(() => { document.activeElement?.blur(); scrollTo(0, 0); });
  await page.screenshot({ path: join(output, 'export-desktop.png'), fullPage: true });
  const downloadEvent = page.waitForEvent('download');
  await page.locator('#export-button').click();
  const download = await downloadEvent;
  const exported = await readFile(await download.path(), 'utf8');
  assert(exported.includes('NETSCAPE-Bookmark-file-1'));
  assert(exported.indexOf('Development') < exported.indexOf('Design &amp; inspiration'));
  // The flattened export can be independently reordered.
  await page.locator('#preserve-folders').uncheck();
  const before = await page.locator('#export-selection .tree-row').nth(1).getAttribute('data-node-id');
  await page.locator(`#export-selection [data-id="${before}"][data-direction="-1"]`).click();
  assert.equal(await page.locator('#export-selection .tree-row').first().getAttribute('data-node-id'), before);
  await checkOverlappingDrops(page);
  await loadImport(page, 'test-transfer.json', [
    { id: '__proto__', title: 'Development', children: [{ title: 'GitHub copy', url: 'https://github.com/' }, { title: '<img src=x onerror=alert(1)>', url: 'https://example.org/new' }] },
    { title: 'Personal arrival', url: 'https://example.net/arrival' }
  ]);
  await page.locator('.destination-select').nth(1).selectOption('2');
  await previewImport(page);
  await assertStat(page, 'New bookmarks', 2);
  await assertStat(page, 'New folders', 0);
  await assertStat(page, 'Folders merged', 1);
  await assertStat(page, 'Duplicates skipped', 1);
  assert.equal(await page.locator('#workspace img').count(), 0, 'Bookmark titles render as text, not executable HTML');
  await page.evaluate(() => { document.activeElement?.blur(); document.querySelector('#toast').classList.remove('visible'); scrollTo(0, 0); });
  await page.screenshot({ path: join(output, 'import-desktop.png'), fullPage: true });
  await applyImport(page, 'test-transfer.json');
  const demoTree = await page.evaluate(() => JSON.parse(localStorage.getItem('bridge-demo-tree')));
  assert.equal(demoTree[0].children[1].children.at(-1).title, 'Personal arrival');
  await undoImport(page, 'test-transfer.json');
  const undoneTree = await page.evaluate(() => JSON.parse(localStorage.getItem('bridge-demo-tree')));
  assert.equal(JSON.stringify(undoneTree).includes('example.org/new'), false);
  assert.equal(JSON.stringify(undoneTree).includes('https://github.com/'), true);
  // Standard browser root wrappers can be removed before routing their contents.
  await loadImport(page, 'wrapped.json', [{ title: 'Bookmarks bar', children: [
    { title: 'One', url: 'https://example.com/one' },
    { title: 'Two', url: 'https://example.com/two' }
  ] }]);
  assert.equal(await page.locator('.destination-select').count(), 1);
  await page.locator('[data-action="unwrap-import"]').click();
  assert.equal(await page.locator('.destination-select').count(), 2);
  // Review and update-only undo also work in the local demo adapter.
  await loadImport(page, 'demo-overlap.json', [{ id: 'demo-overlap', title: 'GitHub incoming title', url: 'https://github.com/' }]);
  await page.locator('#default-destination').selectOption('20');
  await page.locator('#duplicate-policy').selectOption('review');
  await previewImport(page);
  assert.equal(await page.locator('[data-conflict-row]').count(), 1);
  assert.equal(await page.locator('#apply-import').isDisabled(), true, 'Unresolved overlaps cannot be committed');
  const demoConflict = conflictRow(page, 'GitHub incoming title');
  assert.equal(await demoConflict.getByText('GitHub', { exact: true }).isVisible(), true, 'Review shows the existing title');
  assert.equal(await demoConflict.getByText('GitHub incoming title', { exact: true }).isVisible(), true, 'Review shows the incoming title');
  await chooseConflict(page, 'GitHub incoming title', 'merge');
  await assertStat(page, 'New bookmarks', 0);
  await applyImport(page, 'demo-overlap.json');
  const demoMerged = await page.evaluate(() => JSON.parse(localStorage.getItem('bridge-demo-tree'))[0].children[0].children.find(node => node.id === '20').children.find(node => node.id === '21'));
  assert.equal(demoMerged.title, 'GitHub · GitHub incoming title');
  assert.equal(demoMerged.url, 'https://github.com/');
  assert.equal(demoMerged.parentId, '20');
  await undoImport(page, 'demo-overlap.json');
  const demoRestored = await page.evaluate(() => JSON.parse(localStorage.getItem('bridge-demo-tree'))[0].children[0].children.find(node => node.id === '20').children.find(node => node.id === '21'));
  assert.equal(demoRestored.title, 'GitHub');
  await page.locator('[data-view="export"]').first().click();
  await page.setViewportSize({ width: 760, height: 1000 });
  await page.screenshot({ path: join(output, 'export-narrow.png'), fullPage: true });
  assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), 'Narrow layout should not overflow horizontally');
}
