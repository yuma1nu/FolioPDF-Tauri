import { parseRange } from './core.ts';

export function parsePrintRange(input: string, count: number): number[] {
  const normalized = input.normalize('NFKC').replace(/[、，]/g, ',').replace(/[‐‑–—−〜～]/g, '-');
  return parseRange(normalized, count);
}

export function formatPrintRange(indices: Iterable<number>): string {
  const pages = [...new Set(indices)].sort((a, b) => a - b);
  const parts: string[] = [];
  for (let i = 0; i < pages.length; i++) {
    const start = pages[i];
    while (i + 1 < pages.length && pages[i + 1] === pages[i] + 1) i++;
    parts.push(start === pages[i] ? `${start + 1}` : `${start + 1}-${pages[i] + 1}`);
  }
  return parts.join(', ');
}

export function previewScale(width: number, height: number): number {
  return Math.min(220 / width, 280 / height, 1);
}

export function printScale(width: number, height: number): number {
  return Math.min(150 / 72, 8192 / width, 8192 / height, Math.sqrt(24_000_000 / (width * height)));
}
