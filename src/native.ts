import { invoke } from '@tauri-apps/api/core';
import { getCurrentWindow } from '@tauri-apps/api/window';
export const native = {
  invoke,
  close: () => getCurrentWindow().destroy(),
  minimize: () => getCurrentWindow().minimize(),
  maximize: () => getCurrentWindow().toggleMaximize(),
  drag: () => getCurrentWindow().startDragging(),
  onClose: (fn: () => void) => getCurrentWindow().onCloseRequested(event => { event.preventDefault(); fn(); })
};
