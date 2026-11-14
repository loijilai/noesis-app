// Kept free of Node APIs: the page, the phone version and the deck command all read links with it.
// A link is [[id]] with a card's 5-character id; anything inside code is left as written.
export const CARD_LINK = /\[\[([a-z0-9]{5})\]\]/;

export function linkedIds(markdown) {
  const ids = new Set();
  for (const line of proseLines(markdown)) {
    for (const m of line.replace(/(`+)[^`]*?\1/g, '').matchAll(new RegExp(CARD_LINK, 'g'))) ids.add(m[1]);
  }
  return [...ids];
}

export function cardsLinkingTo(cards, id) {
  return cards.filter((c) => c.id !== id && linkedIds(c.raw).includes(id));
}

function* proseLines(markdown) {
  let fence = null;
  for (const line of markdown.replace(/\r\n?/g, '\n').split('\n')) {
    const f = line.match(/^\s*(`{3,}|~{3,})/);
    if (f) {
      if (!fence) fence = f[1];
      else if (f[1][0] === fence[0] && f[1].length >= fence.length && !line.trim().slice(f[1].length)) fence = null;
      continue;
    }
    if (!fence) yield line;
  }
}
