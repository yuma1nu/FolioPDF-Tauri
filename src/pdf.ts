import { getDocument, GlobalWorkerOptions, PermissionFlag, type PDFDocumentProxy, type PDFPageProxy } from 'pdfjs-dist';
import workerUrl from 'pdfjs-dist/build/pdf.worker.min.mjs?url';
import { EventBus, PDFViewer, PDFLinkService, PDFFindController } from 'pdfjs-dist/web/pdf_viewer.mjs';
import type { Doc, PageRef, View } from './shared';
GlobalWorkerOptions.workerSrc = workerUrl;
const base = new URL('./pdf-assets/', location.href).href;
export type PdfSource = { id: string; pdf: PDFDocumentProxy; printAllowed: boolean };
export async function loadPdf(doc: Doc, password: (retry: boolean) => Promise<string>): Promise<PdfSource> {
  const task = getDocument({ data: await window.folio.read(doc.id), cMapUrl: `${base}cmaps/`, cMapPacked: true, standardFontDataUrl: `${base}standard_fonts/`, wasmUrl: `${base}wasm/`, enableXfa: false });
  task.onPassword = (update: (value: string) => void, reason: number) => { password(reason === 2).then(update).catch(() => { void task.destroy(); }); };
  const pdf = await task.promise;
  const permissions = await pdf.getPermissions();
  const printAllowed = !permissions || permissions.includes(PermissionFlag.PRINT) || permissions.includes(PermissionFlag.PRINT_HIGH_QUALITY);
  const restricted = !!permissions && (!permissions.includes(PermissionFlag.MODIFY_CONTENTS) || !printAllowed);
  if (!doc.pages.length) {
    const rotations: number[] = [];
    for (let i = 1; i <= pdf.numPages; i++) rotations.push((await pdf.getPage(i)).rotate);
    await window.folio.initialize(doc.id, pdf.numPages, rotations, restricted, printAllowed);
  } else await window.folio.initialize(doc.id, pdf.numPages, Array(pdf.numPages).fill(0), restricted, printAllowed);
  return { id: doc.id, pdf, printAllowed };
}
// Bind methods to their real PDF.js instances: its private fields cannot be accessed through a Proxy.
export function mappedDocument(pdf: PDFDocumentProxy, pages: PageRef[]): PDFDocumentProxy {
  const cache = new Map<number, PDFPageProxy>();
  return new Proxy(pdf, { get(target, prop) {
    if (prop === 'numPages') return pages.length;
    if (prop === 'getPageIndex') return async (ref: unknown) => { const original = await pdf.getPageIndex(ref as never); const index = pages.findIndex(p => p.source === original); if (index < 0) throw new Error('リンク先のページは削除されています。'); return index; };
    if (prop === 'getPageLabels') return async () => null;
    if (prop === 'getPage') return async (number: number) => {
      if (cache.has(number)) return cache.get(number)!;
      const mapping = pages[number - 1];
      if (!mapping) throw new Error('ページが見つかりません。');
      const original = await target.getPage(mapping.source + 1);
      const page = new Proxy(original, { get(page, key) {
        if (key === 'rotate') return mapping.rotation;
        const value = Reflect.get(page, key, page); return typeof value === 'function' ? value.bind(page) : value;
      } });
      cache.set(number, page); return page;
    };
    const value = Reflect.get(target, prop, target); return typeof value === 'function' ? value.bind(target) : value;
  } });
}
export type SearchStatus = { current: number; total: number; pending: boolean; results: { page: number; count: number; text: string }[] };
export class ViewerController {
  bus = new EventBus();
  link = new PDFLinkService({ eventBus: this.bus, ignoreDestinationZoom: true });
  find = new PDFFindController({ eventBus: this.bus, linkService: this.link });
  viewer: PDFViewer;
  private resize: ResizeObserver;
  private timer?: ReturnType<typeof setTimeout>;
  private query = '';
  private sensitive = false;
  private count = { current: 0, total: 0 };
  private pending = false;
  private disposed = false;
  private density = devicePixelRatio;
  private densityQuery?: MediaQueryList;
  private densityChanged = () => {
    if (this.disposed) return;
    this.densityQuery?.removeEventListener('change', this.densityChanged);
    this.density = devicePixelRatio;
    this.densityQuery = matchMedia(`(resolution: ${this.density}dppx)`);
    this.densityQuery.addEventListener('change', this.densityChanged);
    this.viewer.refresh();
  };
  constructor(public container: HTMLDivElement, public pdf: PDFDocumentProxy, public doc: Doc, onView: (view: View) => void, onSearch: (status: SearchStatus) => void, onRendering: (pending: boolean) => void) {
    this.link.addLinkAttributes = (anchor, url) => { anchor.href = '#'; anchor.title = url; anchor.onclick = event => { event.preventDefault(); void window.folio.external(url); }; };
    this.viewer = new PDFViewer({ container, viewer: container.querySelector('.pdfViewer')!, eventBus: this.bus, linkService: this.link, findController: this.find, removePageBorders: true, textLayerMode: 1, annotationMode: 1, annotationEditorMode: -1, enablePermissions: true, maxCanvasPixels: 8_388_608, maxCanvasDim: 8192, capCanvasAreaFactor: 150, enableDetailCanvas: true, enableOptimizedPartialRendering: true, minDurationToUpdateCanvas: 120, enableAutoLinking: false, imagesRightClickMinSize: -1 });
    this.link.setViewer(this.viewer);
    const mapped = mappedDocument(pdf, doc.pages);
    this.link.setDocument(mapped);
    this.bus.on('pagesinit', () => {
      if (this.disposed) return;
      this.viewer.currentScaleValue = doc.view.scale || 'page-width';
      this.viewer.currentPageNumber = Math.min(doc.pages.length, Math.max(1, doc.view.page));
      requestAnimationFrame(() => { if (doc.view.top) { container.scrollTop = doc.view.top; container.scrollLeft = doc.view.left; } });
    });
    this.bus.on('updateviewarea', () => {
      if (this.disposed) return;
      onView({ page: this.viewer.currentPageNumber, scale: this.viewer.currentScaleValue, left: container.scrollLeft, top: container.scrollTop });
    });
    const updateSearch = () => {
      if (this.disposed) return;
      const results = (this.find.pageMatches ?? []).flatMap((matches, index) => matches?.length ? [{ page: index + 1, count: matches.length, text: String(this.find._pageContents?.[index] ?? '').slice(Math.max(0, matches[0] - 22), matches[0] + 100) }] : []);
      onSearch({ ...this.count, pending: this.pending, results });
    };
    this.bus.on('updatefindmatchescount', (event: any) => { this.count = event.matchesCount; updateSearch(); });
    this.bus.on('updatefindcontrolstate', (event: any) => { this.pending = event.state === 3; if (event.matchesCount) this.count = event.matchesCount; updateSearch(); });
    this.bus.on('pagerender', () => onRendering(true));
    this.bus.on('pagerendered', (event: any) => { if (!event.cssTransform && (event.isDetailView || !(this.viewer.getPageView(event.pageNumber - 1) as any)?.detailView)) onRendering(false); });
    this.viewer.setDocument(mapped);
    this.resize = new ResizeObserver(() => { if (!this.disposed) { if (['page-width', 'page-fit', 'auto'].includes(this.viewer.currentScaleValue)) this.viewer.currentScaleValue = this.viewer.currentScaleValue; this.viewer.update(); } });
    this.resize.observe(container);
    this.densityQuery = matchMedia(`(resolution: ${this.density}dppx)`);
    this.densityQuery.addEventListener('change', this.densityChanged);
    container.addEventListener('wheel', this.wheel, { passive: false });
  }
  private wheel = (event: WheelEvent) => {
    if (!event.ctrlKey) return; event.preventDefault();
    const factor = Math.exp(-event.deltaY * 0.002);
    this.zoom(Math.max(0.25, Math.min(16, this.viewer.currentScale * factor)), event.clientX, event.clientY);
  };
  zoom(scale: number | string, x?: number, y?: number) {
    const rect = this.container.getBoundingClientRect(), px = x === undefined ? this.container.clientWidth / 2 : x - rect.left, py = y === undefined ? this.container.clientHeight / 2 : y - rect.top;
    const old = this.viewer.currentScale, left = this.container.scrollLeft, top = this.container.scrollTop;
    const oldWidth = this.viewer.viewer!.getBoundingClientRect().width;
    if (typeof scale === 'number') this.viewer.updateScale({ scaleFactor: Math.max(.25, Math.min(16, scale)) / old, origin: [px, py], drawingDelay: 120 });
    else this.viewer.currentScaleValue = scale;
    if (typeof scale === 'number') {
      const factor = this.viewer.currentScale / old;
      const newWidth = this.viewer.viewer!.getBoundingClientRect().width;
      // The content width has a viewport-sized minimum. Its empty margins do
      // not scale like PDF coordinates when crossing the fit-width boundary.
      const offset = left + px - oldWidth / 2;
      const anchorOffset = Math.abs(offset) <= 1 ? 0 : offset;
      const targetX = x === undefined ? this.container.clientWidth / 2 : px;
      this.container.scrollLeft = newWidth / 2 + anchorOffset * factor - targetX;
      this.container.scrollTop = (top + py) * factor - py;
    }
  }
  go(page: number) { if (page >= 1 && page <= this.doc.pages.length) this.viewer.currentPageNumber = page; }
  search(query: string, sensitive = false, again = false, backwards = false) {
    this.query = query; this.sensitive = sensitive;
    this.bus.dispatch('find', { source: this, type: again ? 'again' : '', query, caseSensitive: sensitive, entireWord: false, highlightAll: true, findPrevious: backwards, matchDiacritics: false });
  }
  next(backwards = false) { this.search(this.query, this.sensitive, true, backwards); }
  dispose() { this.disposed = true; clearTimeout(this.timer); this.resize.disconnect(); this.densityQuery?.removeEventListener('change', this.densityChanged); this.container.removeEventListener('wheel', this.wheel); this.viewer.setDocument(null as never); this.find.setDocument(null as never); }
}


