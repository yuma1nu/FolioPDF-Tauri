export type Theme = 'system' | 'light' | 'dark';
export type PageRef = { id: string; source: number; rotation: number };
export type View = { page: number; scale: string; left: number; top: number };
export type DocumentUI = { query: string; sensitive: boolean; selected: string[]; organize: boolean; panel: 'pages' | 'search' };
export type Doc = {
  id: string; path: string; name: string; pages: PageRef[]; dirty: boolean;
  encrypted: boolean; signed: boolean; restricted: boolean; complex: boolean; version: number;
  printAllowed: boolean;
  view: View; canUndo: boolean; canRedo: boolean; changed?: boolean;
  ui: DocumentUI;
};
export type Settings = { theme: Theme; openMode: 'tab' | 'window'; restore: boolean };
export type Recent = { path: string; name: string };
export type WindowInfo = { id: number; title: string };
export type Snapshot = { windowId: number; docs: Doc[]; active: string | null; settings: Settings; recent: Recent[]; windows: WindowInfo[] };
export type Edit = { type: 'rotate'; ids: string[]; delta: number } | { type: 'delete'; ids: string[] } | { type: 'move'; ids: string[]; before: string | null } | { type: 'undo' } | { type: 'redo' };
export interface Bridge {
  snapshot(): Promise<Snapshot>;
  onChange(fn: (state: Snapshot) => void): () => void;
  onCloseRequest(fn: () => void): () => void;
  open(paths?: string[]): Promise<void>;
  dropped(files: File[]): Promise<void>;
  read(id: string): Promise<Uint8Array>;
  reload(id: string): Promise<void>;
  initialize(id: string, count: number, rotations: number[], restricted: boolean, printAllowed: boolean): Promise<void>;
  edit(id: string, operation: Edit): Promise<void>;
  activate(id: string): Promise<void>;
  view(id: string, view: View): Promise<void>;
  ui(id: string, ui: DocumentUI): Promise<void>;
  save(id: string, selected?: string[]): Promise<boolean>;
  close(id: string, discard?: boolean): Promise<boolean>;
  closeWindow(): Promise<void>;
  move(id: string, target?: number): Promise<void>;
  merge(paths?: string[]): Promise<void>;
  chooseMerge(): Promise<{ path: string; name: string; count: number }[]>;
  cancelMerge(): Promise<void>;
  settings(value: Partial<Settings>): Promise<void>;
  clearHistory(): Promise<void>;
  external(url: string): Promise<void>;
  printBegin(id: string): Promise<string>;
  printPage(job: string, index: number, data: Uint8Array, width: number, height: number): Promise<void>;
  printEnd(job: string): Promise<string>;
  printCancel(job: string): Promise<void>;
  confirm(message: string): Promise<boolean>;
  minimize(): void;
  maximize(): void;
  quit(): void;
}
declare global { interface Window { folio: Bridge } }
