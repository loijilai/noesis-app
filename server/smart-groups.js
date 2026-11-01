import { cardSchedules } from './schedule.js';

// `events` must already be merged across devices and sorted by time.
export function smartGroups(deck, events, now) {
  const active = cardSchedules(deck, events, now).filter((s) => !s.suspended);
  return [
    { key: 'due-today', name: '今天到期', ids: dueTodayIds(active) },
    { key: 'unpracticed', name: '還沒練過', ids: active.filter((s) => s.status === 'new').map((s) => s.id) },
  ];
}

function dueTodayIds(active) {
  return active
    .filter((s) => s.status === 'scheduled' && s.dueInDays <= 0)
    .sort((a, b) => (a.retrievability ?? 0) - (b.retrievability ?? 0) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
    .map((s) => s.id);
}
