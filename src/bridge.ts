import { native } from './native';
import { editPages, samePages } from './core';
import { pdfWork, type Inspection } from './pdf-work';
import type { Bridge, Doc, PageRef, Settings, Snapshot, View, Recent } from './shared';

type Internal = Doc & { bytes: Uint8Array; initial: PageRef[]; undo: PageRef[][]; redo: PageRef[][]; unsupported: boolean; temporary: boolean };
type Session = { settings: Settings; recent: Recent[]; tabs: { path: string; view: View }[]; active?: string; views: Record<string, View> };
const defaults: Settings = { theme: 'system', openMode: 'tab', restore: true };
const defaultView = (): View => ({ page: 1, scale: 'page-width', left: 0, top: 0 });
const key = (path: string) => path.replace(/^\\\\\?\\/, '').replaceAll('\\', '/').toLowerCase();
const nameOf = (path: string) => path.split(/[\\/]/).at(-1) || '文書.pdf';
const documents: Internal[] = [];
let active: string | null = null, settings = { ...defaults }, recent: Recent[] = [], views: Record<string, View> = {};
const listeners = new Set<(value: Snapshot) => void>(), closeListeners = new Set<() => void>();
let timer: ReturnType<typeof setTimeout> | undefined, persistChain = Promise.resolve(), mergeController: AbortController | undefined;
const report = (error: unknown) => window.dispatchEvent(new CustomEvent('folio-error', { detail: String(error) }));
function get(id: string) { const doc = documents.find(d => d.id === id); if (!doc) throw new Error('文書が見つかりません。'); return doc; }
function editable(doc: Internal) { if (doc.encrypted || doc.signed || doc.restricted || doc.unsupported) throw new Error('このPDFは閲覧専用です。'); }
function snapshot(): Snapshot {
  return structuredClone({ windowId: 1, docs: documents.map(({ bytes, initial, undo, redo, unsupported, temporary, ...doc }) => doc), active, settings, recent, windows: [{ id: 1, title: 'Folio PDF · Tauri' }] });
}
function session(): Session {
  return { settings, recent, views, tabs: documents.filter(d => !d.temporary).map(d => ({ path: d.path, view: d.view })), active: documents.find(d => d.id === active)?.path };
}
function persist(value = session()) {
  const saved = structuredClone(value);
  persistChain = persistChain.catch(() => {}).then(() => native.invoke<void>('store_session', { value: saved }));
  return persistChain;
}
function schedule() { clearTimeout(timer); timer = setTimeout(() => { void persist().catch(report); }, 500); }
function emit() { for (const listener of listeners) listener(snapshot()); schedule(); }
async function add(path: string, input?: Uint8Array, savedView?: View) {
  const existing = documents.find(d => key(d.path) === key(path));
  if (existing) { active = existing.id; return; }
  const bytes = input ?? new Uint8Array(await native.invoke<ArrayBuffer>('read_pdf', { path }));
  const info = await pdfWork<Inspection>({ type: 'inspect', bytes });
  const doc: Internal = {
    id: crypto.randomUUID(), path, name: nameOf(path), pages: [], initial: [], undo: [], redo: [], bytes,
    ...info, temporary: !!input, restricted: info.unsupported, dirty: false, version: 0, printAllowed: false,
    view: savedView ?? views[key(path)] ?? defaultView(), canUndo: false, canRedo: false,
    ui: { query: '', sensitive: false, selected: [], organize: false, panel: 'pages' }
  };
  documents.push(doc); active = doc.id;
  if (!input) recent = [{ path, name: doc.name }, ...recent.filter(r => key(r.path) !== key(path))].slice(0, 12);
}
const ready = (async () => {
  const saved = await native.invoke<Session | null>('load_session');
  if (!saved) return;
  settings = { ...defaults, theme: ['system', 'dark', 'light'].includes(saved.settings?.theme) ? saved.settings.theme : 'system', restore: saved.settings?.restore !== false };
  recent = Array.isArray(saved.recent) ? saved.recent.slice(0, 12) : [];
  views = saved.views ?? {};
  if (settings.restore) {
    for (const tab of saved.tabs ?? []) { try { await add(tab.path, undefined, tab.view); } catch (e) { report(`復元できませんでした: ${tab.path} (${e})`); recent = recent.filter(r => key(r.path) !== key(tab.path)); } }
    active = documents.find(d => key(d.path) === key(saved.active ?? ''))?.id ?? active;
  }
})().catch(report);
function remove(id: string) { const at = documents.findIndex(d => d.id === id); if (at >= 0) documents.splice(at, 1); if (active === id) active = documents.at(-1)?.id ?? null; }
async function chooseDestination(name: string, prohibited: string[]) {
  const path = await native.invoke<string | null>('choose_destination', { name });
  if (path && prohibited.some(p => key(p) === key(path))) throw new Error('原本と開いているPDFを保持するため、別の保存先を指定してください。');
  return path;
}
const unsupported = async (): Promise<never> => { throw new Error('この機能はTauri試作版では未対応です。'); };
export const bridge: Bridge = {
  snapshot: async () => { await ready; return snapshot(); },
  onChange: fn => { listeners.add(fn); return () => { listeners.delete(fn); }; },
  onCloseRequest: fn => { closeListeners.add(fn); return () => { closeListeners.delete(fn); }; },
  open: async paths => {
    await ready;
    const files = paths ?? await native.invoke<string[]>('choose_files');
    const errors: string[] = [];
    for (const path of files) { try { await add(path); } catch (e) { errors.push(`${nameOf(path)}: ${e}`); } }
    emit(); if (errors.length) throw new Error(errors.join('\n'));
  },
  dropped: async files => {
    await ready;
    for (const file of files) {
      if (!/\.pdf$/i.test(file.name)) throw new Error('PDFファイルをドロップしてください。');
      await add(`drop:${crypto.randomUUID()}/${file.name}`, new Uint8Array(await file.arrayBuffer()));
    }
    emit();
  },
  read: async id => { await ready; return get(id).bytes.slice(); },
  reload: async id => {
    const doc = get(id); if (doc.dirty) throw new Error('先に編集内容を保存してください。');
    if (doc.temporary) throw new Error('ドロップしたPDFは、ファイル選択から開き直してください。');
    const bytes = new Uint8Array(await native.invoke<ArrayBuffer>('read_pdf', { path: doc.path }));
    const info = await pdfWork<Inspection>({ type: 'inspect', bytes });
    remove(id); await add(doc.path, bytes, doc.view); const replacement = get(active!); replacement.temporary = false; Object.assign(replacement, info); emit();
  },
  initialize: async (id, count, rotations, restricted, printAllowed) => {
    const doc = get(id);
    if (!Number.isInteger(count) || count < 1 || rotations.length !== count) throw new Error('ページ情報が不正です。');
    if (!doc.pages.length) { doc.pages = rotations.map((rotation, source) => ({ id: `${id}:${source}`, source, rotation })); doc.initial = doc.pages; }
    doc.restricted = restricted || doc.unsupported; doc.printAllowed = printAllowed; emit();
  },
  edit: async (id, op) => {
    const doc = get(id); editable(doc);
    if ('ids' in op && op.ids.some(id => !doc.pages.some(p => p.id === id))) throw new Error('ページ指定が不正です。');
    const viewed = doc.pages[doc.view.page - 1]?.id;
    if (op.type === 'undo') { const previous = doc.undo.pop(); if (previous) { doc.redo.push(doc.pages); doc.pages = previous; } }
    else if (op.type === 'redo') { const next = doc.redo.pop(); if (next) { doc.undo.push(doc.pages); doc.pages = next; } }
    else { const next = editPages(doc.pages, op); if (!samePages(next, doc.pages)) { doc.undo.push(doc.pages); doc.pages = next; doc.redo = []; } }
    doc.canUndo = !!doc.undo.length; doc.canRedo = !!doc.redo.length; doc.dirty = !samePages(doc.pages, doc.initial); doc.version++;
    const index = doc.pages.findIndex(p => p.id === viewed);
    doc.view = { ...doc.view, page: index >= 0 ? index + 1 : Math.min(doc.view.page, doc.pages.length), top: 0, left: 0 };
    doc.ui.selected = doc.ui.selected.filter(id => doc.pages.some(p => p.id === id)); emit();
  },
  activate: async id => { get(id); active = id; emit(); },
  view: async (id, view) => { const doc = get(id); doc.view = view; if (!doc.temporary) views[key(doc.path)] = view; schedule(); },
  ui: async (id, ui) => { get(id).ui = structuredClone(ui); },
  save: async (id, selected) => {
    const doc = get(id); editable(doc);
    if (doc.complex && !await bridge.confirm('ページ構成を変更して保存すると、しおり・フォーム・注釈・内部リンク等を完全には保持できない場合があります。続けますか？')) return false;
    const pages = structuredClone(selected ? doc.pages.filter(p => selected.includes(p.id)) : doc.pages);
    if (!pages.length) throw new Error('保存するページを選択してください。');
    const path = await chooseDestination(doc.name.replace(/\.pdf$/i, selected ? '_抽出.pdf' : '_編集.pdf'), documents.filter(d => !d.temporary).map(d => d.path));
    if (!path) return false;
    const version = doc.version;
    const bytes = await pdfWork<Uint8Array>({ type: 'export', bytes: doc.bytes, pages });
    await native.invoke('write_pdf', { path, data: Array.from(bytes) });
    if (!selected && doc.version === version) remove(id);
    await add(path); emit(); return true;
  },
  close: async (id, discard = false) => {
    const doc = get(id);
    if (doc.dirty && !discard && !await bridge.confirm(`${doc.name} の未保存の変更を破棄して閉じますか？ 保存する場合はキャンセルしてCtrl+Sを押してください。`)) return false;
    remove(id); emit(); return true;
  },
  closeWindow: async () => {
    await ready;
    if (documents.some(d => d.dirty) && !await bridge.confirm('未保存の変更を破棄して終了しますか？ 保存する場合はキャンセルしてCtrl+Sを押してください。')) return;
    clearTimeout(timer); await persist(); await native.close();
  },
  move: unsupported,
  chooseMerge: async () => {
    const paths = await native.invoke<string[]>('choose_files');
    const { getDocument } = await import('pdfjs-dist');
    const result = [];
    for (const path of paths) {
      const bytes = new Uint8Array(await native.invoke<ArrayBuffer>('read_pdf', { path }));
      let count = 0;
      const task = getDocument({ data: bytes });
      task.onPassword = () => { void task.destroy(); };
      try { const pdf = await task.promise; count = pdf.numPages; } catch {} finally { await task.destroy(); }
      result.push({ path, name: nameOf(path), count });
    }
    return result;
  },
  merge: async paths => {
    if (!paths || paths.length < 2) throw new Error('PDFを2つ以上選択してください。');
    if (!await bridge.confirm('指定順に結合します。しおり・フォーム等を完全には保持できない場合があります。続けますか？')) return;
    const path = await chooseDestination('結合.pdf', [...paths, ...documents.filter(d => !d.temporary).map(d => d.path)]);
    if (!path) return;
    const controller = new AbortController(); mergeController = controller;
    try {
      const sources: Uint8Array[] = [];
      for (const p of paths) { if (controller.signal.aborted) throw new Error('結合をキャンセルしました。'); sources.push(new Uint8Array(await native.invoke<ArrayBuffer>('read_pdf', { path: p }))); }
      const bytes = await pdfWork<Uint8Array>({ type: 'merge', sources }, controller.signal);
      if (controller.signal.aborted) throw new Error('結合をキャンセルしました。');
      await native.invoke('write_pdf', { path, data: Array.from(bytes) }); await add(path); emit();
    } finally { if (mergeController === controller) mergeController = undefined; }
  },
  cancelMerge: async () => { mergeController?.abort(); },
  settings: async value => { if (value.theme) settings.theme = value.theme; if (typeof value.restore === 'boolean') settings.restore = value.restore; emit(); },
  clearHistory: async () => { recent = []; views = {}; emit(); },
  external: url => native.invoke('external', { url }),
  printBegin: unsupported, printPage: unsupported, printEnd: unsupported, printCancel: async () => {},
  confirm: message => native.invoke<boolean>('confirm', { message }),
  minimize: () => { void native.minimize().catch(report); }, maximize: () => { void native.maximize().catch(report); },
  quit: () => { for (const fn of closeListeners) fn(); }
};
void native.onClose(() => bridge.quit()).catch(report);
window.folio = bridge;

