import { createServer } from 'vite';
import { chromium } from 'playwright';
import { PDFDocument, StandardFonts } from 'pdf-lib';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';

const output = path.resolve('test-results'); await mkdir(output, { recursive: true });
const sample = path.join(output, 'sample.pdf'), second = path.join(output, 'second.pdf');
for (const [file, count] of [[sample, 5], [second, 2]]) {
  const pdf = await PDFDocument.create(), font = await pdf.embedFont(StandardFonts.Helvetica);
  for (let i = 0; i < count; i++) { const page = pdf.addPage([595, 842]); page.drawText(`SEARCH-TEST drawing ${i + 1}`, { x: 40, y: 770, size: 20, font }); }
  await writeFile(file, await pdf.save());
}
const original = await readFile(sample);
let choices = [sample], destination = null, savedSession = null, confirmed = true;
let closeChoice = 'discard', writeDelay = 0, writePending = false;
let preferences = { settings: { theme: 'system', openMode: 'tab', restore: true }, recent: [] };
const server = await createServer({ server: { port: 0, strictPort: false } }); await server.listen();
let browser, page;
try {
  browser = await chromium.launch({ channel: 'msedge', headless: true });
  page = await browser.newPage({ viewport: { width: 1280, height: 850 } });
  const errors = []; page.on('pageerror', e => errors.push(e.message));
  page.on('console', message => { if (message.type() === 'error') console.error('BROWSER:', message.text()); });
  await page.exposeFunction('mockInvoke', async (command, args = {}) => {
    switch (command) {
      case 'load_session': return { windowId: 1, views: {}, tabs: [], ...savedSession, ...preferences };
      case 'store_session': savedSession = args.value; return;
      case 'list_windows': return [{ id: 1, title: 'Folio PDF' }];
      case 'claim_pdf': return true;
      case 'watch_pdf': case 'release_pdf': return;
      case 'pending_paths': case 'pending_transfers': return [];
      case 'remember_pdf': preferences.recent = [{ path: args.path, name: args.name }, ...preferences.recent.filter(r => r.path !== args.path)].slice(0, 12); return preferences;
      case 'preferences': if (args.value.clearHistory) preferences.recent = []; else Object.assign(preferences.settings, args.value); return preferences;
      case 'choose_files': return choices;
      case 'read_pdf': return Array.from(await readFile(args.path));
      case 'choose_destination': return destination;
      case 'write_pdf': { const file = JSON.parse(args.headers['folio-path']); assert.equal(path.dirname(file), output); writePending = true; if (writeDelay) await new Promise(resolve => setTimeout(resolve, writeDelay)); await writeFile(file, new Uint8Array(args.data)); writePending = false; return; }
      case 'confirm': return confirmed;
      case 'confirm_close': return confirmed ? closeChoice : 'cancel';
      default: throw new Error(`Unexpected native command: ${command}`);
    }
  });
  // Substitute only the native module. UI, bridge, PDF.js and PDF workers are real.
  await page.route('**/src/native.ts', route => route.fulfill({ contentType: 'application/javascript', body: `
    const listeners = new Map();
    const invoke = async (command, args) => {
      const value = await window.mockInvoke(command, args);
      if (command === 'preferences' || command === 'remember_pdf') listeners.get('folio-preferences')?.(value);
      return command === 'read_pdf' ? new Uint8Array(value).buffer : value;
    };
    export const native = { invoke, binary: (command, data, headers) => invoke(command, { data: Array.from(data), headers }),
      listen: async (event, fn) => { listeners.set(event, fn); return () => listeners.delete(event); }, onDrop: async () => () => {}, onBounds: async () => () => {},
      close: async () => {}, minimize: async () => {}, maximize: async () => {}, drag: async () => {}, onClose: async () => () => {}
    };` }));
  const poll = async fn => {
    const deadline = Date.now() + 30000;
    while (Date.now() < deadline) { if (await page.evaluate(fn)) return; await new Promise(resolve => setTimeout(resolve, 100)); }
    throw new Error(`Timed out: ${fn}`);
  };
  const state = () => page.evaluate(() => window.folio.snapshot());
  await page.goto(`http://127.0.0.1:${server.httpServer.address().port}`); await page.waitForSelector('.home');
  await page.screenshot({ path: path.join(output, 'home.png') });
  await page.getByRole('button', { name: 'PDFを開く', exact: true }).click();
  await poll(() => document.querySelector('.pdfViewer .page canvas')?.width > 0);
  assert.equal((await state()).docs[0].pages.length, 5);
  await page.getByRole('button', { name: '検索 (Ctrl+F)', exact: true }).click();
  await page.getByPlaceholder('検索する文字を入力').fill('SEARCH-TEST');
  await poll(() => document.querySelector('.search-count')?.textContent.includes('5件'));
  await page.getByRole('combobox', { name: '表示倍率' }).selectOption('200');
  await poll(() => [...document.querySelectorAll('.pdfViewer .page canvas')].some(canvas => {
    if (!canvas.width || !canvas.height) return false;
    const pixels = canvas.getContext('2d').getImageData(0, 0, Math.min(canvas.width, 600), Math.min(canvas.height, 350)).data;
    for (let i = 0; i < pixels.length; i += 4) if (pixels[i + 3] && pixels[i] < 200) return true;
    return false;
  }));
  await page.screenshot({ path: path.join(output, 'document.png') });
  await page.getByRole('button', { name: 'ページ整理', exact: true }).click();
  await page.locator('.page-grid .thumbnail').nth(0).click();
  await page.getByRole('button', { name: '右に90度回転', exact: true }).click();
  await poll(async () => (await window.folio.snapshot()).docs[0].pages[0].rotation === 90);
  await page.getByRole('button', { name: '後ろへ移動', exact: true }).click();
  await poll(async () => (await window.folio.snapshot()).docs[0].pages[1].source === 0);
  await page.getByRole('button', { name: '選択ページを削除', exact: true }).click();
  await poll(async () => (await window.folio.snapshot()).docs[0].pages.length === 4);
  await page.getByRole('button', { name: '元に戻す', exact: true }).click();
  await poll(async () => (await window.folio.snapshot()).docs[0].pages.length === 5);
  const orderBeforeDrag = (await state()).docs[0].pages.map(p => p.id);
  const dragFrom = await page.locator('.page-grid .thumbnail').nth(0).boundingBox(), dragTo = await page.locator('.page-grid .thumbnail').nth(2).boundingBox();
  await page.mouse.move(dragFrom.x + dragFrom.width / 2, dragFrom.y + dragFrom.height / 2); await page.mouse.down();
  await page.mouse.move(dragTo.x + dragTo.width / 2, dragTo.y + dragTo.height / 2, { steps: 8 }); await page.mouse.up();
  await poll(async () => (await window.folio.snapshot()).docs[0].pages[0].source !== 1);
  assert.notDeepEqual((await state()).docs[0].pages.map(p => p.id), orderBeforeDrag);
  await page.getByRole('button', { name: '元に戻す', exact: true }).click();
  assert.deepEqual((await state()).docs[0].pages.map(p => p.id), orderBeforeDrag);
  await page.screenshot({ path: path.join(output, 'organize.png') });
  const id = (await state()).active;
  confirmed = false;
  assert.equal(await page.evaluate(id => window.folio.close(id), id), false);
  confirmed = true;
  closeChoice = 'save'; destination = path.join(output, 'closing-save.pdf'); writeDelay = 400;
  const closing = page.evaluate(id => window.folio.close(id), id);
  const writeDeadline = Date.now() + 30000;
  while (!writePending && Date.now() < writeDeadline) await new Promise(resolve => setTimeout(resolve, 20));
  assert.equal(writePending, true, 'close/save must reach the binary write stage');
  await page.evaluate(async id => { const doc = (await window.folio.snapshot()).docs.find(d => d.id === id); await window.folio.edit(id, { type: 'rotate', ids: [doc.pages[0].id], delta: 90 }); }, id);
  assert.equal(await closing, false, 'changes made during save must keep the original tab open');
  const savedCopy = (await state()).docs.find(d => d.name === 'closing-save.pdf');
  await page.evaluate(async ({ original, copy }) => { await window.folio.close(copy, true); await window.folio.activate(original); await window.folio.edit(original, { type: 'undo' }); }, { original: id, copy: savedCopy.id });
  closeChoice = 'discard'; writeDelay = 0;
  destination = null;
  assert.equal(await page.evaluate(id => window.folio.save(id), id), false);
  destination = sample;
  assert.match(await page.evaluate(async id => { try { await window.folio.save(id); return ''; } catch(e) { return String(e); } }, id), /別の保存先/);
  destination = path.join(output, 'edited.pdf'); confirmed = true;
  await page.getByRole('button', { name: '名前を付けて保存 (Ctrl+S)', exact: true }).click();
  await poll(async () => (await window.folio.snapshot()).docs[0]?.name === 'edited.pdf');
  const edited = await PDFDocument.load(await readFile(destination));
  assert.equal(edited.getPageCount(), 5); assert.equal(edited.getPage(1).getRotation().angle, 90);
  await poll(() => document.querySelector('.pdfViewer .page canvas')?.width > 0);
  destination = path.join(output, 'extracted.pdf');
  await page.getByRole('button', { name: 'ページ整理', exact: true }).click();
  await page.getByRole('button', { name: 'ページを抽出・分割', exact: true }).click();
  await page.getByPlaceholder('例：1-3, 5, 8-10').fill('1-2');
  await page.getByRole('button', { name: '別PDFに保存', exact: true }).click();
  await poll(async () => (await window.folio.snapshot()).docs.some(d => d.name === 'extracted.pdf'));
  assert.equal((await PDFDocument.load(await readFile(destination))).getPageCount(), 2);
  choices = [sample, second]; destination = path.join(output, 'merged.pdf');
  await page.getByRole('button', { name: 'PDFを結合', exact: true }).click();
  await page.getByRole('button', { name: 'PDFを追加', exact: true }).click();
  await page.waitForFunction(() => document.querySelectorAll('.merge-row').length === 2);
  await page.getByRole('button', { name: '結合して保存', exact: true }).click();
  await poll(async () => (await window.folio.snapshot()).docs.some(d => d.name === 'merged.pdf'));
  assert.equal((await PDFDocument.load(await readFile(destination))).getPageCount(), 7);
  await page.evaluate(() => window.folio.settings({ theme: 'dark' }));
  await poll(() => document.documentElement.dataset.theme === 'dark');
  await page.screenshot({ path: path.join(output, 'dark.png') });
  await page.waitForTimeout(750);
  assert.equal(savedSession.tabs.length, 3);
  await page.reload();
  await poll(async () => (await window.folio.snapshot()).docs.length === 3);
  await poll(() => document.querySelector('.pdfViewer .page canvas')?.width > 0);
  assert.equal((await state()).settings.theme, 'dark');
  await page.evaluate(async bytes => { await window.folio.dropped([new File([new Uint8Array(bytes)], 'dropped.pdf', { type: 'application/pdf' })]); }, Array.from(original));
  await poll(async () => (await window.folio.snapshot()).docs.some(d => d.name === 'dropped.pdf' && d.pages.length === 5));
  assert.deepEqual(await readFile(sample), original);
  assert.deepEqual(errors, []);
  console.log('SMOKE PASS: display, search, zoom, rotate/move/delete/undo, close/save cancellation, original protection, export, extraction, merge, theme, session restore, drop');
} catch (error) {
  if (page && !page.isClosed()) { await page.screenshot({ path: path.join(output, 'failure.png') }); console.error(await page.locator('body').innerText()); }
  throw error;
} finally { await browser?.close(); await server.close(); }

