import type { PageRef } from './shared';
export type PdfTask = { type: 'inspect'; bytes: Uint8Array } | { type: 'export'; bytes: Uint8Array; pages: PageRef[] } | { type: 'merge'; sources: Uint8Array[] };
export type Inspection = { encrypted: boolean; signed: boolean; complex: boolean; unsupported: boolean };
export function pdfWork<T>(task: PdfTask, signal?: AbortSignal): Promise<T> {
  return new Promise((resolve, reject) => {
    const worker = new Worker(new URL('./pdf-worker.ts', import.meta.url), { type: 'module' });
    const done = () => { worker.terminate(); signal?.removeEventListener('abort', abort); };
    const abort = () => { done(); reject(new Error('処理をキャンセルしました。')); };
    if (signal?.aborted) { abort(); return; }
    signal?.addEventListener('abort', abort, { once: true });
    worker.onmessage = ({ data }) => { done(); if (data.error) reject(new Error(data.error)); else resolve(data.result); };
    worker.onerror = event => { done(); reject(new Error(event.message)); };
    worker.postMessage(task);
  });
}
