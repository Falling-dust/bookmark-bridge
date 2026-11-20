import assert from 'node:assert/strict';

const transferFile = (name, children) => ({
  name,
  mimeType: 'application/json',
  buffer: Buffer.from(JSON.stringify({ format: 'bookmark-bridge', version: 1, children }))
});
const historyRow = (page, filename) => page.locator('.history-item').filter({ has: page.getByText(filename, { exact: true }) });
export const conflictRow = (page, incomingTitle) => page.locator('[data-conflict-row]').filter({ hasText: incomingTitle });
export async function loadImport(page, filename, children) {
  await page.locator('[data-view="import"]').first().click();
  await page.locator('#import-file').setInputFiles(transferFile(filename, children));
  await page.locator('.file-banner').getByText(filename, { exact: true }).waitFor();
  await page.locator('#preview-button').waitFor();
}
export async function previewImport(page) {
  const previous = await page.$('#apply-import');
  await page.locator('#preview-button').click();
  if (previous) {
    await page.waitForFunction(element => !element.isConnected, previous);
    await previous.dispose();
  }
  await page.locator('#apply-import').waitFor();
}
export async function chooseConflict(page, title, value, selector = '[data-conflict-choice]') {
  const row = conflictRow(page, title);
  assert.equal(await row.count(), 1, `One review row for ${title}`);
  const previous = await row.elementHandle();
  await row.locator(selector).selectOption(value);
  // Select values change immediately; assertions must wait for the rebuilt plan.
  await page.waitForFunction(element => !element.isConnected, previous);
  await previous.dispose();
  await row.waitFor();
  assert.equal(await row.locator(selector).inputValue(), value);
}
export async function applyImport(page, filename) {
  assert.equal(await page.locator('#apply-import').isEnabled(), true, `${filename} is ready to commit`);
  await page.locator('#apply-import').click();
  const row = historyRow(page, filename);
  await row.locator('[data-undo]').waitFor();
  await page.locator('#busy-overlay').waitFor({ state: 'hidden' });
  assert.equal(await row.count(), 1, 'History identifies the imported file uniquely');
  assert.match(await row.locator('.badge').textContent(), /complete/);
  return row;
}
export async function undoImport(page, filename, partial = false) {
  const row = historyRow(page, filename);
  await row.locator('[data-undo]').click();
  await page.locator('[data-confirm]').click();
  if (partial) await row.getByRole('button', { name: 'Retry undo', exact: true }).waitFor();
  else await row.getByText('No action needed', { exact: true }).waitFor();
  await page.locator('#busy-overlay').waitFor({ state: 'hidden' });
  assert.match(await row.locator('.badge').textContent(), partial ? /undo partial/ : /undone/);
}
export async function assertStat(page, label, expected) {
  const card = page.locator('.stat-card').filter({ has: page.getByText(label, { exact: true }) });
  assert.equal(await card.locator('.stat-value').textContent(), String(expected), label);
}
