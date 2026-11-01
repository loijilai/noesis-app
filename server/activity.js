import { DAY_START_HOUR, isReview } from './schedule.js';

// Keyed by local calendar date, where a day runs from 4am to 4am like the schedule's.
// Cards deleted since still count: the record is of practice done, not of the deck as it is now.
export function dailyPractice(events) {
  const days = {};
  for (const event of events) {
    if (!isReview(event)) continue;
    const day = practiceDate(new Date(event.time));
    days[day] = (days[day] ?? 0) + 1;
  }
  return days;
}

function practiceDate(time) {
  const d = new Date(time);
  if (d.getHours() < DAY_START_HOUR) d.setDate(d.getDate() - 1);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}
