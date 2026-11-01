import { parseCard } from '../server/card-text.js';

// An edit made on the phone is { id, raw, base, time }, where base is the version of the snapshot text it was made from.
// It shows only while the snapshot still holds that text: once the deck is rebuilt, the edit is either in the snapshot or left for sync to settle.
export function editedCard(card, edit) {
  if (!edit || edit.base !== card.version) return card;
  return { ...card, ...parseCard(edit.raw), version: edit.time };
}

// The base is always the snapshot's version: an edit that still shows was made from it, and one that no longer shows is replaced.
export function newEdit(card, raw, now) {
  return { id: card.id, raw, base: card.version, time: now.toISOString() };
}

export function withImages(card, images) {
  const swap = (text) => Object.entries(images).reduce((t, [file, uri]) => t.replaceAll(file, uri), text);
  return { ...card, sections: card.sections.map((s) => ({ ...s, body: swap(s.body) })) };
}
