import { createServer } from 'vite';
import { chromium } from 'playwright';
import { PDFDocument, StandardFonts } from 'pdf-lib';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';

const output = path.resolve('test-results', 'print'); await mkdir(output, { recursive: true });
const document = await PDFDocument.create(), font = await document.embedFont(StandardFonts.Helvetica);
for (let i = 0; i < 60; i++) {
  const page = document.addPage(i === 0 ? [2384, 3370] : [595, 842]);
  page.drawText(`PRINT PAGE ${i + 1}`, { x: 40, y: page.getHeight() - 80, size: 24, font });
  for (let j = 0; j < 100; j++) page.drawLine({ start: { x: 40 + j * 2, y: page.getHeight() - 100 }, end: { x: 40 + j * 2, y: page.getHeight() - 300 }, thickness: .3 });
}
const source = Array.from(await document.save());
const mapping = Array.from({ length: 60 }, (_, source) => ({ source, rotation: source === 2 ? 90 : 0 }));
let revision = 0, selection = [], spool = [], dialogs = 0, writeDelay = 0;
let sendFailure = false, waitForCancel = false, cancelSend, expectedFit = true;
let printerRevision = 0, chosenPrinter = '', propertiesChanged = true, printerList = ['テストプリンター A', 'テストプリンター B'];
const server = await createServer({ server: { port: 0, strictPort: false } }); await server.listen();
let browser, page;
try {
  browser = await chromium.launch({ channel: 'msedge', headless: true });
  page = await browser.newPage({ viewport: { width: 1080, height: 800 } });
  const errors = []; page.on('pageerror', error => errors.push(error.message));
  await page.exposeFunction('mockInvoke', async (command, args = {}) => {
    switch (command) {
      case 'print_payload': return { title: '60ページの図面.pdf', pages: mapping, sourceReady: true };
      case 'read_print_source': return source;
      case 'get_printers': return { printers: printerList, defaultPrinter: printerList[0] };
      case 'select_printer': chosenPrinter = args.name; printerRevision++; return { name: chosenPrinter, revision: printerRevision };
      case 'driver_properties': if (propertiesChanged) printerRevision++; return { name: chosenPrinter, revision: printerRevision, changed: propertiesChanged };
      case 'prepare_print': revision++; selection = args.selection; spool = []; return revision;
      case 'print_page': {
        const meta = JSON.parse(args.headers['folio-print']);
        assert.equal(meta.revision, revision); assert.equal(meta.index, spool.length); assert.equal(meta.page, selection[meta.index]);
        if (writeDelay) await new Promise(resolve => setTimeout(resolve, writeDelay));
        spool.push({ ...meta, data: args.data }); return;
      }
      case 'read_print_page': assert.equal(args.revision, revision); return spool[args.index].data;
      case 'cancel_print_preparation': if (args.revision === revision) spool = []; return;
      case 'direct_print': {
        assert.equal(args.revision, revision); assert.equal(args.printerRevision, printerRevision); assert.equal(args.fit, expectedFit); assert.equal(spool.length, selection.length);
        if (sendFailure) throw new Error('テスト送信エラー');
        if (waitForCancel) await new Promise((_, reject) => { cancelSend = () => reject(new Error('送信中止')); });
        dialogs++; return { printer: chosenPrinter, jobId: dialogs, pages: selection.length };
      }
      case 'cancel_direct_print': cancelSend?.(); return;
      default: throw new Error(`Unexpected print command: ${command}`);
    }
  });
  await page.route('**/src/native.ts', route => route.fulfill({ contentType: 'application/javascript', body: `
    export const native = {
      invoke: async (command, args) => { const value = await window.mockInvoke(command, args); return command === 'read_print_source' || command === 'read_print_page' ? new Uint8Array(value).buffer : value; },
      binary: (command, data, headers) => window.mockInvoke(command, { data: Array.from(data), headers }),
      listen: async () => () => {}, close: async () => {}
    };` }));
  const started = Date.now();
  await page.goto(`http://127.0.0.1:${server.httpServer.address().port}/print.html`);
  await page.waitForFunction(() => document.querySelector('#print')?.disabled === false);
  await page.waitForFunction(() => document.querySelector('.preview-tile canvas')?.width > 0);
  const firstPreviewMs = Date.now() - started;
  assert.equal(spool.length, 0); assert.equal(revision, 0, 'opening preview must not prepare high-resolution print pages');
  const previewCount = await page.locator('.preview-tile canvas').evaluateAll(canvases => canvases.filter(c => c.width).length);
  assert.ok(previewCount < 60, 'offscreen pages must stay unrendered');
  assert.ok(await page.locator('.preview-tile canvas').evaluateAll(canvases => canvases.every(c => c.width <= 221 && c.height <= 281)));
  await page.screenshot({ path: path.join(output, 'all-pages.png') });
  await page.getByRole('button', { name: 'ドライバー設定…', exact: true }).click();
  await page.waitForFunction(() => document.querySelector('#driver-settings')?.disabled === false);
  assert.match(await page.locator('#printer-status').innerText(), /今回の印刷/);
  propertiesChanged = false;
  await page.getByRole('button', { name: 'ドライバー設定…', exact: true }).click();
  await page.waitForFunction(() => document.querySelector('#driver-settings')?.disabled === false);
  assert.match(await page.locator('#printer-status').innerText(), /変更せず/);
  await page.getByLabel('プリンター', { exact: true }).selectOption(printerList[1]);
  await page.waitForFunction(() => document.querySelector('#printer')?.disabled === false);
  assert.equal(chosenPrinter, printerList[1]);
  await page.getByRole('radio', { name: '指定ページ', exact: true }).check();
  await page.getByLabel('ページ番号', { exact: true }).fill('2-3, 5');
  assert.equal(await page.locator('.preview-tile[aria-pressed=true]').count(), 3);
  await page.getByRole('button', { name: '3ページ', exact: true }).click();
  assert.equal(await page.locator('#range').inputValue(), '2, 5');
  await page.getByRole('button', { name: '4ページ', exact: true }).click();
  assert.equal(await page.locator('#range').inputValue(), '2, 4-5');
  await page.locator('#range').fill('61'); assert.equal(await page.locator('#print').isDisabled(), true);
  assert.equal(await page.locator('#range').getAttribute('aria-invalid'), 'true');
  await page.locator('#range').fill('2-3');
  await page.screenshot({ path: path.join(output, 'selected-pages.png') });
  await page.getByRole('button', { name: '選択したページを印刷', exact: true }).click();
  await page.waitForFunction(() => document.body.dataset.preparing === 'false');
  assert.deepEqual(selection, [1, 2]); assert.deepEqual(spool.map(p => p.page), [1, 2]); assert.equal(dialogs, 1);
  assert.deepEqual(await page.locator('.printed-page').evaluateAll(nodes => nodes.map(n => n.dataset.page)), ['2', '3']);
  const printed = await page.pdf({ preferCSSPageSize: true, printBackground: true }); await writeFile(path.join(output, 'selected-output.pdf'), printed);
  const pdf = await PDFDocument.load(printed); assert.equal(pdf.getPageCount(), 2);
  assert.ok(Math.abs(pdf.getPage(0).getWidth() - 595) < 1); assert.ok(Math.abs(pdf.getPage(1).getWidth() - 842) < 1, 'rotation must affect printed paper size');
  await page.getByRole('button', { name: '選択を解除', exact: true }).click();
  assert.equal(await page.locator('#print').isDisabled(), true); assert.equal(await page.locator('.printed-page').count(), 0);
  await page.getByRole('radio', { name: 'すべてのページ', exact: true }).check();
  assert.equal(await page.locator('.preview-tile[aria-pressed=true]').count(), 60);
  writeDelay = 200;
  await page.getByRole('button', { name: '選択したページを印刷', exact: true }).click();
  await page.waitForFunction(() => document.body.dataset.preparing === 'true');
  await page.getByRole('button', { name: '準備をキャンセル', exact: true }).click();
  await page.waitForFunction(() => document.body.dataset.preparing === 'false');
  assert.equal(dialogs, 1, 'cancelled preparation must not submit a print job'); assert.equal(await page.locator('.printed-page').count(), 0);
  writeDelay = 0;
  await page.getByRole('radio', { name: '指定ページ', exact: true }).check(); await page.locator('#range').fill('5');
  await page.getByRole('button', { name: '選択したページを印刷', exact: true }).click();
  await page.waitForFunction(() => document.body.dataset.preparing === 'false');
  assert.deepEqual(selection, [4]); assert.equal(dialogs, 2); assert.equal(await page.locator('.printed-page').count(), 1);
  assert.match(await page.locator('#status').innerText(), /へ 1 ページを送信しました/);
  expectedFit = false; await page.locator('#print-scale').selectOption('actual'); sendFailure = true;
  await page.locator('#print').click(); await page.waitForFunction(() => document.body.dataset.preparing === 'false');
  assert.match(await page.locator('#status').innerText(), /テスト送信エラー/); assert.equal(await page.locator('#print').isEnabled(), true);
  sendFailure = false; waitForCancel = true;
  await page.locator('#print').click(); await page.getByRole('button', { name: '送信を中止', exact: true }).waitFor();
  assert.equal(await page.locator('#printer').isDisabled(), true);
  await page.getByRole('button', { name: '送信を中止', exact: true }).click();
  await page.waitForFunction(() => document.body.dataset.preparing === 'false');
  assert.match(await page.locator('#status').innerText(), /送信を中止しました/); assert.equal(dialogs, 2);
  waitForCancel = false; await page.locator('#print').click(); await page.waitForFunction(() => document.body.dataset.preparing === 'false');
  assert.equal(dialogs, 3); assert.match(await page.locator('#status').innerText(), /へ 1 ページを送信しました/);
  printerList = []; await page.getByRole('button', { name: '更新', exact: true }).click();
  await page.waitForFunction(() => document.querySelector('#refresh-printers')?.disabled === false);
  assert.equal(await page.locator('#print').isDisabled(), true); assert.equal(await page.locator('#driver-settings').isDisabled(), true);
  assert.deepEqual(errors, []);
  console.log(`PRINT PASS: first preview ${firstPreviewMs}ms; ${previewCount}/60 thumbnails rendered initially; printer selection, driver settings/apply/cancel, fit/actual size, direct submission/error/cancel/retry, no-printer state, range/click synchronization, PDF output, rotation, preparation cancellation and retry.`);
} catch (error) { if (page && !page.isClosed()) { await page.screenshot({ path: path.join(output, 'failure.png') }); console.error(await page.locator('body').innerText()); } throw error; }
finally { await browser?.close(); await server.close(); }
