import { invoke } from '@tauri-apps/api/core';
import { getCurrentWindow } from '@tauri-apps/api/window';
export const native = {
  invoke,
  binary: <T>(command: string, data: Uint8Array, headers: Record<string, string> = {}) => invoke<T>(command, data, { headers }),
  listen: <T>(event: string, fn: (payload: T) => void) => getCurrentWindow().listen<T>(event, e => fn(e.payload)),
  onDrop: (fn: (active: boolean) => void) => getCurrentWindow().onDragDropEvent(e => fn(e.payload.type === 'enter' || e.payload.type === 'over')),
  onBounds: async (fn: () => void) => { const stop = await Promise.all([getCurrentWindow().onResized(fn), getCurrentWindow().onMoved(fn)]); return () => stop.forEach(fn => fn()); },
  close: () => getCurrentWindow().destroy(),
  minimize: () => getCurrentWindow().minimize(),
  maximize: () => getCurrentWindow().toggleMaximize(),
  drag: () => getCurrentWindow().startDragging(),
  onClose: (fn: () => void) => getCurrentWindow().onCloseRequested(event => { event.preventDefault(); fn(); })
};
