export function cardForChat(raw) {
  return raw.replace(/\r\n?/g, '\n').replace(/^---\n[\s\S]*?\n---(?:\n|$)/, '').trim();
}
