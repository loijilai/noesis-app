import { test } from 'node:test';
import assert from 'node:assert/strict';
import { leavesPage } from '../phone/backend.js';

const at = (hash) => `https://example.github.io/noesis/${hash}`;

test('moving within practice keeps changes on the phone', () => {
  assert.equal(leavesPage(at('#/g/g/practice/seq'), at('#/g/g/practice/todo/random')), false);
  assert.equal(leavesPage(at('#/g/g/practice/seq/aaaaa'), at('#/s/due-today/practice/seq')), false);
});

test('leaving practice, or any other page, sends the changes', () => {
  assert.equal(leavesPage(at('#/g/g/practice/seq'), at('#/')), true);
  assert.equal(leavesPage(at('#/g/g'), at('#/g/g/practice/seq')), true);
  assert.equal(leavesPage(at('#/g/g'), at('#/')), true);
});
