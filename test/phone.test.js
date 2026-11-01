import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mergeEvents, toEvent } from '../phone/events.js';

const review = (time, id, rating) => ({ time, id, type: 'review', rating });

test('mergeEvents drops events seen twice and orders by time', () => {
  const a = review('2026-10-17T02:00:00.000Z', 'abcde', 'good');
  const b = review('2026-10-17T01:00:00.000Z', 'abcde', 'good');
  assert.deepEqual(mergeEvents([a, b], [{ ...a }]), [b, a]);
});

test('toEvent accepts reviews and markers and rejects the rest', () => {
  const now = new Date('2026-10-17T00:00:00.000Z');
  assert.deepEqual(toEvent({ id: 'abcde', type: 'review', rating: 'easy' }, now), review(now.toISOString(), 'abcde', 'easy'));
  assert.deepEqual(toEvent({ id: 'abcde', type: 'suspend' }, now), { time: now.toISOString(), id: 'abcde', type: 'suspend' });
  assert.deepEqual(toEvent({ id: 'abcde', type: 'review' }, now), { time: now.toISOString(), id: 'abcde', type: 'review' });
  assert.equal(toEvent({ id: 'abcde', type: 'practice' }, now), null);
  assert.equal(toEvent({ id: 'abcde', type: 'review', rating: 'meh' }, now), null);
  assert.equal(toEvent({ id: 'TOO-LONG', type: 'reset' }, now), null);
});
