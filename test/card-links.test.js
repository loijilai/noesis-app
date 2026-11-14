import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cardsLinkingTo, linkedIds } from '../public/card-links.js';

test('linkedIds finds each [[id]] once and skips code', () => {
  const text = [
    'See [[ab12c]] and [[x9k2m]], again [[ab12c]].',
    'Not a link: [[too-long-id]], [[AB12C]], [ab12c].',
    'Inline `[[zzzzz]]` stays code.',
    '```js',
    'const a = [[yyyyy]];',
    '```',
    'After the fence [[after]].',
  ].join('\n');
  assert.deepEqual(linkedIds(text), ['ab12c', 'x9k2m', 'after']);
});

test('cardsLinkingTo lists the other cards that link to an id', () => {
  const cards = [
    { id: 'aaaaa', raw: 'links to [[ccccc]]' },
    { id: 'bbbbb', raw: 'nothing here' },
    { id: 'ccccc', raw: 'links to itself [[ccccc]]' },
    { id: 'ddddd', raw: '`[[ccccc]]` in code only' },
  ];
  assert.deepEqual(cardsLinkingTo(cards, 'ccccc').map((c) => c.id), ['aaaaa']);
});
