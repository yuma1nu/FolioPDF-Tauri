import { native } from './native';
import type { PDFDocumentProxy, PDFPageProxy, RenderTask } from 'pdfjs-dist';
import { createPdfTask } from './pdf-source';
import { formatPrintRange, parsePrintRange, previewScale, printScale } from './print-selection';
import './print.css';

type Payload = { title: string; pages: { source: number; rotation: number }[]; password?: string; sourceReady: boolean; sourceError?: string };
type Tile = { button: HTMLButtonElement; canvas: HTMLCanvasElement; placeholder: HTMLSpanElement };
type PrinterChoice = { name: string; revision: number; changed?: boolean };
const invoke = native.invoke;
const currentWindow = { close: native.close, listen: native.listen };
const status = document.querySelector<HTMLElement>('#status')!;
const printButton = document.querySelector<HTMLButtonElement>('#print')!;
const cancelButton = document.querySelector<HTMLButtonElement>('#cancel')!;
const options = document.querySelector<HTMLFieldSetElement>('#options')!;
const all = document.querySelector<HTMLInputElement>('#all')!;
const custom = document.querySelector<HTMLInputElement>('#custom')!;
const range = document.querySelector<HTMLInputElement>('#range')!;
const error = document.querySelector<HTMLElement>('#range-error')!;
const count = document.querySelector<HTMLElement>('#selection-count')!;
const grid = document.querySelector<HTMLElement>('#pages')!;
const printPages = document.querySelector<HTMLElement>('#print-pages')!;
const progress = document.querySelector<HTMLProgressElement>('#progress')!;
const printerSelect = document.querySelector<HTMLSelectElement>('#printer')!;
const driverButton = document.querySelector<HTMLButtonElement>('#driver-settings')!;
const refreshPrinters = document.querySelector<HTMLButtonElement>('#refresh-printers')!;
const printerStatus = document.querySelector<HTMLElement>('#printer-status')!;
const printScaleSelect = document.querySelector<HTMLSelectElement>('#print-scale')!;
const printStyle = document.createElement('style'); document.head.append(printStyle);
const tiles: Tile[] = [], visible = new Set<number>(), rendered = new Set<number>(), failed = new Set<number>();
const loadedPages = new Map<number, PDFPageProxy>(), imageUrls: string[] = [];
let payload: Payload, pdf: PDFDocumentProxy | undefined, selected = new Set<number>();
let busy = false, disposed = false, previewTask: RenderTask | undefined, printTask: RenderTask | undefined;
let previewIndex = -1, previewWork: Promise<void> | undefined, abort: AbortController | undefined, revision: number | undefined;
let printerChoice: PrinterChoice | undefined, printerBusy = false, printerCount = 0, sending = false;
const nextFrame = () => new Promise<void>(resolve => requestAnimationFrame(() => resolve()));
const normalStatus = 'ページを選び、「選択したページを印刷」を押してください。';

function clearPrintedPages() {
  printPages.replaceChildren(); printStyle.textContent = '';
  for (const url of imageUrls) URL.revokeObjectURL(url);
  imageUrls.length = 0;
}

function invalidatePrintedPages() {
  clearPrintedPages();
  if (revision !== undefined) void invoke('cancel_print_preparation', { revision }).catch(() => {});
  revision = undefined;
}

function updateSelection(start = 0) {
  options.disabled = busy || !payload;
  range.disabled = busy || !custom.checked;
  printButton.disabled = busy || printerBusy || !printerChoice || !pdf || selected.size === 0 || !!error.textContent;
  printerSelect.disabled = busy || printerBusy || !printerCount;
  driverButton.disabled = busy || printerBusy || !printerChoice;
  refreshPrinters.disabled = busy || printerBusy; printScaleSelect.disabled = busy || printerBusy;
  range.setAttribute('aria-invalid', error.textContent ? 'true' : 'false');
  count.textContent = payload ? `${selected.size} / ${payload.pages.length} ページを印刷` : 'ページを読み込んでいます…';
  for (let index = start; index < tiles.length; index++) {
    const tile = tiles[index];
    const active = selected.has(index);
    tile.button.classList.toggle('selected', active);
    tile.button.setAttribute('aria-pressed', String(active));
    tile.button.title = active ? `${index + 1}ページを印刷対象から外す` : `${index + 1}ページを印刷対象に追加`;
    tile.button.disabled = busy;
  }
}

function selectionChanged() { invalidatePrintedPages(); updateSelection(); }
all.addEventListener('change', () => {
  if (!all.checked) return;
  selected = new Set(payload.pages.map((_, i) => i)); range.value = ''; error.textContent = '';
  selectionChanged();
});
custom.addEventListener('change', () => {
  if (!custom.checked) return;
  selected.clear(); range.value = ''; error.textContent = '';
  selectionChanged(); range.focus();
});
range.addEventListener('input', () => {
  try { selected = new Set(parsePrintRange(range.value, payload.pages.length)); error.textContent = ''; }
  catch (e) { selected.clear(); error.textContent = range.value.trim() ? String(e instanceof Error ? e.message : e) : ''; }
  selectionChanged();
});
document.querySelector('#clear')!.addEventListener('click', () => {
  all.checked = false; custom.checked = true; range.value = ''; selected.clear(); error.textContent = '';
  selectionChanged(); range.focus();
});
document.querySelector('#close')!.addEventListener('click', () => { void currentWindow.close(); });
function cancelCurrentPrint() {
  abort?.abort(); printTask?.cancel();
  if (sending) { void invoke('cancel_direct_print').catch(() => {}); status.textContent = 'プリンターへの送信を中止しています…'; }
  else status.textContent = '印刷準備をキャンセルしています…';
}
cancelButton.addEventListener('click', cancelCurrentPrint);
window.addEventListener('keydown', event => {
  if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'p') {
    event.preventDefault(); if (!printButton.disabled) printButton.click();
  }
  if (event.key === 'Escape' && abort) cancelCurrentPrint();
});

async function choosePrinter() {
  printerBusy = true; printerChoice = undefined; updateSelection();
  printerStatus.textContent = 'プリンターの設定を読み込んでいます…';
  try { printerChoice = await invoke<PrinterChoice>('select_printer', { name: printerSelect.value }); printerStatus.textContent = '用紙・両面・トレイなどは「ドライバー設定」で変更できます。'; }
  catch (e) { printerStatus.textContent = `プリンターを使用できません: ${String(e)}`; }
  finally { printerBusy = false; updateSelection(); }
}
async function loadPrinters() {
  if (printerBusy || busy) return;
  const previous = printerSelect.value; printerBusy = true; printerChoice = undefined; updateSelection();
  printerStatus.textContent = 'プリンター一覧を読み込んでいます…';
  try {
    const list = await invoke<{ printers: string[]; defaultPrinter?: string }>('get_printers');
    printerSelect.replaceChildren(); printerCount = list.printers.length;
    for (const name of list.printers) { const option = document.createElement('option'); option.value = name; option.textContent = name === list.defaultPrinter ? `${name}（既定）` : name; printerSelect.append(option); }
    if (!printerCount) { const option = document.createElement('option'); option.value = ''; option.textContent = 'プリンターがありません'; printerSelect.append(option); printerStatus.textContent = '利用できるプリンターがありません。追加後に「更新」を押してください。'; return; }
    printerSelect.value = list.printers.includes(previous) ? previous : list.defaultPrinter ?? list.printers[0];
    printerChoice = await invoke<PrinterChoice>('select_printer', { name: printerSelect.value });
    printerStatus.textContent = '用紙・両面・トレイなどは「ドライバー設定」で変更できます。';
  } catch (e) { printerStatus.textContent = `プリンターを読み込めません: ${String(e)}`; }
  finally { printerBusy = false; updateSelection(); }
}
printerSelect.addEventListener('change', () => { void choosePrinter(); });
refreshPrinters.addEventListener('click', () => { void loadPrinters(); });
driverButton.addEventListener('click', () => {
  if (!printerChoice || busy || printerBusy) return;
  const choice = printerChoice; printerBusy = true; updateSelection();
  printerStatus.textContent = 'ドライバーの設定画面を開いています…';
  void invoke<PrinterChoice>('driver_properties', { printerRevision: choice.revision }).then(result => {
    printerChoice = result; printerStatus.textContent = result.changed ? '今回の印刷にドライバー設定を適用しました。' : '設定を変更せずに戻りました。';
  }).catch(e => { printerStatus.textContent = `ドライバーの設定を開けません: ${String(e)}`; }).finally(() => { printerBusy = false; updateSelection(); });
});
void loadPrinters();

const observer = new IntersectionObserver(entries => {
  for (const entry of entries) {
    const index = Number((entry.target as HTMLElement).dataset.index);
    if (entry.isIntersecting) visible.add(index);
    else {
      visible.delete(index); rendered.delete(index);
      const tile = tiles[index];
      if (tile) { tile.canvas.width = tile.canvas.height = 0; tile.placeholder.hidden = false; }
      if (previewIndex === index) previewTask?.cancel();
      if (!busy && previewIndex !== index) loadedPages.get(index)?.cleanup();
    }
  }
  pumpPreviews();
}, { root: document.querySelector('.print-preview'), rootMargin: '160px' });

function pumpPreviews() {
  if (previewWork || !pdf || busy || disposed) return;
  previewWork = (async () => {
    while (!busy && !disposed && pdf) {
      const index = [...visible].find(i => !rendered.has(i) && !failed.has(i));
      if (index === undefined) break;
      previewIndex = index;
      const tile = tiles[index], buffer = document.createElement('canvas');
      try {
        const mapping = payload.pages[index];
        const page = await pdf.getPage(mapping.source + 1); loadedPages.set(index, page);
        if (!visible.has(index) || busy || disposed) continue;
        const bounds = page.getViewport({ scale: 1, rotation: mapping.rotation });
        const viewport = page.getViewport({ scale: previewScale(bounds.width, bounds.height), rotation: mapping.rotation });
        buffer.width = Math.ceil(viewport.width); buffer.height = Math.ceil(viewport.height);
        previewTask = page.render({ canvas: buffer, viewport, intent: 'print' }); await previewTask.promise;
        if (!visible.has(index) || disposed) continue;
        tile.canvas.width = buffer.width; tile.canvas.height = buffer.height;
        tile.canvas.getContext('2d')!.drawImage(buffer, 0, 0); tile.placeholder.hidden = true;
        rendered.add(index);
        document.querySelector('#preview-state')!.textContent = 'ページをクリックして、印刷対象を選択・解除できます。';
      } catch (e) {
        if (!String(e).includes('cancel')) {
          failed.add(index); tile.button.classList.add('preview-failed');
          tile.placeholder.textContent = 'プレビューを表示できません。印刷時に再試行します。';
        }
      } finally {
        buffer.width = buffer.height = 0; previewTask = undefined; previewIndex = -1;
        if (!visible.has(index) && !busy) loadedPages.get(index)?.cleanup();
      }
      await nextFrame();
    }
  })().finally(() => { previewWork = undefined; });
}

async function createTiles() {
  for (let start = 0; start < payload.pages.length && !disposed; start += 100) {
    const fragment = document.createDocumentFragment();
    for (let index = start; index < Math.min(start + 100, payload.pages.length); index++) {
      const button = document.createElement('button'), paper = document.createElement('div');
      const canvas = document.createElement('canvas'), placeholder = document.createElement('span');
      const label = document.createElement('span'), check = document.createElement('span');
      button.type = 'button'; button.className = 'preview-tile'; button.dataset.index = String(index);
      button.setAttribute('aria-label', `${index + 1}ページ`);
      paper.className = 'preview-paper'; canvas.width = canvas.height = 0; canvas.setAttribute('aria-hidden', 'true');
      placeholder.className = 'placeholder'; placeholder.textContent = String(index + 1); placeholder.setAttribute('aria-hidden', 'true');
      label.className = 'page-label'; check.className = 'selection-mark'; check.textContent = '✓'; check.setAttribute('aria-hidden', 'true');
      label.append(check, document.createTextNode(`${index + 1} ページ`)); paper.append(canvas, placeholder); button.append(paper, label);
      button.addEventListener('click', () => {
        if (busy) return;
        if (selected.has(index)) selected.delete(index); else selected.add(index);
        all.checked = false; custom.checked = true; range.value = formatPrintRange(selected); error.textContent = '';
        selectionChanged();
      });
      tiles.push({ button, canvas, placeholder }); fragment.append(button);
    }
    grid.append(fragment);
    for (let i = start; i < tiles.length; i++) observer.observe(tiles[i].button);
    updateSelection(start); await nextFrame();
  }
}

async function prepareAndPrint() {
  if (!pdf || busy || printerBusy || !printerChoice || !selected.size || error.textContent) return;
  const choice = printerChoice, fit = printScaleSelect.value === 'fit';
  const selection = [...selected].sort((a, b) => a - b), controller = new AbortController();
  busy = true; abort = controller; updateSelection(); previewTask?.cancel();
  cancelButton.hidden = false; progress.hidden = false; progress.max = selection.length; progress.value = 0;
  document.body.dataset.preparing = 'true'; clearPrintedPages();
  try {
    await previewWork;
    controller.signal.throwIfAborted();
    revision = await invoke<number>('prepare_print', { selection });
    const rules: string[] = [];
    for (const [index, logicalPage] of selection.entries()) {
      controller.signal.throwIfAborted();
      status.textContent = `印刷データを準備しています… ${index + 1} / ${selection.length}（${logicalPage + 1}ページ）`;
      const mapping = payload.pages[logicalPage], page = await pdf.getPage(mapping.source + 1);
      const bounds = page.getViewport({ scale: 1, rotation: mapping.rotation });
      const viewport = page.getViewport({ scale: printScale(bounds.width, bounds.height), rotation: mapping.rotation });
      const canvas = document.createElement('canvas');
      let url: string | undefined;
      try {
        canvas.width = Math.ceil(viewport.width); canvas.height = Math.ceil(viewport.height);
        printTask = page.render({ canvas, viewport, intent: 'print' }); await printTask.promise;
        controller.signal.throwIfAborted();
        const blob = await new Promise<Blob>((resolve, reject) => canvas.toBlob(blob => blob ? resolve(blob) : reject(new Error('印刷画像を作成できませんでした。')), 'image/png'));
        controller.signal.throwIfAborted();
        await native.binary('print_page', new Uint8Array(await blob.arrayBuffer()), {
          'folio-print': JSON.stringify({ revision, index, page: logicalPage, width: bounds.width, height: bounds.height })
        });
        controller.signal.throwIfAborted();
        // Read through the same native spool that the print job owns and validate it before printing.
        const bytes = await invoke<ArrayBuffer>('read_print_page', { revision, index });
        controller.signal.throwIfAborted();
        url = URL.createObjectURL(new Blob([bytes], { type: 'image/png' }));
        const section = document.createElement('section'), image = document.createElement('img');
        section.className = `printed-page p${index}`; section.dataset.page = String(logicalPage + 1);
        image.src = url; image.alt = `${logicalPage + 1}ページ`; await image.decode();
        controller.signal.throwIfAborted();
        imageUrls.push(url); url = undefined; section.append(image); printPages.append(section);
        rules.push(`@page p${index}{size:${bounds.width}pt ${bounds.height}pt;margin:0} @media print{.p${index}{page:p${index};width:${bounds.width}pt;height:${bounds.height}pt}}`);
      } finally { if (url) URL.revokeObjectURL(url); canvas.width = canvas.height = 0; printTask = undefined; }
      if (!visible.has(logicalPage)) page.cleanup();
      progress.value = index + 1; await nextFrame();
    }
    controller.signal.throwIfAborted();
    printStyle.textContent = rules.join('');
    // Commit the prepared page snapshot before submitting the native job.
    await nextFrame(); controller.signal.throwIfAborted();
    sending = true; cancelButton.textContent = '送信を中止'; progress.removeAttribute('value');
    status.textContent = `「${choice.name}」へ送信しています…`;
    const receipt = await invoke<{ printer: string; jobId: number; pages: number }>('direct_print', { revision, printerRevision: choice.revision, fit });
    status.textContent = `「${receipt.printer}」へ ${receipt.pages} ページを送信しました（ジョブ ${receipt.jobId}）。`;
  } catch (e) {
    invalidatePrintedPages();
    status.textContent = controller.signal.aborted ? sending ? '送信を中止しました。送信済みのページはプリンター側で確認してください。' : '印刷準備をキャンセルしました。ページを選び直して印刷できます。' : `印刷できませんでした: ${String(e instanceof Error ? e.message : e)}`;
  } finally {
    busy = false; sending = false; abort = undefined; document.body.dataset.preparing = 'false'; cancelButton.textContent = '準備をキャンセル';
    cancelButton.hidden = true; progress.hidden = true; updateSelection(); pumpPreviews();
  }
}
printButton.addEventListener('click', () => { void prepareAndPrint(); });

void (async () => {
  let sourceArrived!: () => void;
  let sourceFailed!: (message: string) => void;
  const sourceReady = new Promise<void>((resolve, reject) => { sourceArrived = resolve; sourceFailed = message => reject(new Error(message)); });
  void sourceReady.catch(() => {});
  const stops = await Promise.all([currentWindow.listen('folio-print-source', sourceArrived), currentWindow.listen<string>('folio-print-source-error', sourceFailed)]);
  try {
    payload = await invoke<Payload>('print_payload');
    document.querySelector('#title')!.textContent = payload.title;
    selected = new Set(payload.pages.map((_, i) => i)); updateSelection();
    void createTiles();
    status.textContent = 'PDFを読み込んでいます…';
    if (payload.sourceError) throw new Error(payload.sourceError);
    if (!payload.sourceReady) await sourceReady;
    const task = createPdfTask(new Uint8Array(await invoke<ArrayBuffer>('read_print_source')));
    task.onPassword = (update: (value: string) => void, reason: number) => { if (typeof payload.password === 'string' && reason !== 2) update(payload.password); else void task.destroy(); };
    pdf = await task.promise; payload.password = undefined;
    if (payload.pages.some(p => p.source >= pdf!.numPages)) throw new Error('印刷ページとPDFの構成が一致しません。');
    status.textContent = normalStatus; updateSelection(); pumpPreviews();
  } finally { stops.forEach(stop => stop()); }
})().catch(e => { status.textContent = `PDFを読み込めませんでした: ${String(e)}`; printButton.disabled = true; });

window.addEventListener('unload', () => {
  disposed = true; abort?.abort(); previewTask?.cancel(); printTask?.cancel(); observer.disconnect();
  clearPrintedPages(); void pdf?.destroy();
});
