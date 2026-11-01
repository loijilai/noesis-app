// Kept free of Node APIs: the phone version parses cards edited in the browser.
export function parseCard(raw) {
  const errors = [];
  const text = raw.replace(/\r\n?/g, '\n');

  const fm = text.match(/^---\n([\s\S]*?)\n---(?:\n|$)/);
  let created = null;
  let schedule = 'fsrs';
  let body = text;
  if (!fm) {
    errors.push('frontmatter 無法解析');
  } else {
    body = text.slice(fm[0].length);
    ({ created, schedule } = parseFrontmatter(fm[1], errors));
  }

  const { preamble, sections } = splitSections(body);
  if (preamble.trim()) errors.push('第一個 ## 段落之前有內容');

  const count = (name) => sections.filter((s) => s.name === name).length;
  const questions = count('Question');
  if (!questions) errors.push('必須有 Question');
  if (questions > 1) errors.push('Question 重複');
  const codes = count('Code');
  const answers = count('Answer');
  if (codes && answers) errors.push('Code 與 Answer 不能同時出現');
  if (!codes && !answers) errors.push('必須有 Code 或 Answer');
  if (answers > 1) errors.push('Answer 重複');
  const kind = codes && !answers ? 'code' : answers && !codes ? 'answer' : null;

  return { created, schedule, kind, sections, raw, errors };
}

// 'fsrs', 'none', or a number of days such as '30d'.
export function isSchedule(value) {
  return value === 'fsrs' || value === 'none' || /^[1-9]\d*d$/.test(value);
}

export function intervalDays(schedule) {
  return schedule.endsWith('d') ? Number(schedule.slice(0, -1)) : null;
}

// FSRS is the default, so choosing it removes the line instead of writing it.
export function withSchedule(raw, schedule) {
  const text = raw.replace(/\r\n?/g, '\n');
  const fm = text.match(/^---\n([\s\S]*?)\n---(?:\n|$)/);
  if (!fm) return raw;
  const lines = fm[1].split('\n').filter((line) => !/^schedule:/.test(line));
  if (schedule !== 'fsrs') lines.push(`schedule: ${schedule}`);
  return `---\n${lines.join('\n')}\n---\n${text.slice(fm[0].length)}`;
}

function parseFrontmatter(block, errors) {
  let created = null;
  let schedule = 'fsrs';
  for (const line of block.split('\n')) {
    if (!line.trim()) continue;
    const m = line.match(/^([A-Za-z_][\w-]*):\s*(.*)$/);
    if (!m) {
      errors.push('frontmatter 無法解析');
      return { created: null, schedule };
    }
    const value = m[2].replace(/^(['"])(.*)\1$/, '$2').trim();
    if (m[1] === 'created') created = value;
    if (m[1] === 'schedule') {
      if (isSchedule(value)) schedule = value;
      else errors.push(`schedule 不合法：${value}（只能是 fsrs、none，或像 30d 的天數）`);
    }
  }
  if (created === null) errors.push('frontmatter 缺少 created');
  else if (Number.isNaN(Date.parse(created))) errors.push(`created 不是合法的 ISO 8601 時間：${created}`);
  return { created, schedule };
}

// `## ` inside fenced code blocks is content, not a section heading.
function splitSections(body) {
  const sections = [];
  const preamble = [];
  let current = null;
  let fence = null;
  for (const line of body.split('\n')) {
    const f = line.match(/^\s*(`{3,}|~{3,})/);
    if (f) {
      if (!fence) fence = f[1];
      else if (f[1][0] === fence[0] && f[1].length >= fence.length && !line.trim().slice(f[1].length)) fence = null;
    }
    const h = !fence && !f && line.match(/^## +(.*?)\s*#*\s*$/);
    if (h) {
      current = { name: h[1], lines: [] };
      sections.push(current);
    } else {
      (current ? current.lines : preamble).push(line);
    }
  }
  return {
    preamble: preamble.join('\n'),
    sections: sections.map(({ name, lines }) => ({ name, body: lines.join('\n').trim() })),
  };
}
