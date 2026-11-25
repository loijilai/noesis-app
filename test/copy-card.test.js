import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cardForChat } from '../public/copy-card.js';

const raw = '---\ncreated: 2026-01-01T00:00:00Z\nschedule: 30d\n---\n## Question\n\nWhy?\n\n## Answer\n\nBecause.\n\n## Notes\n\n';

test('cardForChat drops the frontmatter and trailing blank lines', () => {
  assert.equal(cardForChat(raw, ''), '## Question\n\nWhy?\n\n## Answer\n\nBecause.\n\n## Notes');
});

test('cardForChat appends what was typed in the answer box', () => {
  assert.equal(cardForChat(raw, '  I think so.\n'), '## Question\n\nWhy?\n\n## Answer\n\nBecause.\n\n## Notes\n\n## 我的回答\n\nI think so.');
});

test('cardForChat handles Windows line endings', () => {
  assert.equal(cardForChat(raw.replace(/\n/g, '\r\n'), ''), '## Question\n\nWhy?\n\n## Answer\n\nBecause.\n\n## Notes');
});
