import test from 'node:test';
import assert from 'node:assert/strict';
import { parseRange, editPages, samePages } from '../src/core.ts';
const pages = Array.from({ length: 5 }, (_, source) => ({ id: `p${source}`, source, rotation: 0 }));
test('page ranges are sorted and deduplicated without silently repairing invalid input', () => {
  assert.deepEqual(parseRange('3-5, 1, 3', 5), [0, 2, 3, 4]);
  for (const invalid of ['', '0', '6', '3-1', '2,,3', '1-a', '2-6']) assert.throws(() => parseRange(invalid, 5));
});
test('multi-page moves retain relative order and respect insertion position', () => {
  assert.deepEqual(editPages(pages, { type: 'move', ids: ['p3', 'p1'], before: 'p0' }).map(p => p.source), [1, 3, 0, 2, 4]);
  assert.deepEqual(editPages(pages, { type: 'move', ids: ['p0', 'p1'], before: null }).map(p => p.source), [2, 3, 4, 0, 1]);
  assert.deepEqual(editPages(pages, { type: 'move', ids: ['p0'], before: 'p0' }), pages);
});
test('rotation is normalized, deletion never removes every page, original stays immutable', () => {
  const rotated = editPages(pages, { type: 'rotate', ids: ['p0'], delta: -90 });
  assert.equal(rotated[0].rotation, 270); assert.equal(pages[0].rotation, 0);
  assert.equal(samePages(rotated, pages), false);
  assert.throws(() => editPages(pages, { type: 'delete', ids: pages.map(p => p.id) }));
  assert.equal(editPages(pages, { type: 'delete', ids: ['p1'] }).length, 4);
});
