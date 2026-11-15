import test from 'node:test';
import assert from 'node:assert/strict';
import { parsePrintRange, formatPrintRange, previewScale, printScale } from '../src/print-selection.ts';

test('print ranges accept familiar ranges and Japanese full-width input', () => {
  assert.deepEqual(parsePrintRange('１−３、５', 5), [0, 1, 2, 4]);
  assert.deepEqual(parsePrintRange('5, 2-3, 2', 5), [1, 2, 4]);
  for (const value of ['', '0', '6', '3-1', '2,,3', '1-a']) assert.throws(() => parsePrintRange(value, 5));
});

test('thumbnail selection and range input round-trip in document order', () => {
  assert.equal(formatPrintRange([4, 0, 1, 2, 4, 7, 9, 8]), '1-3, 5, 8-10');
  assert.equal(formatPrintRange([]), '');
  for (const selection of [[0], [0, 2, 3], [1, 2, 4], [0, 1, 2, 3, 4]]) {
    assert.deepEqual(parsePrintRange(formatPrintRange(selection), 5), selection);
  }
});

test('preview pixel budget stays small while print rendering preserves resolution', () => {
  for (const [width, height] of [[595, 842], [2384, 3370], [10000, 20000], [20000, 1000]]) {
    const preview = previewScale(width, height), print = printScale(width, height);
    assert.ok(width * preview <= 220.001 && height * preview <= 280.001);
    assert.ok(width * print <= 8192.001 && height * print <= 8192.001);
    assert.ok(width * height * print * print <= 24_000_001);
    assert.ok(print >= preview);
  }
  assert.equal(printScale(595, 842), 150 / 72);
});
