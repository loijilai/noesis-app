// The rules for a new card, kept apart from the filesystem so the desktop and the phone add cards the same way.
import { parseCard } from './card-text.js';

const ID_CHARS = 'abcdefghijklmnopqrstuvwxyz0123456789';

export class CardError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

// Whatever frontmatter the draft has is replaced: a new card starts with only its creation time.
export function newCardText(raw, now = new Date()) {
  if (typeof raw !== 'string') throw new CardError(400, '缺少 raw');
  const body = raw.replace(/^---\r?\n[\s\S]*?\r?\n---(?:\r?\n|$)/, '').replace(/^\s*\n/, '');
  const content = `---\ncreated: ${now.toISOString()}\n---\n\n${body}`;
  requireValid(content);
  return content;
}

// `random(n)` returns an integer in [0, n).
export function newCardId(taken, random) {
  for (;;) {
    const id = Array.from({ length: 5 }, () => ID_CHARS[random(ID_CHARS.length)]).join('');
    if (!taken.has(id)) return id;
  }
}

// Checked before anything is written, so a bad neighbour leaves the deck untouched. Without `before` or `after` the card goes last.
// The whole shown order is returned, since cards the stored order leaves out would otherwise jump ahead of the new one.
export function placeNew(shown, { before, after }, group) {
  if (before !== undefined && after !== undefined) throw new CardError(400, 'before 和 after 只能指定一個');
  const neighbour = before ?? after;
  if (neighbour === undefined) return (id) => [...shown, id];
  const at = shown.indexOf(neighbour);
  if (at < 0) throw new CardError(404, `群組 ${group} 裡找不到卡片 ${neighbour}`);
  const cut = before === undefined ? at + 1 : at;
  return (id) => [...shown.slice(0, cut), id, ...shown.slice(cut)];
}

// The same rule for every writer, so a card that is saved can always be practiced.
export function requireValid(raw) {
  const { errors } = parseCard(raw);
  if (errors.length) throw new CardError(400, `卡片格式錯誤：${errors.join('；')}`);
}
