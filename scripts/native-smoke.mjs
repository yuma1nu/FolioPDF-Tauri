import { chromium } from 'playwright';
import { PDFDocument, StandardFonts } from 'pdf-lib';
import { spawn } from 'node:child_process';
import { mkdir, readFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import path from 'node:path';
import assert from 'node:assert/strict';

const output = path.resolve('test-results', `native-${Date.now()}`); await mkdir(output, { recursive: true });
const portServer = createServer(); await new Promise(resolve => portServer.listen(0, '127.0.0.1', resolve));
const port = portServer.address().port; await new Promise(resolve => portServer.close(resolve));
const executable = path.resolve('src-tauri/target/release/folio-pdf-tauri.exe');
const app = spawn(executable, [], { windowsHide: true, stdio: 'pipe', env: {
  ...process.env, FOLIO_USER_DATA: output, WEBVIEW2_USER_DATA_FOLDER: path.join(output, 'webview'),
  WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: `--remote-debugging-port=${port} --remote-debugging-address=127.0.0.1`
} });
let launchError; app.on('error', error => { launchError = error; });
let browser;
try {
  const deadline = Date.now() + 30000;
  while (Date.now() < deadline) {
    if (launchError) throw launchError;
    if (app.exitCode !== null) throw new Error(`App exited: ${app.exitCode}`);
    try { const response = await fetch(`http://127.0.0.1:${port}/json/version`); if (response.ok) break; } catch {}
    await new Promise(resolve => setTimeout(resolve, 200));
  }
  browser = await chromium.connectOverCDP(`http://127.0.0.1:${port}`);
  const context = browser.contexts()[0];
  let page = context.pages()[0]; if (!page) page = await context.waitForEvent('page');
  const errors = []; page.on('pageerror', error => errors.push(error.message));
  await page.waitForSelector('.home');
  await page.screenshot({ path: path.join(output, 'home.png') });
  // No native module substitution: production assets and Rust IPC run in WebView2.
  const pdf = await PDFDocument.create(), font = await pdf.embedFont(StandardFonts.Helvetica);
  for (let i = 0; i < 3; i++) pdf.addPage([595, 842]).drawText(`NATIVE-TEST page ${i + 1}`, { x: 40, y: 750, size: 20, font });
  await page.evaluate(async bytes => { await window.folio.dropped([new File([new Uint8Array(bytes)], 'native.pdf', { type: 'application/pdf' })]); }, Array.from(await pdf.save()));
  await page.waitForFunction(() => document.querySelector('.pdfViewer .page canvas')?.width > 0, null, { timeout: 30000 });
  const state = await page.evaluate(() => window.folio.snapshot());
  assert.equal(state.docs[0].pages.length, 3);
  await page.getByRole('button', { name: '検索 (Ctrl+F)', exact: true }).click();
  await page.getByPlaceholder('検索する文字を入力').fill('NATIVE-TEST');
  await page.waitForFunction(() => document.querySelector('.search-count')?.textContent.includes('3件'));
  await page.waitForFunction(() => [...document.querySelectorAll('.pdfViewer .page canvas')].some(canvas => {
    if (!canvas.width || !canvas.height) return false;
    const pixels = canvas.getContext('2d').getImageData(0, 0, Math.min(canvas.width, 600), Math.min(canvas.height, 350)).data;
    for (let i = 0; i < pixels.length; i += 4) if (pixels[i + 3] && pixels[i] < 200) return true;
    return false;
  }));
  await page.screenshot({ path: path.join(output, 'document.png') });
  // This persists through real IPC, then destroys the real native window.
  await page.evaluate(() => window.folio.closeWindow()).catch(error => { if (!/closed|destroyed/i.test(String(error))) throw error; });
  const session = JSON.parse(await readFile(path.join(output, 'session.json'), 'utf8'));
  assert.equal(session.tabs.length, 0); assert.equal(session.settings.theme, 'system');
  assert.deepEqual(errors, []);
  console.log(`NATIVE PASS: release WebView2 startup, worker/CSP, PDF rendering/search, Rust session IPC and window close. Artifacts: ${output}`);
} finally { await browser?.close().catch(() => {}); if (app.exitCode === null) app.kill(); }
