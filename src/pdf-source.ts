import { getDocument, GlobalWorkerOptions } from 'pdfjs-dist';
import workerUrl from 'pdfjs-dist/build/pdf.worker.min.mjs?url';

GlobalWorkerOptions.workerSrc = workerUrl;
const base = new URL('./pdf-assets/', location.href).href;

export function createPdfTask(bytes: Uint8Array) {
  return getDocument({ data: bytes, cMapUrl: `${base}cmaps/`, cMapPacked: true,
    standardFontDataUrl: `${base}standard_fonts/`, wasmUrl: `${base}wasm/`, enableXfa: false });
}
