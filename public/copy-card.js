export function cardForChat(raw, mine) {
  const body = raw.replace(/\r\n?/g, '\n').replace(/^---\n[\s\S]*?\n---(?:\n|$)/, '').trim();
  return mine.trim() ? `${body}\n\n## 我的回答\n\n${mine.trim()}` : body;
}
