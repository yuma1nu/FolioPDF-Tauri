import { native } from './native';
import { editPages, samePages } from './core';
import { pdfWork, type Inspection } from './pdf-work';
import type { Bridge, Doc, PageRef, Settings, Snapshot, View, Recent } from './shared';

type Internal = Doc & { bytes: Uint8Array; initial: PageRef[]; undo: PageRef[][]; redo: PageRef[][]; unsupported: boolean; temporary: boolean };
type Session = { windowId: number; settings: Settings; recent: Recent[]; tabs: { path: string; view: View }[]; active?: string; views: Record<string, View>; warning?: string };
const defaults: Settings = { theme: 'system', openMode: 'tab', restore: true };
const defaultView = (): View => ({ page: 1, scale: 'page-width', left: 0, top: 0 });
const key = (path: string) => path.replace(/^\\\\\?\\/, '').replaceAll('\\', '/').toLowerCase();
const nameOf = (path: string) => path.split(/[\\/]/).at(-1) || '文書.pdf';
const documents: Internal[] = [];
let active: string | null = null, settings = { ...defaults }, recent: Recent[] = [], views: Record<string, View> = {};
let windowId = 1, windows: Snapshot['windows'] = [], closing = false;
const moving = new Set<string>(), replacements = new Map<string, string>(), received = new Set<string>();
let receiveChain = Promise.resolve();
const listeners = new Set<(value: Snapshot) => void>(), closeListeners = new Set<() => void>();
let timer: ReturnType<typeof setTimeout> | undefined, persistChain = Promise.resolve(), mergeController: AbortController | undefined;
const report = (error: unknown) => window.dispatchEvent(new CustomEvent('folio-error', { detail: String(error) }));
function get(id: string) { const doc = documents.find(d => d.id === id); if (!doc) throw new Error('文書が見つかりません。'); return doc; }
function editable(doc: Internal) { if (doc.encrypted || doc.signed || doc.restricted || doc.unsupported) throw new Error('このPDFは閲覧専用です。'); }
function snapshot(): Snapshot {
  return structuredClone({ windowId, docs: documents.map(({ bytes, initial, undo, redo, unsupported, temporary, ...doc }) => doc), active, settings, recent, windows });
}
function session(): Session {
  return { windowId, settings, recent, views, tabs: documents.filter(d => !d.temporary).map(d => ({ path: d.path, view: d.view })), active: documents.find(d => d.id === active)?.path };
}
function persist(value = session()) {
  const saved = structuredClone(value);
  persistChain = persistChain.catch(() => {}).then(() => native.invoke<void>('store_session', { value: saved }));
  return persistChain;
}
function schedule() { clearTimeout(timer); timer = setTimeout(() => { void persist().catch(report); }, 500); }
function emit(save = true) { for (const listener of listeners) listener(snapshot()); if (save) schedule(); }
async function add(path: string, input?: Uint8Array, savedView?: View) {
  const existing = documents.find(d => key(d.path) === key(path));
  if (existing) { active = existing.id; return; }
  const id = crypto.randomUUID();
  if (!input && !await native.invoke<boolean>('claim_pdf', { path, docId: id })) return;
  let bytes: Uint8Array, info: Inspection;
  try {
    if (!input) await native.invoke('watch_pdf', { path, docId: id });
    bytes = input ?? new Uint8Array(await native.invoke<ArrayBuffer>('read_pdf', { path }));
    info = await pdfWork<Inspection>({ type: 'inspect', bytes });
  } catch (e) { if (!input) await native.invoke('release_pdf', { docId: id }); throw e; }
  const doc: Internal = {
    id, path, name: nameOf(path), pages: [], initial: [], undo: [], redo: [], bytes,
    ...info, temporary: !!input, restricted: info.unsupported, dirty: false, version: 0, printAllowed: false,
    view: savedView ?? views[path] ?? views[key(path)] ?? defaultView(), canUndo: false, canRedo: false,
    ui: { query: '', sensitive: false, selected: [], organize: false, panel: 'pages' }
  };
  documents.push(doc); active = doc.id;
  if (!input) await native.invoke('remember_pdf', { path, name: doc.name });
}
const ready = (async () => {
  await Promise.all([
    native.listen('folio-windows', () => { void refreshWindows().catch(report); }),
    native.onBounds(schedule),
    native.listen<string>('folio-notice', report),
    native.listen<{ settings: Settings; recent: Recent[] }>('folio-preferences', value => { settings = value.settings; recent = value.recent; emit(false); }),
    native.listen<string>('folio-activate', id => { if (documents.some(d => d.id === id)) { active = id; emit(); } }),
    native.listen<{ id: string }>('folio-file-changed', value => { const doc = documents.find(d => d.id === value.id); if (doc) { doc.changed = true; emit(false); } }),
    native.listen('folio-transfer', () => { void ready.then(receiveTransfers).catch(report); }),
    native.listen('folio-launch', () => { void ready.then(openPending).catch(report); }),
    native.listen<string[]>('folio-drop', paths => { void bridge.open(paths).catch(report); })
  ]);
  const saved = await native.invoke<Session | null>('load_session');
  if (!saved) { await refreshWindows(); return; }
  windowId = saved.windowId;
  if (saved.warning) report(saved.warning);
  settings = { ...defaults, theme: ['system', 'dark', 'light'].includes(saved.settings?.theme) ? saved.settings.theme : 'system', openMode: saved.settings?.openMode === 'window' ? 'window' : 'tab', restore: saved.settings?.restore !== false };
  recent = Array.isArray(saved.recent) ? saved.recent.slice(0, 12) : [];
  views = saved.views ?? {};
  if (settings.restore) {
    for (const tab of saved.tabs ?? []) { try { await add(tab.path, undefined, tab.view); } catch (e) { report(`復元できませんでした: ${tab.path} (${e})`); recent = recent.filter(r => key(r.path) !== key(tab.path)); } }
    active = documents.find(d => key(d.path) === key(saved.active ?? ''))?.id ?? active;
  }
  await receiveTransfers(); await openPending(); await refreshWindows();
})().catch(report);
async function refreshWindows() { windows = await native.invoke<Snapshot['windows']>('list_windows'); emit(false); }
async function openPending() { const paths = await native.invoke<string[]>('pending_paths'); for (const path of paths) { if (settings.openMode === 'window' && documents.length) await native.invoke('create_window', { paths: [path] }); else await add(path); } emit(); }
function receiveTransfers() {
  receiveChain = receiveChain.catch(report).then(async () => {
    const items = await native.invoke<{ token: string; document: Omit<Internal, 'bytes'> }[]>('pending_transfers');
    for (const item of items) {
      if (received.has(item.token)) continue; received.add(item.token);
      let doc: Internal | undefined;
      try {
        const bytes = new Uint8Array(await native.invoke<ArrayBuffer>('read_transfer', { token: item.token }));
        doc = { ...item.document, bytes }; documents.push(doc); active = doc.id;
        if (!doc.temporary) await native.invoke('watch_pdf', { path: doc.path, docId: doc.id }).catch(e => { if (doc) doc.changed = true; report(e); });
        await persist(); await native.invoke('acknowledge_transfer', { token: item.token, accepted: true }); emit();
      } catch (e) {
        if (doc) { const index = documents.indexOf(doc); if (index >= 0) documents.splice(index, 1); active = documents.at(-1)?.id ?? null; await native.invoke('release_pdf', { docId: doc.id }).catch(report); }
        await native.invoke('acknowledge_transfer', { token: item.token, accepted: false }).catch(report); report(e);
      }
    }
  }); return receiveChain;
}
async function remove(id: string) { const at = documents.findIndex(d => d.id === id); if (at >= 0) documents.splice(at, 1); if (active === id) active = documents.at(-1)?.id ?? null; await native.invoke('release_pdf', { docId: id }); }
async function chooseDestination(name: string, prohibited: string[]) {
  const path = await native.invoke<string | null>('choose_destination', { name });
  if (path && prohibited.some(p => key(p) === key(path))) throw new Error('原本と開いているPDFを保持するため、別の保存先を指定してください。');
  return path;
}
const asciiJson = (value: unknown) => JSON.stringify(value).replace(/[\u007f-\uffff]/g, c => `\\u${c.charCodeAt(0).toString(16).padStart(4, '0')}`);
async function writePdf(path: string, bytes: Uint8Array) { await native.binary('write_pdf', bytes, { 'folio-path': asciiJson(path) }); }
async function prepareClose(doc: Internal) {
  if (moving.has(doc.id)) throw new Error('ウィンドウへの移動が完了してから閉じてください。');
  if (!doc.dirty) return true;
  const choice = await native.invoke<'save' | 'discard' | 'cancel'>('confirm_close', { name: doc.name });
  if (choice === 'discard') return true;
  if (choice !== 'save' || !await bridge.save(doc.id)) return false;
  return !documents.some(d => d.id === doc.id && d.dirty);
}
export const bridge: Bridge = {
  snapshot: async () => { await ready; return snapshot(); },
  onChange: fn => { listeners.add(fn); return () => { listeners.delete(fn); }; },
  onCloseRequest: fn => { closeListeners.add(fn); return () => { closeListeners.delete(fn); }; },
  open: async paths => {
    await ready;
    const files = paths ?? await native.invoke<string[]>('choose_files');
    const errors: string[] = [];
    for (const path of files) { try {
      const existing = documents.find(d => key(d.path) === key(path));
      if (existing) { active = existing.id; continue; }
      if (settings.openMode === 'window' && documents.length) {
        if (!await native.invoke('locate_pdf', { path })) await native.invoke('create_window', { paths: [path] });
      } else await add(path);
    } catch (e) { errors.push(`${nameOf(path)}: ${e}`); } }
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
    const version = doc.version;
    const bytes = new Uint8Array(await native.invoke<ArrayBuffer>('read_pdf', { path: doc.path }));
    const info = await pdfWork<Inspection>({ type: 'inspect', bytes });
    if (!documents.includes(doc)) return;
    if (doc.dirty || doc.version !== version) throw new Error('読み込み中に編集されました。現在の編集を保存してから開き直してください。');
    await remove(id); await add(doc.path, bytes, doc.view); const replacement = get(active!); replacement.temporary = false; Object.assign(replacement, info);
    await native.invoke('claim_pdf', { path: doc.path, docId: replacement.id }); await native.invoke('watch_pdf', { path: doc.path, docId: replacement.id }); emit();
  },
  initialize: async (id, count, rotations, restricted, printAllowed) => {
    const doc = get(id);
    if (!Number.isInteger(count) || count < 1 || rotations.length !== count) throw new Error('ページ情報が不正です。');
    if (!doc.pages.length) { doc.pages = rotations.map((rotation, source) => ({ id: `${id}:${source}`, source, rotation })); doc.initial = doc.pages; }
    doc.restricted = restricted || doc.unsupported; doc.printAllowed = printAllowed; emit();
  },
  edit: async (id, op) => {
    const doc = get(id); editable(doc);
    if (moving.has(id)) throw new Error('ウィンドウへ移動しています。');
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
    if (moving.has(id)) throw new Error('ウィンドウへ移動しています。');
    if (doc.complex && !await bridge.confirm('ページ構成を変更して保存すると、しおり・フォーム・注釈・内部リンク等を完全には保持できない場合があります。続けますか？')) return false;
    const pages = structuredClone(selected ? doc.pages.filter(p => selected.includes(p.id)) : doc.pages);
    if (!pages.length) throw new Error('保存するページを選択してください。');
    const path = await chooseDestination(doc.name.replace(/\.pdf$/i, selected ? '_抽出.pdf' : '_編集.pdf'), documents.filter(d => !d.temporary).map(d => d.path));
    if (!path) return false;
    const version = doc.version;
    const bytes = await pdfWork<Uint8Array>({ type: 'export', bytes: doc.bytes, pages });
    await writePdf(path, bytes);
    if (!selected && doc.version === version) await remove(id);
    await add(path); if (!selected && doc.version === version && active) replacements.set(id, active); emit(); return true;
  },
  close: async (id, discard = false) => {
    const doc = get(id);
    if (!discard && !await prepareClose(doc)) return false;
    await remove(replacements.get(id) ?? id); replacements.delete(id); emit(); return true;
  },
  closeWindow: async () => {
    await ready; if (closing) return; closing = true;
    try {
      for (const doc of [...documents]) if (!await prepareClose(doc)) return;
      clearTimeout(timer); await persist(); await native.close();
    } finally { closing = false; }
  },
  move: async (id, target) => {
    const doc = get(id); if (moving.has(id)) throw new Error('すでに移動中です。'); moving.add(id);
    let token: string | undefined;
    try {
      const { bytes, ...metadata } = doc;
      token = await native.invoke<string>('prepare_transfer', { metadata, target: target ?? null });
      if (await native.binary<boolean>('transfer_document', bytes, { 'folio-transfer': token })) { await remove(id); emit(); await persist(); }
      else throw new Error('移動先で文書を受け取れませんでした。元のタブを保持しています。');
    } finally { if (token) await native.invoke('cancel_transfer', { token }).catch(report); moving.delete(id); }
  },
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
      await writePdf(path, bytes); await add(path); emit();
    } finally { if (mergeController === controller) mergeController = undefined; }
  },
  cancelMerge: async () => { mergeController?.abort(); },
  settings: async value => { const result = await native.invoke<{ settings: Settings; recent: Recent[] }>('preferences', { value }); settings = result.settings; recent = result.recent; emit(); },
  clearHistory: async () => { await native.invoke('preferences', { value: { clearHistory: true } }); views = {}; emit(); },
  external: url => native.invoke('external', { url }),
  printBegin: async id => { const doc = get(id); if (!doc.printAllowed) throw new Error('このPDFの印刷は許可されていません。'); return native.invoke<string>('print_begin', { title: doc.name }); },
  printPage: (job, index, data, width, height) => native.binary('print_page', data, { 'folio-print': asciiJson({ job, index, width, height }) }),
  printEnd: job => native.invoke('print_end', { job }), printCancel: job => native.invoke('print_cancel', { job }),
  confirm: message => native.invoke<boolean>('confirm', { message }),
  minimize: () => { void native.minimize().catch(report); }, maximize: () => { void native.maximize().catch(report); },
  quit: () => { for (const fn of closeListeners) fn(); }
};
void native.onClose(() => bridge.quit()).catch(report);
window.folio = bridge;

