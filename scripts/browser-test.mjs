import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createPreviewServer } from './serve.mjs';
import { checkDemo } from './browser-demo.mjs';
import { checkExtension } from './browser-extension.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const extensionRoot = process.env.EXTENSION_DIR ? resolve(process.env.EXTENSION_DIR) : root;
const output = join(root, 'test-results');
const channel = process.env.BROWSER_CHANNEL || 'msedge';

async function loadPlaywright() {
  try {
    const loaded = process.env.PLAYWRIGHT_MODULE
      ? await import(pathToFileURL(resolve(process.env.PLAYWRIGHT_MODULE)).href)
      : createRequire(import.meta.url)('playwright');
    const playwright = loaded.default ?? loaded;
    if (!playwright?.chromium) throw new Error('The selected module does not export Playwright Chromium.');
    return playwright.chromium;
  } catch (error) {
    throw new Error('Unable to load Playwright. Run "npm install --no-save playwright" or set PLAYWRIGHT_MODULE to Playwright\'s index.mjs. ' + error.message, { cause: error });
  }
}

async function captureFailure(page, filename) {
  if (page && !page.isClosed()) {
    await page.screenshot({ path: join(output, filename), fullPage: true }).catch(() => {});
  }
}

async function runDemo(chromium) {
  const server = createPreviewServer();
  let browser, page;
  const errors = [];
  try {
    await new Promise((resolve, reject) => {
      server.once('error', reject);
      server.listen(0, '127.0.0.1', resolve);
    });
    browser = await chromium.launch({ headless: true, channel });
    page = await browser.newPage({ viewport: { width: 1540, height: 1050 } });
    page.on('pageerror', error => errors.push(error.message));
    await page.goto('http://127.0.0.1:' + server.address().port);
    await checkDemo(page, output);
    assert.deepEqual(errors, [], 'No unhandled demo errors');
    console.log('PASS: demo export, ordering, placement, inert HTML, overlap review, undo, and narrow layout.');
  } catch (error) {
    await captureFailure(page, 'demo-failure.png');
    throw error;
  } finally {
    await Promise.all([
      browser?.close(),
      new Promise(resolve => server.close(resolve))
    ]);
  }
}

async function runExtension(chromium) {
  const manifest = JSON.parse(await readFile(join(extensionRoot, 'manifest.json'), 'utf8'));
  assert.equal(manifest.manifest_version, 3, 'EXTENSION_DIR contains an extracted Manifest V3 extension');
  const profilePath = await mkdtemp(join(output, 'edge-test-profile-'));
  let context, page;
  const errors = [];
  try {
    context = await chromium.launchPersistentContext(profilePath, {
      headless: true, channel, viewport: { width: 1440, height: 1000 },
      args: ['--disable-extensions-except=' + extensionRoot, '--load-extension=' + extensionRoot]
    });
    const worker = context.serviceWorkers()[0] ||
      await context.waitForEvent('serviceworker', { timeout: 15000 });
    const id = new URL(worker.url()).host;
    page = await context.newPage();
    page.on('pageerror', error => errors.push(error.message));
    await page.goto('chrome-extension://' + id + '/manager.html');
    await checkExtension(page, worker, output);
    assert.deepEqual(errors, [], 'No unhandled extension errors');
    console.log('PASS: MV3 import, overlap scope, all four decisions, target selection, update-only import, and safe undo.');
  } catch (error) {
    await captureFailure(page, 'extension-failure.png');
    throw error;
  } finally {
    try { await context?.close(); } finally {
      // Only remove the unique profile created by this run.
      assert.equal(dirname(profilePath), output, 'Profile cleanup stays within test-results');
      assert(basename(profilePath).startsWith('edge-test-profile-'));
      await rm(profilePath, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
    }
  }
}

await mkdir(output, { recursive: true });
const chromium = await loadPlaywright();
await runDemo(chromium);
await runExtension(chromium);
