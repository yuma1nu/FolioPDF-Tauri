import type { PageRef, Edit } from './shared.ts';
export function parseRange(input: string, count: number): number[] {
  if (!input.trim()) throw new Error('ページを指定してください。例：1-3, 5, 8-10');
  const result = new Set<number>();
  for (const part of input.split(',')) {
    const match = /^\s*(\d+)\s*(?:-\s*(\d+)\s*)?$/.exec(part);
    if (!match) throw new Error(`「${part}」は有効な指定ではありません。`);
    const start = Number(match[1]), end = Number(match[2] ?? start);
    if (start < 1 || end > count || start > end) throw new Error(`1〜${count}ページの範囲を昇順で指定してください。`);
    for (let n = start; n <= end; n++) result.add(n - 1);
  }
  return [...result].sort((a, b) => a - b);
}
export function editPages(pages: PageRef[], op: Edit): PageRef[] {
  if (op.type === 'undo' || op.type === 'redo') return pages;
  const ids = new Set(op.ids);
  if (op.type === 'rotate') return pages.map(p => ids.has(p.id) ? { ...p, rotation: ((p.rotation + op.delta) % 360 + 360) % 360 } : p);
  if (op.type === 'delete') {
    const next = pages.filter(p => !ids.has(p.id));
    if (!next.length) throw new Error('すべてのページは削除できません。1ページ以上残してください。');
    return next;
  }
  if (op.before && ids.has(op.before)) return pages;
  const moving = pages.filter(p => ids.has(p.id));
  const remaining = pages.filter(p => !ids.has(p.id));
  const at = op.before ? remaining.findIndex(p => p.id === op.before) : remaining.length;
  if (at < 0) throw new Error('移動先のページが見つかりません。');
  return [...remaining.slice(0, at), ...moving, ...remaining.slice(at)];
}
export function samePages(a: PageRef[], b: PageRef[]) { return a.length === b.length && a.every((p, i) => p.id === b[i].id && p.rotation === b[i].rotation); }
