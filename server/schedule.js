import { fsrs, createEmptyCard, Rating } from 'ts-fsrs';
import { intervalDays } from './card-text.js';

const scheduler = fsrs({ enable_short_term: false });
const GRADES = new Map([['again', Rating.Again], ['hard', Rating.Hard], ['good', Rating.Good], ['easy', Rating.Easy]]);
export const DAY_START_HOUR = 4;
const DAY_MS = 24 * 60 * 60 * 1000;

// A review without a rating means the card was seen but not graded.
export function isReview(event) {
  return event.type === 'review' && (event.rating === undefined || GRADES.has(event.rating));
}

// `events` must already be merged across devices and sorted by time.
// Every schedule reads the same reviews, so changing a card's schedule keeps its progress.
export function cardSchedules(deck, events, now) {
  const memories = memoryStates(events);
  const suspended = suspendedIds(events);
  const lastReviews = lastEvents(events, isReview);
  const cards = new Map(deck.cards.filter((c) => !c.errors.length).map((c) => [c.id, c]));
  return deck.groups.flatMap((g) => g.order).filter((id) => cards.has(id)).map((id) => {
    const { schedule } = cards.get(id);
    const last = lastReviews.get(id);
    const days = intervalDays(schedule);
    const result = schedule === 'fsrs' ? fsrsScheduleOf(id, memories.get(id), now)
      : days ? intervalScheduleOf(id, last, days, now)
      : unscheduledOf(id, last);
    return { ...result, suspended: suspended.has(id), lastReview: lastReviewOf(last, now) };
  });
}

// Suspension is independent of reset: a reset neither clears it nor is cleared by it.
export function suspendedIds(events) {
  const suspended = new Set();
  for (const event of events) {
    if (event.type === 'suspend') suspended.add(event.id);
    else if (event.type === 'unsuspend') suspended.delete(event.id);
  }
  return suspended;
}

// Nothing is cached: the FSRS state is always replayed from the log.
function memoryStates(events) {
  const cards = new Map();
  for (const event of events) {
    if (event.type === 'reset') cards.delete(event.id);
    if (event.type !== 'review' || !GRADES.has(event.rating)) continue;
    const time = new Date(event.time);
    cards.set(event.id, scheduler.next(cards.get(event.id) ?? createEmptyCard(time), time, GRADES.get(event.rating)).card);
  }
  return cards;
}

function lastEvents(events, matches) {
  const last = new Map();
  for (const event of events) {
    if (event.type === 'reset') last.delete(event.id);
    if (matches(event)) last.set(event.id, event);
  }
  return last;
}

function lastReviewOf(event, now) {
  if (!event) return null;
  return { time: event.time, rating: event.rating, daysAgo: dayNumber(now) - dayNumber(new Date(event.time)) };
}

function unscheduledOf(id, last) {
  return { id, status: last ? 'practiced' : 'new', due: null, dueInDays: null, retrievability: null, preview: null };
}

// Counted from the last time the card was seen, whatever it was rated.
function intervalScheduleOf(id, last, days, now) {
  if (!last) return { id, status: 'new', due: null, dueInDays: null, retrievability: null, preview: { seen: days } };
  const due = new Date(Date.parse(last.time) + days * DAY_MS);
  return { id, status: 'scheduled', due: due.toISOString(), dueInDays: dayNumber(due) - dayNumber(now), retrievability: null, preview: { seen: days } };
}

function fsrsScheduleOf(id, card, now) {
  if (!card) return { id, status: 'new', due: null, dueInDays: null, retrievability: null, preview: previewOf(createEmptyCard(now), now) };
  return {
    id,
    status: 'scheduled',
    due: card.due.toISOString(),
    dueInDays: dayNumber(card.due) - dayNumber(now),
    retrievability: scheduler.get_retrievability(card, now, false),
    preview: previewOf(card, now),
  };
}

function previewOf(card, now) {
  const outcomes = scheduler.repeat(card, now);
  return Object.fromEntries([...GRADES].map(([name, grade]) => [name, Math.round((outcomes[grade].card.due - now) / DAY_MS)]));
}

// Local calendar day, where a day runs from 4am to 4am, so late-night practice still counts as the same day.
function dayNumber(date) {
  const shift = date.getHours() < DAY_START_HOUR ? 1 : 0;
  return Math.round(Date.UTC(date.getFullYear(), date.getMonth(), date.getDate() - shift) / DAY_MS);
}
