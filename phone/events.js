const CARD_ID = /^[a-z0-9]{5}$/;
const RATINGS = new Set(['again', 'hard', 'good', 'easy']);
const MARKERS = new Set(['reset', 'suspend', 'unsuspend']);

export function toEvent(body, now) {
  if (typeof body?.id !== 'string' || !CARD_ID.test(body.id)) return null;
  if (MARKERS.has(body.type)) return { time: now.toISOString(), id: body.id, type: body.type };
  if (body.type === 'review' && body.rating === undefined) return { time: now.toISOString(), id: body.id, type: 'review' };
  if (body.type === 'review' && RATINGS.has(body.rating)) return { time: now.toISOString(), id: body.id, type: 'review', rating: body.rating };
  return null;
}

// A rating can be on GitHub and still waiting on the phone at once, so identity is its content.
export function eventKey(event) {
  return [event.time, event.id, event.type, event.rating ?? ''].join('|');
}

export function mergeEvents(...lists) {
  const merged = new Map();
  for (const event of lists.flat()) if (!merged.has(eventKey(event))) merged.set(eventKey(event), event);
  return [...merged.values()].sort((a, b) => Date.parse(a.time) - Date.parse(b.time));
}
