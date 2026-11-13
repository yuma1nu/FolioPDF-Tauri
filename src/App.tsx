import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import { FileText, FolderOpen, Search, Settings, X, Minus, Square, ChevronLeft, ChevronRight, ChevronDown, Plus, Printer, Save, PanelsTopLeft, PanelLeftClose, PanelLeftOpen, Grid2X2, ArrowUpRight, RotateCcw, RotateCw, Trash2, Undo2, Redo2, ArrowUp, ArrowDown, Copy, Combine, Scissors, Sun, Moon, Monitor, Check, LoaderCircle, GripVertical, MoreHorizontal, FilePlus2, ArrowLeft, ZoomIn } from 'lucide-react';
import type { Doc, PageRef, Snapshot, View } from './shared';
import { loadPdf, ViewerController, type PdfSource, type SearchStatus } from './pdf';
import { parseRange } from './core';
import { native } from './native';

const api = window.folio;
const emptySearch: SearchStatus = { current: 0, total: 0, pending: false, results: [] };
const errorText = (e: unknown) => String(e instanceof Error ? e.message : e).replace(/^Error invoking remote method '[^']+': Error: /, '');
function Button({ icon: Icon, children, title, active, ...props }: { icon?: typeof Search; children?: ReactNode; title?: string; active?: boolean } & React.ButtonHTMLAttributes<HTMLButtonElement>) {
  return <button className={`button ${active ? 'active' : ''} ${!children ? 'icon-button' : ''}`} title={title} aria-label={title} {...props}>{Icon && <Icon size={16} strokeWidth={1.65} />}{children}</button>;
}
function Modal({ title, children, close, wide }: { title: string; children: ReactNode; close: () => void; wide?: boolean }) {
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => { ref.current?.showModal(); }, []);
  return <dialog ref={ref} className={`modal ${wide ? 'wide' : ''}`} onCancel={e => { e.preventDefault(); close(); }} onClick={e => { if (e.target === ref.current) close(); }}><header><h2>{title}</h2><Button icon={X} title="閉じる" onClick={close}/></header>{children}</dialog>;
}

// Bound thumbnail concurrency; leaving the viewport cancels and releases the canvas.
let thumbRunning = 0;
const thumbQueue: (() => void)[] = [];
function thumbSlot() { return new Promise<() => void>(resolve => { const start = () => { thumbRunning++; resolve(() => { thumbRunning--; thumbQueue.shift()?.(); }); }; if (thumbRunning < 2) start(); else thumbQueue.push(start); }); }
function Thumbnail({ source, page, index, selected, current, organize, onClick, onDrag, onDrop }: { source: PdfSource; page: PageRef; index: number; selected: boolean; current: boolean; organize: boolean; onClick: (event: React.MouseEvent) => void; onDrag: () => void; onDrop: () => void }) {
  const root = useRef<HTMLButtonElement>(null), canvas = useRef<HTMLCanvasElement>(null);
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    let cancelled = false, visible = false, task: { cancel: () => void } | undefined;
    const observer = new IntersectionObserver(entries => {
      if (!entries[0].isIntersecting) { visible = false; task?.cancel(); if (canvas.current) { canvas.current.width = 0; canvas.current.height = 0; } return; }
      if (visible) return; visible = true;
      void (async () => {
        const release = await thumbSlot();
        try {
          if (cancelled || !visible) return;
          const pdfPage = await source.pdf.getPage(page.source + 1);
          const full = pdfPage.getViewport({ scale: 1, rotation: page.rotation });
          const viewport = pdfPage.getViewport({ scale: Math.min(145 / full.width, 175 / full.height) * Math.min(devicePixelRatio, 1.5), rotation: page.rotation });
          const buffer = document.createElement('canvas'); buffer.width = Math.ceil(viewport.width); buffer.height = Math.ceil(viewport.height);
          const render = pdfPage.render({ canvas: buffer, viewport }); task = render; await render.promise;
          if (cancelled || !visible || !canvas.current) return;
          canvas.current.width = buffer.width; canvas.current.height = buffer.height; canvas.current.getContext('2d')!.drawImage(buffer, 0, 0);
        } catch (e) { if (!String(e).includes('cancel')) setFailed(true); }
        finally { release(); }
      })();
    }, { rootMargin: '200px' });
    observer.observe(root.current!);
    return () => { cancelled = true; task?.cancel(); observer.disconnect(); };
  }, [source, page.id, page.rotation]);
  return <button ref={root} className={`thumbnail ${current ? 'current' : ''} ${selected ? 'selected' : ''}`} aria-label={`${index + 1}ページ`} draggable={organize} onDragStart={e => { e.dataTransfer.setData('text/folio-page', page.id); onDrag(); }} onDragOver={e => { if (organize && e.dataTransfer.types.includes('text/folio-page')) e.preventDefault(); }} onDrop={e => { if (e.dataTransfer.types.includes('text/folio-page')) { e.preventDefault(); e.stopPropagation(); onDrop(); } }} onClick={onClick}>
    <div className="thumb-paper">{organize && <span className="checkmark">{selected ? <Check size={11}/> : null}</span>}<canvas ref={canvas}/>{failed && <FileText size={32}/>}</div><span className="thumb-number">{index + 1}</span>
  </button>;
}

function PdfPane({ doc, source, controller, onView, onSearch, onRendering, onError }: { doc: Doc; source: PdfSource; controller: React.RefObject<ViewerController | null>; onView: (view: View) => void; onSearch: (status: SearchStatus) => void; onRendering: (pending: boolean) => void; onError: (error: unknown) => void }) {
  const container = useRef<HTMLDivElement>(null), space = useRef(false), drag = useRef<{ x: number; y: number; left: number; top: number } | null>(null);
  const latestView = useRef(doc.view); latestView.current = doc.view;
  const signature = doc.pages.map(p => `${p.id}:${p.rotation}`).join('|');
  useEffect(() => {
    try { controller.current = new ViewerController(container.current!, source.pdf, { ...doc, view: latestView.current }, onView, onSearch, onRendering); }
    catch (e) { onError(e); }
    return () => { controller.current?.dispose(); controller.current = null; };
  }, [source, signature]);
  useEffect(() => {
    const down = (e: KeyboardEvent) => { if (e.code === 'Space' && !(e.target instanceof HTMLInputElement) && !(e.target instanceof HTMLTextAreaElement) && !document.querySelector('dialog[open]')) { e.preventDefault(); space.current = true; container.current?.classList.add('grab'); } };
    const up = () => { space.current = false; drag.current = null; container.current?.classList.remove('grab', 'grabbing'); };
    window.addEventListener('keydown', down); window.addEventListener('keyup', up); window.addEventListener('blur', up);
    return () => { window.removeEventListener('keydown', down); window.removeEventListener('keyup', up); window.removeEventListener('blur', up); };
  }, []);
  return <div ref={container} className="viewer-container" onPointerDown={e => { if ((e.button === 1 || (e.button === 0 && space.current)) && container.current) { e.preventDefault(); drag.current = { x: e.clientX, y: e.clientY, left: container.current.scrollLeft, top: container.current.scrollTop }; container.current.setPointerCapture(e.pointerId); container.current.classList.add('grabbing'); } }} onPointerMove={e => { if (drag.current && container.current) { container.current.scrollLeft = drag.current.left + drag.current.x - e.clientX; container.current.scrollTop = drag.current.top + drag.current.y - e.clientY; } }} onPointerUp={() => { drag.current = null; container.current?.classList.remove('grabbing'); }}><div className="pdfViewer" /></div>;
}

export default function App() {
  const [state, setState] = useState<Snapshot>({ windowId: 0, docs: [], active: null, settings: { theme: 'system', openMode: 'tab', restore: true }, recent: [], windows: [] });
  const [loadedSource, setSource] = useState<PdfSource | null>(null), [loading, setLoading] = useState(false), [loadError, setLoadError] = useState('');
  const [panel, setPanel] = useState<'pages' | 'search'>('pages'), [collapsed, setCollapsed] = useState(false), [sidebarWidth, setSidebarWidth] = useState(220);
  const [organize, setOrganize] = useState(false), [selection, setSelection] = useState<string[]>([]);
  const [uiOwner, setUiOwner] = useState('');
  const [query, setQuery] = useState(''), [sensitive, setSensitive] = useState(false), [search, setSearch] = useState<SearchStatus>(emptySearch);
  const [view, setView] = useState<View>({ page: 1, scale: 'page-width', left: 0, top: 0 }), [rendering, setRendering] = useState(false);
  const [modal, setModal] = useState<'settings' | 'extract' | 'merge' | 'move' | null>(null), [range, setRange] = useState(''), [rangeError, setRangeError] = useState('');
  const [merging, setMerging] = useState<{ path: string; name: string; count: number }[]>([]);
  const [busy, setBusy] = useState(''), [toast, setToast] = useState(''), [drop, setDrop] = useState(false), [reload, setReload] = useState(0);
  const [password, setPassword] = useState<{ retry: boolean; resolve: (value: string) => void; reject: () => void } | null>(null), [passwordValue, setPasswordValue] = useState('');
  const controller = useRef<ViewerController | null>(null), dragIds = useRef<string[]>([]), anchor = useRef(0), searchInput = useRef<HTMLInputElement>(null), current = useRef(state), printCancelled = useRef(false);
  current.current = state;
  const doc = state.docs.find(d => d.id === state.active);
  const source = loadedSource?.id === doc?.id ? loadedSource : null;
  const locked = !doc || doc.encrypted || doc.signed || doc.restricted;
  const notify = useCallback((error: unknown) => setToast(errorText(error)), []);
  const run = useCallback(async (action: () => Promise<unknown>, message = '') => { if (message) setBusy(message); try { await action(); } catch (error) { notify(error); } finally { if (message) setBusy(''); } }, [notify]);
  useEffect(() => { const handler = (event: Event) => notify((event as CustomEvent).detail); window.addEventListener('folio-error', handler); return () => window.removeEventListener('folio-error', handler); }, [notify]);
  useEffect(() => { void api.snapshot().then(setState).catch(notify); return api.onChange(setState); }, []);
  useEffect(() => { document.querySelector('.tabs [aria-selected="true"]')?.scrollIntoView({ block: 'nearest', inline: 'nearest' }); }, [state.active]);
  useEffect(() => api.onCloseRequest(() => { void run(() => api.closeWindow()); }), []);
  useEffect(() => { if (!toast) return; const timer = setTimeout(() => setToast(''), 6000); return () => clearTimeout(timer); }, [toast]);
  useEffect(() => {
    const media = matchMedia('(prefers-color-scheme: dark)');
    const apply = () => { document.documentElement.dataset.theme = state.settings.theme === 'system' ? media.matches ? 'dark' : 'light' : state.settings.theme; };
    apply(); media.addEventListener('change', apply); return () => media.removeEventListener('change', apply);
  }, [state.settings.theme]);
  useEffect(() => {
    let disposed = false, loaded: PdfSource | undefined;
    setSource(null); setLoadError(''); setOrganize(doc?.ui.organize ?? false); setSelection(doc?.ui.selected ?? []); setQuery(doc?.ui.query ?? ''); setSensitive(doc?.ui.sensitive ?? false); setPanel(doc?.ui.panel ?? 'pages'); setUiOwner(doc?.id ?? ''); setSearch(emptySearch);
    if (!doc) return;
    setView(doc.view); setLoading(true);
    void loadPdf(doc, retry => new Promise<string>((resolve, reject) => { setPasswordValue(''); setPassword({ retry, resolve, reject: () => reject(new Error('パスワード入力をキャンセルしました。')) }); })).then(result => { loaded = result; if (disposed) void result.pdf.destroy(); else { setSource(result); setLoading(false); } }).catch(e => { if (!disposed) { setLoadError(errorText(e)); setLoading(false); } });
    return () => { disposed = true; if (loaded) { const pdf = loaded.pdf; setTimeout(() => { void pdf.destroy(); }, 0); } };
  }, [doc?.id, reload]);
  const updateView = useCallback((value: View) => {
    setView(value);
    const id = current.current.active; if (id) void api.view(id, value).catch(() => {});
  }, []);
  useEffect(() => { if (doc && uiOwner === doc.id) void api.ui(doc.id, { query, sensitive, selected: selection, organize, panel }).catch(() => {}); }, [doc?.id, uiOwner, query, sensitive, selection, organize, panel]);
  useEffect(() => { if (doc) { setSelection(previous => previous.filter(id => doc.pages.some(p => p.id === id))); setView(doc.view); } }, [doc?.version]);
  useEffect(() => { const timer = setTimeout(() => controller.current?.search(query, sensitive), 160); return () => clearTimeout(timer); }, [query, sensitive, source, doc?.version]);
  const edit = (operation: Parameters<typeof api.edit>[1]) => { if (doc) void run(() => api.edit(doc.id, operation)); };
  const choose = (index: number, event: React.MouseEvent) => {
    if (!doc) return;
    if (!organize) { controller.current?.go(index + 1); return; }
    const id = doc.pages[index].id;
    if (event.shiftKey) setSelection(doc.pages.slice(Math.min(anchor.current, index), Math.max(anchor.current, index) + 1).map(p => p.id));
    else if (event.ctrlKey || event.metaKey) { setSelection(previous => previous.includes(id) ? previous.filter(p => p !== id) : [...previous, id]); anchor.current = index; }
    else { setSelection([id]); anchor.current = index; }
  };
  const moveSelection = (delta: number) => {
    if (!doc || !selection.length) return;
    const indices = selection.map(id => doc.pages.findIndex(p => p.id === id)).sort((a,b) => a-b);
    const target = delta < 0 ? Math.max(0, indices[0] - 1) : Math.min(doc.pages.length, indices.at(-1)! + 2);
    edit({ type: 'move', ids: selection, before: doc.pages[target]?.id ?? null });
  };
  const save = () => { if (doc) void run(() => api.save(doc.id), 'PDFを保存しています…'); };
  const print = async () => { notify('印刷はTauri試作版では未対応です。'); };
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (busy) { if (e.ctrlKey || e.metaKey) e.preventDefault(); return; }
      const input = e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement || (e.target instanceof HTMLElement && e.target.isContentEditable);
      if (document.querySelector('dialog[open]')) return;
      if (e.ctrlKey || e.metaKey) {
        if (e.key.toLowerCase() === 'o') { e.preventDefault(); void run(() => api.open()); }
        if (e.key.toLowerCase() === 'f') { e.preventDefault(); setCollapsed(false); setPanel('search'); setTimeout(() => searchInput.current?.focus(), 0); }
        if (e.key.toLowerCase() === 's') { e.preventDefault(); save(); }
        if (e.key.toLowerCase() === 'p') { e.preventDefault(); void print(); }
        if (e.key.toLowerCase() === 'w' && doc) { e.preventDefault(); void run(() => api.close(doc.id)); }
        if (e.key === 'Tab' && state.docs.length) { e.preventDefault(); const index = state.docs.findIndex(d => d.id === doc?.id); void api.activate(state.docs[(index + (e.shiftKey ? -1 : 1) + state.docs.length) % state.docs.length].id); }
        if (!input && e.key.toLowerCase() === 'z') { e.preventDefault(); edit({ type: e.shiftKey ? 'redo' : 'undo' }); }
        if (!input && e.key.toLowerCase() === 'y') { e.preventDefault(); edit({ type: 'redo' }); }
        if (!input && ['+', '=', '-'].includes(e.key)) { e.preventDefault(); const v = controller.current; if (v) v.zoom(v.viewer.currentScale * (e.key === '-' ? 1 / 1.2 : 1.2)); }
        if (!input && e.key.toLowerCase() === 'a' && organize && doc) { e.preventDefault(); setSelection(doc.pages.map(p => p.id)); }
      }
      if (!input && e.key === 'Delete' && organize && selection.length && !locked) { e.preventDefault(); edit({ type: 'delete', ids: selection }); setSelection([]); }
      if (e.key === 'Escape') { setQuery(''); if (organize) setOrganize(false); else setPanel('pages'); }
    };
    window.addEventListener('keydown', handler); return () => window.removeEventListener('keydown', handler);
  });
  const dropRef = useRef(0);
  return <div className="app" onDragEnter={e => { if (e.dataTransfer.types.includes('Files')) { e.preventDefault(); dropRef.current++; setDrop(true); } }} onDragLeave={e => { if (e.dataTransfer.types.includes('Files') && --dropRef.current <= 0) setDrop(false); }} onDragOver={e => { if (e.dataTransfer.types.includes('Files')) e.preventDefault(); }} onDrop={e => { if (e.dataTransfer.files.length) { e.preventDefault(); setDrop(false); dropRef.current = 0; void run(() => api.dropped([...e.dataTransfer.files])); } }}>
    <header className="titlebar">
      <div className="brand" onMouseDown={e => { if (e.button === 0) void native.drag().catch(notify); }}><span className="brand-icon"><FileText size={18}/></span><span>Folio <b>PDF</b></span></div>
      <div className="tabs" role="tablist">{state.docs.map(item => <div key={item.id} className={`tab ${doc?.id === item.id ? 'selected' : ''}`} role="tab" aria-selected={doc?.id === item.id} title={item.path} onClick={() => { void api.activate(item.id); }}><FileText size={14}/><span>{item.name}</span>{item.dirty && <span className="dirty-dot"/>}<button aria-label={`${item.name}を閉じる`} onClick={e => { e.stopPropagation(); void run(() => api.close(item.id)); }}><X size={12}/></button></div>)}<Button icon={Plus} title="PDFを開く (Ctrl+O)" onClick={() => { void run(() => api.open()); }}/></div>
      <div className="window-controls"><button aria-label="最小化" onClick={() => api.minimize()}><Minus size={14}/></button><button aria-label="最大化・元に戻す" onClick={() => api.maximize()}><Square size={11}/></button><button className="window-close" aria-label="ウィンドウを閉じる" onClick={() => api.quit()}><X size={16}/></button></div>
    </header>
    <div className="workspace">
      <aside className={collapsed ? 'folio-sidebar collapsed' : 'folio-sidebar'} style={{ width: collapsed ? 48 : sidebarWidth }}>
        <nav className="primary-nav"><Button icon={FolderOpen} title="PDFを開く" onClick={() => { void run(() => api.open()); }}>{!collapsed && 'PDFを開く'}{!collapsed && <kbd>Ctrl O</kbd>}</Button><Button icon={Search} title="検索 (Ctrl+F)" active={panel === 'search' && !collapsed} onClick={() => { setCollapsed(false); setPanel('search'); setTimeout(() => searchInput.current?.focus(), 0); }}>{!collapsed && '検索'}{!collapsed && <kbd>Ctrl F</kbd>}</Button></nav>
        {!collapsed && <div className="sidebar-heading"><span>{panel === 'search' ? '文書内を検索' : 'ページ'}</span>{panel === 'search' ? <Button icon={Grid2X2} title="サムネイルへ" onClick={() => setPanel('pages')}/> : <span>{doc?.pages.length ?? 0}</span>}</div>}
        {!collapsed && panel === 'search' ? <div className="search-panel"><div className="search-box"><Search size={15}/><input ref={searchInput} placeholder="検索する文字を入力" value={query} onChange={e => setQuery(e.target.value)} onKeyDown={e => { if (e.key === 'Enter') controller.current?.next(e.shiftKey); }}/>{query && <button aria-label="検索を消去" onClick={() => setQuery('')}><X size={13}/></button>}</div><div className="search-options"><label><input type="checkbox" checked={sensitive} onChange={e => setSensitive(e.target.checked)}/> 大文字小文字を区別</label></div><div className="search-count"><span>{query ? search.pending ? '検索中…' : `${search.total}件の一致` : 'すべてのページを検索します'}</span><Button icon={ChevronLeft} title="前の一致" onClick={() => controller.current?.next(true)}/><Button icon={ChevronRight} title="次の一致" onClick={() => controller.current?.next()}/></div><div className="search-results">{search.results.map(result => <button key={result.page} onClick={() => controller.current?.go(result.page)}><span>{result.page} ページ <small>{result.count}件</small></span><p>{result.text}</p></button>)}{query && !search.pending && search.total === 0 && <p className="muted small">一致する文字がありません。スキャンされた画像の文字検索には対応していません。</p>}</div></div> : !collapsed && <div className="thumbnails">{doc && source && doc.pages.map((page, i) => <Thumbnail key={page.id} source={source} page={page} index={i} selected={false} current={view.page === i + 1} organize={false} onClick={e => choose(i, e)} onDrag={() => {}} onDrop={() => {}}/>)}{!doc && <p className="sidebar-empty">PDFを開くと<br/>ページがここに表示されます</p>}</div>}
        <div className="sidebar-footer"><div className="local-status">{!collapsed && <><span className="status-dot"/>ローカルで処理</>}</div><Button icon={Settings} title="設定" onClick={() => setModal('settings')}>{!collapsed && '設定'}</Button></div>
        {!collapsed && <div className="sidebar-resizer" onPointerDown={e => { e.currentTarget.setPointerCapture(e.pointerId); }} onPointerMove={e => { if (e.currentTarget.hasPointerCapture(e.pointerId)) setSidebarWidth(Math.max(160, Math.min(360, e.clientX))); }} onPointerUp={e => { e.currentTarget.releasePointerCapture(e.pointerId); }}/>}</aside>
      <main>
        {!doc && <div className="toolbar home-toolbar"><Button icon={collapsed ? PanelLeftOpen : PanelLeftClose} title="サイドバーの切り替え" onClick={() => setCollapsed(!collapsed)}/><div className="toolbar-spacer"/></div>}
        {doc ? <>
          <div className="toolbar"><Button icon={collapsed ? PanelLeftOpen : PanelLeftClose} title="サイドバーの切り替え" onClick={() => setCollapsed(!collapsed)}/><span className="toolbar-divider"/><div className="toolbar-group"><Button icon={ChevronLeft} title="前のページ" disabled={view.page <= 1} onClick={() => controller.current?.go(view.page - 1)}/><input className="page-input" type="number" min="1" max={doc.pages.length} aria-label="ページ番号" key={`${doc.id}:${view.page}`} defaultValue={view.page} onKeyDown={e => { if (e.key === 'Enter') { const n = Number(e.currentTarget.value); if (n >= 1 && n <= doc.pages.length) controller.current?.go(n); else notify(`1〜${doc.pages.length}ページを指定してください。`); } }}/><span className="muted">/ {doc.pages.length || '—'}</span><Button icon={ChevronRight} title="次のページ" disabled={view.page >= doc.pages.length} onClick={() => controller.current?.go(view.page + 1)}/></div><span className="toolbar-divider"/><div className="toolbar-group"><Button icon={Minus} title="縮小" onClick={() => { const c = controller.current; if (c) c.zoom(c.viewer.currentScale / 1.2); }}/><select aria-label="表示倍率" value={['page-width', 'page-fit', 'auto'].includes(view.scale) ? view.scale : String(Math.round(Number(view.scale) * 100))} onChange={e => controller.current?.zoom(/^[\d.]+$/.test(e.target.value) ? Number(e.target.value) / 100 : e.target.value)}><option value="page-width">幅に合わせる</option><option value="page-fit">ページ全体</option>{[25, 50, 75, 100, 125, 150, 200, 400, 800, 1600, ...(/^[\d.]+$/.test(view.scale) ? [Math.round(Number(view.scale) * 100)] : [])].filter((v,i,a) => a.indexOf(v) === i).sort((a,b) => a-b).map(v => <option value={v} key={v}>{v}%</option>)}</select><Button icon={Plus} title="拡大" onClick={() => { const c = controller.current; if (c) c.zoom(c.viewer.currentScale * 1.2); }}/></div><div className="toolbar-spacer"/><Button icon={Grid2X2} title="ページ整理" active={organize} disabled={locked || !source} onClick={() => { setOrganize(!organize); setPanel('pages'); }}>{'ページ整理'}</Button><Button icon={Combine} title="PDFを結合" onClick={() => { setMerging([]); setModal('merge'); }}>結合</Button><Button icon={Save} title="名前を付けて保存 (Ctrl+S)" disabled={locked || !source} onClick={save}/><Button icon={Printer} aria-label="印刷（試作版では未対応）" disabled title="印刷はTauri試作版では未対応です" onClick={() => { void print(); }}/><span className="save-state" title={doc.dirty ? "未保存の変更" : "保存済み"} aria-label={doc.dirty ? "未保存の変更" : "保存済み"}>{doc.dirty ? <span className="dirty-dot"/> : <Check size={12}/>}<span className="save-state-label">{doc.dirty ? "未保存" : "保存済み"}</span></span></div>
          {(doc.encrypted || doc.signed || doc.restricted) && <div className="notice">このPDFは閲覧専用です。{doc.encrypted ? '暗号化' : doc.signed ? '電子署名' : '権限制限・未対応形式'}のためページ編集はできません。</div>}
          {doc.changed && <div className="notice">元ファイルが外部で変更された可能性があります。編集中の内容は保持されています。<button onClick={() => { if (!doc.dirty) void run(() => api.reload(doc.id)); else notify('編集を別名で保存してから開き直してください。'); }}>再読み込み</button></div>}
          {organize && <div className="organize-toolbar"><span>{selection.length ? `${selection.length}ページを選択` : 'ページを選択・ドラッグして整理'}</span><Button icon={ArrowUp} title="前へ移動" disabled={!selection.length} onClick={() => moveSelection(-1)}/><Button icon={ArrowDown} title="後ろへ移動" disabled={!selection.length} onClick={() => moveSelection(1)}/><Button icon={RotateCcw} title="左に90度回転" disabled={!selection.length} onClick={() => edit({ type: 'rotate', ids: selection, delta: -90 })}/><Button icon={RotateCw} title="右に90度回転" disabled={!selection.length} onClick={() => edit({ type: 'rotate', ids: selection, delta: 90 })}/><Button icon={Trash2} title="選択ページを削除" disabled={!selection.length} onClick={() => { edit({ type: 'delete', ids: selection }); setSelection([]); }}/><Button icon={Scissors} title="ページを抽出・分割" onClick={() => { setRange(selection.length ? doc.pages.flatMap((p,i) => selection.includes(p.id) ? [i+1] : []).join(', ') : ''); setRangeError(''); setModal('extract'); }}>抽出</Button><div className="toolbar-spacer"/><Button icon={Undo2} title="元に戻す" disabled={!doc.canUndo} onClick={() => edit({ type: 'undo' })}/><Button icon={Redo2} title="やり直す" disabled={!doc.canRedo} onClick={() => edit({ type: 'redo' })}/><button className="primary" onClick={() => setOrganize(false)}>完了</button></div>}
          <div className="document-area">
            {source && doc.pages.length > 0 && <div className={`pdf-pane ${organize ? 'hidden' : ''}`}><PdfPane doc={doc} source={source} controller={controller} onView={updateView} onSearch={setSearch} onRendering={setRendering} onError={notify}/></div>}
            {organize && source && <div className="page-grid" onDragOver={e => { if (e.dataTransfer.types.includes('text/folio-page')) e.preventDefault(); }} onDrop={e => { if (e.dataTransfer.types.includes('text/folio-page')) { e.preventDefault(); edit({ type: 'move', ids: dragIds.current, before: null }); } }}>{doc.pages.map((page, i) => <Thumbnail key={page.id} source={source} page={page} index={i} selected={selection.includes(page.id)} current={false} organize onClick={e => choose(i,e)} onDrag={() => { dragIds.current = selection.includes(page.id) ? selection : [page.id]; }} onDrop={() => edit({ type: 'move', ids: dragIds.current, before: page.id })}/>)}</div>}
            {loading && <div className="document-placeholder"><LoaderCircle className="spin" size={26}/><p>PDFを読み込んでいます</p></div>}
            {loadError && <div className="document-placeholder"><FileText size={32}/><h3>PDFを表示できませんでした</h3><p>{loadError}</p><button className="primary" onClick={() => setReload(n => n+1)}>再試行</button></div>}
          </div><footer className="statusbar"><span>{doc.pages.length}ページ{organize ? ' · Ctrlで複数選択 / Shiftで範囲選択' : ' · Ctrl+ホイールで拡大 / Space+ドラッグで移動'}</span><span>{rendering && !organize ? <><LoaderCircle size={11} className="spin"/> 高精細化中</> : 'PDFの元の色で表示'}</span></footer>
        </> : <div className="home"><div className="home-heading"><span className="eyebrow">YOUR EVERYDAY PDF COMPANION</span><h1>読むことに、集中。</h1><p>図面も資料も、すっきりと。<br/>必要なページを、すぐ手元に。</p></div><button className="open-card" onClick={() => { void run(() => api.open()); }}><span className="open-card-icon"><FilePlus2 size={28} strokeWidth={1.2}/></span><strong>PDFを開く</strong><span>ファイルを選ぶ、またはここにドロップ</span><kbd>Ctrl + O</kbd></button><div className="home-section"><div className="section-title"><h2>最近開いたファイル</h2><span>このデバイス</span></div>{state.recent.length ? <div className="recent-list">{state.recent.map(item => <button key={item.path} onClick={() => { void run(() => api.open([item.path])); }}><FileText size={19} strokeWidth={1.4}/><div><strong>{item.name}</strong><small>{item.path}</small></div><ArrowUpRight size={15}/></button>)}</div> : <div className="empty-recent"><FileText size={20}/><span>開いたPDFがここに表示されます</span></div>}</div><div className="home-bottom"><span><span className="status-dot"/> ファイルは端末の外に送信されません</span><button onClick={() => { setMerging([]); setModal('merge'); }}><Combine size={15}/> PDFを結合する <ArrowUpRight size={13}/></button></div></div>}
      </main>
    </div>
    {drop && <div className="drop-overlay"><FolderOpen size={40}/><h2>PDFをここにドロップ</h2><p>複数のファイルもまとめて開けます</p></div>}
    {toast && <div role="status" className="toast"><span>{toast}</span><Button icon={X} title="通知を閉じる" onClick={() => setToast('')}/></div>}
    {busy && <div className="busy-overlay"><LoaderCircle className="spin" size={23}/><span>{busy}</span>{(busy.startsWith('印刷を準備') || busy.startsWith('PDFを結合')) && <button onClick={() => { if (busy.startsWith('PDFを結合')) void api.cancelMerge(); else printCancelled.current = true; }}>キャンセル</button>}</div>}
    {modal === 'settings' && <Modal title="設定" close={() => setModal(null)}><div className="modal-body"><h3>外観</h3><p className="muted">PDFの紙面は元の色のまま表示します。</p><div className="theme-options">{([{ value: 'light', label: 'ライト', icon: Sun }, { value: 'dark', label: 'ダーク', icon: Moon }, { value: 'system', label: 'OSに合わせる', icon: Monitor }] as const).map(item => <button key={item.value} className={state.settings.theme === item.value ? 'selected' : ''} onClick={() => { void api.settings({ theme: item.value }); }}><item.icon size={22}/><span>{item.label}</span></button>)}</div><h3>PDFの開き方</h3><p className="muted small">Tauri試作版は単一ウィンドウ・タブ表示です。印刷とファイルの外部変更監視は未対応です。</p><select disabled value={state.settings.openMode} onChange={e => { void api.settings({ openMode: e.target.value as 'tab' | 'window' }); }}><option value="tab">新しいタブで開く</option><option value="window">別ウィンドウで開く</option></select><label className="setting-check"><input type="checkbox" checked={state.settings.restore} onChange={e => { void api.settings({ restore: e.target.checked }); }}/> 前回のタブ・閲覧位置を復元する</label><h3>履歴とプライバシー</h3><p className="muted">すべての処理はローカルで行います。未保存編集の異常終了からの復旧は対象外です。</p><button className="button bordered" onClick={() => { void run(async () => { if (await api.confirm('最近開いたファイルと閲覧位置の履歴を消去しますか？')) await api.clearHistory(); }); }}>閲覧履歴を消去</button><div className="about">Folio PDF 0.1.0 · Tauri 2 / PDF.js · 試作版</div></div></Modal>}
    {modal === 'extract' && doc && <Modal title="ページを抽出・分割" close={() => setModal(null)}><div className="modal-body"><p>指定したページを1つの別PDFとして保存します。現在の並び順と回転が反映されます。</p><label className="field-label">ページ範囲（全{doc.pages.length}ページ）</label><input className="text-input" autoFocus placeholder="例：1-3, 5, 8-10" value={range} onChange={e => { setRange(e.target.value); setRangeError(''); }}/>{rangeError && <p className="error">{rangeError}</p>}<p className="muted small">元のPDFからページは削除されません。</p><div className="modal-actions"><button className="button" onClick={() => setModal(null)}>キャンセル</button><button className="primary" onClick={() => { try { const ids = parseRange(range, doc.pages.length).map(i => doc.pages[i].id); setModal(null); void run(() => api.save(doc.id, ids), 'ページを抽出しています…'); } catch(e) { setRangeError(errorText(e)); } }}>別PDFに保存</button></div></div></Modal>}
    {modal === 'merge' && <Modal title="PDFを結合" close={() => setModal(null)} wide><div className="modal-body"><p>ファイルを追加し、結合する順番に並べてください。</p><p className="muted small">保存済みのPDFを使います。タブの未保存編集は含まれません。</p><div className="merge-list">{merging.map((item, i) => <div className="merge-row" key={`${item.path}:${i}`}><span className="muted">{i+1}</span><FileText size={18}/><div title={item.path}><strong>{item.name}</strong><small>{item.count ? `${item.count}ページ` : '暗号化・未対応PDF'}</small></div><Button icon={ArrowUp} title="上へ" disabled={i === 0} onClick={() => setMerging(items => { const copy = [...items]; [copy[i-1],copy[i]]=[copy[i],copy[i-1]]; return copy; })}/><Button icon={ArrowDown} title="下へ" disabled={i === merging.length-1} onClick={() => setMerging(items => { const copy = [...items]; [copy[i],copy[i+1]]=[copy[i+1],copy[i]]; return copy; })}/><Button icon={X} title="除外" onClick={() => setMerging(items => items.filter((_, n) => n !== i))}/></div>)}</div><button className="button bordered" onClick={() => { void api.chooseMerge().then(items => setMerging(previous => [...previous, ...items])).catch(notify); }}><Plus size={15}/> PDFを追加</button><div className="modal-actions"><span className="muted small">{merging.length}ファイル · {merging.reduce((n,p) => n+p.count, 0)}ページ</span><button className="primary" disabled={merging.length < 2 || merging.some(p => !p.count)} onClick={() => { const paths = merging.map(p => p.path); setModal(null); void run(() => api.merge(paths), 'PDFを結合しています…'); }}>結合して保存</button></div></div></Modal>}
    {modal === 'move' && doc && <Modal title="ウィンドウへ移動" close={() => setModal(null)}><div className="modal-body"><p className="muted">閲覧位置と未保存の編集を維持して移動します。</p><button className="move-option" onClick={() => { setModal(null); void run(() => api.move(doc.id)); }}><PanelsTopLeft size={20}/> 新しいウィンドウへ <ArrowUpRight size={16}/></button>{state.windows.filter(w => w.id !== state.windowId).map(w => <button className="move-option" key={w.id} onClick={() => { setModal(null); void run(() => api.move(doc.id,w.id)); }}><Copy size={18}/><span>{w.title}</span><ChevronRight size={15}/></button>)}</div></Modal>}
    {password && <Modal title={password.retry ? 'パスワードが正しくありません' : 'PDFのパスワード'} close={() => { password.reject(); setPassword(null); }}><form className="modal-body" onSubmit={e => { e.preventDefault(); password.resolve(passwordValue); setPassword(null); setPasswordValue(''); }}><p>このPDFを開くためのパスワードを入力してください。</p><input autoFocus className="text-input" type="password" value={passwordValue} onChange={e => setPasswordValue(e.target.value)}/><div className="modal-actions"><button className="primary" type="submit">開く</button></div></form></Modal>}
  </div>;
}


