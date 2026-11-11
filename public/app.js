import { marked } from 'https://cdnjs.cloudflare.com/ajax/libs/marked/18.0.14/lib/marked.esm.min.js';
import hljs from 'https://cdnjs.cloudflare.com/ajax/libs/highlight.js/11.11.1/es/highlight.min.js';
import { diff } from './diff.js';

const app = document.getElementById('app');
const KNOWN_SECTIONS = new Set(['Question', 'Code', 'Answer']);
const RATINGS = [['again', 'Again'], ['hard', 'Hard'], ['good', 'Good'], ['easy', 'Easy']];
const SEEN = [['seen', '看過']];
const RATING_LABELS = new Map([...RATINGS, ...SEEN]);
const SCHEDULES = ['fsrs', '7d', '30d', '90d', 'none'];
const SMART_ROUND_SIZE = 20;
let session = null;
// Only the phone keeps changes to send later; without that the sync controls stay hidden.
let syncStatus = null;

async function fetchDeck() {
  const [res, smartGroups, schedule, activity] = await Promise.all([fetch('/api/deck'), fetchSmartGroups(), fetchSchedule(), fetchActivity()]);
  if (!res.ok) throw new Error(`讀取題庫失敗（${res.status}）`);
  const deck = await res.json();
  if (deck.canSync) syncStatus = await api('GET', '/api/sync');
  return { ...deck, smartGroups, schedule, activity };
}

async function fetchActivity() {
  const res = await fetch('/api/activity');
  if (!res.ok) throw new Error(`讀取練習紀錄失敗（${res.status}）`);
  return new Map(Object.entries((await res.json()).days));
}

async function fetchSchedule() {
  const res = await fetch('/api/schedule');
  if (!res.ok) throw new Error(`讀取排程失敗（${res.status}）`);
  return new Map((await res.json()).cards.map((c) => [c.id, c]));
}

function dueLabel(schedule) {
  if (!schedule) return null;
  if (schedule.suspended) return '已封存';
  if (schedule.status === 'new') return '還沒練過';
  if (schedule.status === 'practiced') return '練過';
  if (schedule.dueInDays > 0) return `${schedule.dueInDays} 天後`;
  if (schedule.dueInDays === 0) return '今天';
  return `已過期 ${-schedule.dueInDays} 天`;
}

async function fetchSmartGroups() {
  const res = await fetch('/api/smart-groups');
  if (!res.ok) throw new Error(`讀取自動群組失敗（${res.status}）`);
  return (await res.json()).groups;
}

async function api(method, url, body) {
  const res = await fetch(url, {
    method,
    headers: { 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  if (!res.ok) {
    const { error } = await res.json().catch(() => ({}));
    throw Object.assign(new Error(error ?? `請求失敗（${res.status}）`), { status: res.status });
  }
  return res.status === 204 ? null : res.json();
}

const TEMPLATES = {
  answer: '## Question\n\n\n\n## Answer\n\n\n\n## Notes\n\n',
  code: '## Question\n\n\n\n## Code\n\n```cpp\n\n```\n\n## Notes\n\n',
};

function kindItems(onselect) {
  return [['answer', '概念題'], ['code', '程式題']].map(([kind, label]) => ({ label, onselect: () => onselect(kind) }));
}

function insertSpacesOnTab(e) {
  if (e.key !== 'Tab') return;
  e.preventDefault();
  e.target.setRangeText('    ', e.target.selectionStart, e.target.selectionEnd, 'end');
}

function editor(raw, save, cancel) {
  const text = h('textarea', { class: 'editor', spellcheck: 'false', onkeydown: insertSpacesOnTab });
  text.value = raw;
  const message = h('p', { class: 'errors' });
  const saveButton = h('button', {
    type: 'button',
    class: 'primary',
    onclick: async () => {
      saveButton.disabled = true;
      message.textContent = '';
      try {
        await save(text.value);
      } catch (err) {
        message.textContent = err.status === 409
          ? '存檔失敗：這張卡在你編輯期間已被修改。你的內容仍保留在上方，請先複製，取消後重新編輯。'
          : `存檔失敗：${err.message}`;
        saveButton.disabled = false;
      }
    },
  }, '存檔');
  queueMicrotask(() => text.focus());
  return h('div', { class: 'edit' },
    text,
    message,
    h('p', { class: 'actions' }, saveButton, h('button', { type: 'button', onclick: cancel }, '取消')));
}

function h(tag, attrs = {}, ...children) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (typeof v === 'function') el.addEventListener(k.replace(/^on/, ''), v);
    else if (v === true) el.setAttribute(k, '');
    else if (v != null && v !== false) el.setAttribute(k, v);
  }
  el.append(...children.flat().filter((c) => c != null));
  return el;
}

// Every crumb but the last is a link back up.
function breadcrumb(...trail) {
  const crumbs = [['題庫', '#/'], ...trail];
  return h('nav', { class: 'breadcrumb' }, crumbs.flatMap(([label, href], i) => {
    const last = i === crumbs.length - 1;
    const crumb = last ? h('span', { 'aria-current': 'page' }, label) : h('a', { href }, label);
    return i ? [h('span', { class: 'sep' }, '/'), crumb] : [crumb];
  }), syncChip(), themeToggle());
}

function syncChip() {
  if (!syncStatus) return null;
  const chip = h('button', { type: 'button', class: 'sync-chip' });
  chip.addEventListener('click', () => {
    if (syncStatus.conflicts) location.hash = '#/conflicts';
    else api('POST', '/api/sync').catch(() => {});
  });
  paintSyncChip(chip);
  return chip;
}

function paintSyncChip(chip) {
  const s = syncStatus;
  const [kind, label] = s.conflicts ? ['conflict', `⚠ ${s.conflicts} 張卡衝突`]
    : s.syncing ? ['busy', '同步中…']
    : s.error ? ['busy', '同步失敗，點一下重試']
    : s.pending ? ['busy', `${s.pending} 筆待同步`]
    : ['', '✓ 已同步'];
  chip.className = `sync-chip ${kind}`.trim();
  chip.title = s.error ?? (s.conflicts ? '點一下處理衝突' : '點一下立刻同步');
  chip.textContent = label;
}

addEventListener('noesis-sync', (e) => {
  syncStatus = e.detail;
  for (const chip of document.querySelectorAll('.sync-chip')) paintSyncChip(chip);
});

// index.html picks the starting theme; a choice made here is remembered on this device.
function themeToggle() {
  const root = document.documentElement;
  const button = h('button', { type: 'button', class: 'theme-toggle' });
  const paint = () => {
    const dark = root.dataset.noesisTheme === 'dark';
    button.title = dark ? '切換成淺色' : '切換成深色';
    button.setAttribute('aria-label', button.title);
    button.replaceChildren(icon(dark ? SUN : MOON));
  };
  button.addEventListener('click', () => {
    root.dataset.noesisTheme = root.dataset.noesisTheme === 'dark' ? 'light' : 'dark';
    try { localStorage.setItem('noesis-theme', root.dataset.noesisTheme); } catch {}
    paint();
  });
  paint();
  return button;
}

function errorList(errors) {
  return errors.length ? h('ul', { class: 'errors' }, errors.map((e) => h('li', {}, e))) : null;
}

function frontOf(card) {
  return card.sections.find((s) => s.name === 'Question')?.body ?? '';
}

const cardKind = (card) => card.kind === 'code' ? 'Code' : 'Question';

function scheduleLabel(schedule) {
  if (schedule === 'fsrs') return '記憶（FSRS）';
  if (schedule === 'none') return '不排程';
  return `每 ${schedule.slice(0, -1)} 天`;
}

function questionPreview(card) {
  const q = frontOf(card);
  const line = q.split('\n').find((l) => l.trim() && !l.startsWith('```')) ?? '';
  return line.length > 80 ? `${line.slice(0, 80)}…` : line;
}

// Kept for the whole visit, so coming back from a card finds the page still searched.
const searches = new Map();

// `apply` gets the trimmed query, or '' to show everything.
function searchBox(key, placeholder, apply) {
  const input = h('input', { type: 'search', placeholder, 'aria-label': placeholder, enterkeyhint: 'search' });
  const set = (value) => {
    input.value = value;
    searches.set(key, value);
    clear.hidden = !value;
    apply(value.trim());
  };
  const clear = h('button', {
    type: 'button',
    class: 'search-clear',
    title: '清除搜尋',
    'aria-label': '清除搜尋',
    onclick: () => {
      set('');
      input.focus();
    },
  }, '✕');
  input.addEventListener('input', () => set(input.value));
  input.addEventListener('keydown', (e) => {
    if (e.key !== 'Escape' || !input.value) return;
    e.preventDefault();
    set('');
  });
  set(searches.get(key) ?? '');
  return h('div', { class: 'search', 'data-key': key }, input, clear);
}

function searchTerms(query) {
  return query.toLowerCase().split(/\s+/).filter(Boolean);
}

// A term that starts with a letter or digit only matches at the start of a word, so os finds OS but not postorder.
function findTerm(lower, term, from = 0) {
  const wordy = /^[a-z0-9]/.test(term);
  for (let at = lower.indexOf(term, from); at >= 0; at = lower.indexOf(term, at + 1)) {
    if (!wordy || !at || !/[a-z0-9]/.test(lower[at - 1])) return at;
  }
  return -1;
}

function highlight(text, terms) {
  const lower = text.toLowerCase();
  const marked = Array(text.length).fill(false);
  for (const t of terms) for (let at = findTerm(lower, t); at >= 0; at = findTerm(lower, t, at + 1)) marked.fill(true, at, at + t.length);
  const parts = [];
  for (let i = 0, j; i < text.length; i = j) {
    for (j = i; j < text.length && marked[j] === marked[i]; j++);
    parts.push(marked[i] ? h('mark', {}, text.slice(i, j)) : text.slice(i, j));
  }
  return parts.length ? parts : [text];
}

// Code is left as written; elsewhere the markdown syntax goes, so a match can span a **bold** edge.
function plainText(markdown) {
  return markdown.split(/^```.*$/m).map((part, i) => i % 2 ? part : part
    .replace(/!\[[^\]]*\]\([^)]*\)/g, '')
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/^[\s|:-]+$/gm, '')
    .replace(/^\s*(#+|>)\s*/gm, '')
    .replace(/\*\*|`/g, '')
    .replace(/\|/g, ' ')).join(' ').replace(/\s+/g, ' ').trim();
}

const SECTION_LABELS = new Map([['Question', '題目'], ['Prompt', '題目'], ['Code', '答案'], ['Answer', '答案'], ['Notes', '筆記']]);

// Every term must turn up somewhere. Terms the row already shows are marked in place; the first that is not comes back as the stretch of text around it.
function cardMatch(card, terms) {
  const shown = `${card.id}\n${questionPreview(card)}`.toLowerCase();
  let sections;
  let snippet = null;
  for (const t of terms) {
    if (findTerm(shown, t) >= 0) continue;
    sections ??= card.sections.map((s) => {
      const text = plainText(s.body);
      return { label: SECTION_LABELS.get(s.name) ?? s.name, text, lower: text.toLowerCase() };
    });
    const s = sections.find((s) => findTerm(s.lower, t) >= 0);
    if (!s) return null;
    snippet ??= { label: s.label, text: s.text, at: findTerm(s.lower, t), length: t.length };
  }
  return { snippet };
}

function paintCardMatch(li, card, terms, match) {
  const preview = questionPreview(card);
  li.querySelector('.row-main .id').replaceChildren(...highlight(card.id, terms));
  const text = li.querySelector('.row-text');
  if (!match?.snippet) return text.replaceChildren(...highlight(preview, terms));
  const { label, text: body, at, length } = match.snippet;
  const start = Math.max(0, at - 12);
  const stretch = body.slice(start, at + length + 120);
  text.replaceChildren(
    h('span', { class: 'row-line' }, ...highlight(preview, terms)),
    h('span', { class: 'row-snippet' }, `${label}：${start ? '…' : ''}`, ...highlight(stretch, terms)));
}

const CARD_RESULT_LIMIT = 100;

const SCHEDULE_KINDS = [['fsrs', 'FSRS'], ['fixed', '固定天數'], ['none', '不排程']];
const scheduleKind = (schedule) => schedule === 'fsrs' || schedule === 'none' ? schedule : 'fixed';

// Kept for the whole visit, like the searches.
const filters = { schedule: new Set() };

// The panel stays open while options are toggled; it closes like a menu, on a click outside or Esc.
function filterMenu(onchange) {
  const options = SCHEDULE_KINDS.map(([kind, name]) => h('button', {
    type: 'button',
    class: 'filter-option',
    'aria-pressed': String(filters.schedule.has(kind)),
    onclick: () => {
      if (!filters.schedule.delete(kind)) filters.schedule.add(kind);
      update();
    },
  }, name));
  const panel = h('div', { class: 'menu filter-panel', hidden: true },
    h('p', { class: 'filter-label' }, '排程'),
    h('div', { class: 'filter-options' }, options));
  const trigger = h('button', {
    type: 'button',
    class: 'menu-trigger filter-trigger',
    title: '篩選',
    'aria-label': '篩選',
    'aria-haspopup': 'true',
    'aria-expanded': 'false',
    onclick: () => {
      if (openMenu?.panel === panel) return closeMenu();
      closeMenu();
      showPanel(panel);
      trigger.setAttribute('aria-expanded', 'true');
      openMenu = { wrap, panel, trigger };
    },
  }, icon(FUNNEL), h('span', { class: 'filter-dot' }));
  const wrap = h('div', { class: 'menu-wrap filter' }, trigger, panel);
  function update() {
    SCHEDULE_KINDS.forEach(([kind], i) => options[i].setAttribute('aria-pressed', String(filters.schedule.has(kind))));
    trigger.classList.toggle('active', !!filters.schedule.size);
    onchange();
  }
  trigger.classList.toggle('active', !!filters.schedule.size);
  return wrap;
}

function renderHome(deck) {
  const formSlot = h('div', { class: 'form-slot' });
  const groups = deck.groups.length ? groupList(deck) : h('p', { class: 'empty' }, '題庫還沒有任何群組');
  const noMatch = h('p', { class: 'empty', hidden: true });
  const groupsHead = h('p', { class: 'results-head', hidden: true });
  const cardsHead = h('p', { class: 'results-head', hidden: true });
  const cardResults = h('ul', { class: 'rows', hidden: true });
  const more = h('p', { class: 'results-more', hidden: true });
  const title = h('h2', {}, '群組');
  const update = (query) => {
    const terms = searchTerms(query);
    const kinds = filters.schedule;
    const searching = !!terms.length || !!kinds.size;
    const [head, rows] = groups.children;
    const names = new Map(deck.groups.map((g) => [g.slug, g.name]));
    let shown = 0;
    for (const li of rows.children) {
      const name = names.get(li.dataset.id);
      if (name == null || li.classList.contains('editing')) continue;
      li.hidden = !!kinds.size || !terms.every((t) => findTerm(name.toLowerCase(), t) >= 0);
      if (!li.hidden) shown++;
      li.querySelector('.row-text').replaceChildren(...highlight(name, terms));
    }
    rows.classList.toggle('filtering', searching);
    title.hidden = searching;
    head.hidden = !shown || searching;
    groupsHead.hidden = !shown || !searching;
    groupsHead.textContent = `群組 ${shown} 個`;

    const matches = [];
    if (searching) {
      const byId = new Map(deck.cards.map((c) => [c.id, c]));
      for (const g of deck.groups) for (const id of g.order) {
        const card = byId.get(id);
        if (!card || (kinds.size && !kinds.has(scheduleKind(card.schedule)))) continue;
        const match = cardMatch(card, terms);
        if (match) matches.push([card, match]);
      }
    }
    cardResults.replaceChildren(...matches.slice(0, CARD_RESULT_LIMIT).map(([card, match]) => {
      const li = cardRow(deck, card, {
        href: `#/g/${encodeURIComponent(card.group)}/practice/seq/${encodeURIComponent(card.id)}`,
        extra: h('span', { class: 'row-group' }, names.get(card.group) ?? card.group),
        scheduleText: true,
      });
      paintCardMatch(li, card, terms, match);
      return li;
    }));
    cardResults.hidden = !matches.length;
    cardsHead.hidden = !matches.length;
    cardsHead.textContent = `卡片 ${matches.length} 張`;
    more.hidden = matches.length <= CARD_RESULT_LIMIT;
    more.textContent = `還有 ${matches.length - CARD_RESULT_LIMIT} 張，再多打幾個字縮小範圍`;

    noMatch.hidden = !searching || !!shown || !!matches.length;
    noMatch.textContent = !terms.length ? '沒有符合篩選條件的卡片'
      : kinds.size ? `篩選條件下找不到符合「${query}」的卡片`
      : `找不到符合「${query}」的群組或卡片`;
  };
  const search = deck.groups.length ? searchBox('home', '搜尋群組或卡片', update) : null;
  const filter = deck.groups.length ? filterMenu(() => update((searches.get('home') ?? '').trim())) : null;
  return [
    breadcrumb(),
    h('h1', {}, '題庫'),
    errorList(deck.errors),
    dueHero(deck.smartGroups),
    practiceGraph(deck.activity),
    deckStats(deck),
    h('div', { class: 'section-head' },
      title,
      search,
      filter,
      deck.readOnly ? null : h('button', {
        type: 'button',
        class: 'soft small',
        onclick: () => {
          if (!formSlot.firstChild) formSlot.replaceChildren(groupForm({ name: '', slug: '' }, '建立', (data) => api('POST', '/api/groups', data), () => formSlot.replaceChildren()));
        },
      }, '新增群組')),
    formSlot,
    groupsHead,
    groups,
    cardsHead,
    cardResults,
    more,
    noMatch,
  ];
}

function dueHero(smartGroups) {
  const due = smartGroups.find((g) => g.key === 'due-today').ids.length;
  const unpracticed = smartGroups.find((g) => g.key === 'unpracticed').ids.length;
  return h('section', { class: 'card-featured due-hero' },
    h('div', { class: 'due-main' },
      h('p', { class: 'due-title' }, due ? `今天到期 ${due} 張` : '今天沒有到期的卡'),
      due ? h('a', { class: 'button primary', href: '#/s/due-today/practice/seq' }, '開始練習') : null),
    h('a', { class: 'due-link', href: '#/s/unpracticed' }, `還沒練過 ${unpracticed} 張 →`));
}

// null is the past year; a number is that calendar year.
let graphYear = null;

// Laid out like GitHub's contribution graph: a column per week from Sunday, a square per day.
function practiceGraph(activity) {
  // Like the counts, a day runs from 4am, so just after midnight is still yesterday.
  const today = new Date(Date.now() - 4 * 60 * 60 * 1000);
  today.setHours(12, 0, 0, 0);
  const first = new Date(graphYear ?? today.getFullYear() - 1, graphYear === null ? today.getMonth() : 0, graphYear === null ? today.getDate() + 1 : 1, 12);
  const last = graphYear === null || graphYear === today.getFullYear() ? today : new Date(graphYear, 11, 31, 12);
  const days = [];
  for (const d = new Date(first); d <= last; d.setDate(d.getDate() + 1)) days.push({ date: new Date(d), count: activity.get(dateKey(d)) ?? 0 });
  const total = days.reduce((sum, d) => sum + d.count, 0);
  const level = levels(days.map((d) => d.count));

  const weeks = [];
  const months = [];
  for (const [i, { date, count }] of days.entries()) {
    if (i === 0 || date.getDay() === 0) {
      weeks.push(Array.from({ length: date.getDay() }, () => h('span', { class: 'day blank' })));
      if (i === 0 || date.getDate() <= 7) months.push([weeks.length, `${date.getMonth() + 1} 月`]);
    }
    const label = `${date.getMonth() + 1}/${date.getDate()}：${count ? `練習 ${count} 次` : '沒有練習'}`;
    weeks.at(-1).push(h('span', { class: `day l${level(count)}`, title: label, 'aria-label': label }));
  }
  // A label needs three columns of room, so a month cut short at the left edge goes unlabelled.
  if (months.length > 1 && months[1][0] - months[0][0] < 3) months.shift();

  const scroll = h('div', { class: 'graph-scroll' },
    h('div', { class: 'graph' },
      h('div', { class: 'graph-months' }, months.map(([column, text]) => h('span', { style: `grid-column: ${column}` }, text))),
      h('div', { class: 'graph-weekdays', 'aria-hidden': 'true' }, ['', '一', '', '三', '', '五', ''].map((text) => h('span', {}, text))),
      h('div', { class: 'graph-weeks' }, weeks.map((cells) => h('div', { class: 'graph-week' }, cells)))));
  // A narrow screen shows the latest weeks first; earlier ones are a swipe away.
  if (graphYear === null) queueMicrotask(() => { scroll.scrollLeft = scroll.scrollWidth; });

  const section = h('section', { class: 'practice-graph' },
    h('div', { class: 'graph-head' },
      h('p', { class: 'graph-title' }, `${graphYear === null ? '過去一年' : `${graphYear} 年`}練習 ${total.toLocaleString()} 次`),
      yearPicker(activity, today, () => section.replaceWith(practiceGraph(activity)))),
    h('div', { class: 'card graph-card' }, scroll));
  return section;
}

// Shown once the record spans more than one calendar year.
function yearPicker(activity, today, repaint) {
  const earliest = Math.min(...[...activity.keys()].map((key) => Number(key.slice(0, 4))));
  if (!(earliest < today.getFullYear())) return null;
  const options = [[null, '過去一年']];
  for (let year = today.getFullYear(); year >= earliest; year--) options.push([year, String(year)]);
  return h('div', { class: 'year-picker' }, options.map(([year, text]) => h('button', {
    type: 'button',
    'aria-pressed': String(year === graphYear),
    onclick: () => {
      graphYear = year;
      repaint();
    },
  }, text)));
}

// Quartiles of the days that have any practice, as GitHub shades its graph, so one huge day does not wash out the rest.
function levels(counts) {
  const sorted = counts.filter(Boolean).sort((a, b) => a - b);
  const cuts = [0.25, 0.5, 0.75].map((q) => sorted[Math.floor((sorted.length - 1) * q)]);
  return (count) => (count ? 1 + cuts.filter((cut) => count > cut).length : 0);
}

function dateKey(date) {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
}

// Archived cards are left out of every figure except their own count, matching the group rows.
function deckStats(deck) {
  const all = deck.cards.map((c) => deck.schedule.get(c.id)).filter(Boolean);
  const active = all.filter((s) => !s.suspended);
  const practiced = active.filter((s) => s.status !== 'new');
  const archived = all.length - active.length;
  const today = all.filter((s) => s.lastReview?.daysAgo === 0).length;
  const percent = (x) => `${Math.round(x * 100)}%`;
  const stat = (label, value, note) => h('div', { class: 'stat' },
    h('span', { class: 'stat-label' }, label),
    h('span', { class: 'stat-value' }, value),
    note ? h('span', { class: 'stat-note' }, note) : null);
  return h('section', { class: 'stats' },
    stat('總題數', active.length, archived ? `封存 ${archived}` : null),
    stat('已練過', practiced.length, active.length ? percent(practiced.length / active.length) : null),
    stat('今天練過', today));
}

function renderSmartGroup(deck, key) {
  const source = practiceSource(deck, 's', key);
  if (!source) return [breadcrumb([key]), h('p', { class: 'empty' }, `找不到自動群組 ${key}`)];
  const groupNames = new Map(deck.groups.map((g) => [g.slug, g.name]));
  return [
    breadcrumb([source.name]),
    h('h1', {}, source.name, ' ', h('span', { class: 'count' }, `${source.order.length} 張`)),
    h('p', { class: 'actions' }, practiceButtons(source.href, [['開始練習', '', true]])),
    source.order.length
      ? h('ul', { class: 'rows' }, source.order.map((id) => {
          const card = source.cards.get(id);
          return cardRow(deck, card, {
            href: `${source.href}/practice/seq/${encodeURIComponent(id)}`,
            extra: h('span', { class: 'row-group' }, groupNames.get(card.group) ?? card.group),
          });
        }))
      : h('p', { class: 'empty' }, '這個自動群組沒有卡片'),
  ];
}

function groupList(deck) {
  const counts = Map.groupBy(deck.cards, (c) => c.group);
  const list = h('ul', { class: 'rows' }, deck.groups.map((g) => groupRow(deck, g, counts.get(g.slug)?.length ?? 0)));
  // Built from the same parts as a row, with the handle and menu kept invisible, so the labels line up with the counts.
  const head = h('ul', { class: 'rows', 'aria-hidden': 'true' },
    h('li', { class: 'row rows-head' },
      deck.readOnly ? null : h('span', { class: 'row-handle' }, '⋮⋮'),
      h('div', { class: 'row-main' },
        h('span', { class: 'row-text' }),
        h('span', { class: 'row-todos' }, h('span', { class: 'row-todo' }, '沒練過'), h('span', { class: 'row-todo' }, '已到期'))),
      deck.readOnly ? null : h('div', { class: 'menu-wrap' }, h('button', { type: 'button', class: 'menu-trigger', tabindex: '-1' }, '⋯'))));
  sortable(list, deck.groups.map((g) => g.slug), async (order, slug) => {
    try {
      await api('PUT', '/api/group-order', { order });
    } catch (err) {
      await render();
      showRowError(slug, `排序失敗：${err.message}`);
    }
  });
  return h('div', {}, head, list);
}

function groupRow(deck, group, count) {
  const url = `/api/groups/${encodeURIComponent(group.slug)}`;
  const { unpracticed, total, due, practiced } = groupStatus(deck, group);
  const error = h('p', { class: 'errors row-error' });
  const remove = async () => {
    error.textContent = '';
    try {
      await api('DELETE', url);
    } catch (err) {
      error.textContent = `刪除失敗：${err.message}`;
      return;
    }
    render();
  };
  const schedules = group.order.map((id) => [id, deck.schedule.get(id)]).filter(([, s]) => s);
  const archived = schedules.filter(([, s]) => s.suspended).map(([id]) => id);
  const unarchived = schedules.filter(([, s]) => !s.suspended).map(([id]) => id);
  // One card at a time, so the events keep the group's order and a failure stops before the rest.
  const markAll = async (ids, type, failure) => {
    try {
      for (const id of ids) await api('POST', '/api/progress', { id, type });
    } catch (err) {
      await render();
      showRowError(group.slug, `${failure}：${err.message}`);
      return;
    }
    render();
  };
  const li = h('li', { class: 'row', 'data-id': group.slug },
    deck.readOnly ? null : dragHandle(),
    h('a', {
      class: 'row-main',
      href: `#/g/${encodeURIComponent(group.slug)}`,
      draggable: 'false',
      title: total ? `共 ${total} 張・沒練過 ${unpracticed}・今天到期 ${due}` : null,
    },
      h('span', { class: 'row-text' }, group.name),
      h('span', { class: 'progress', role: 'progressbar', 'aria-label': '練過比例', 'aria-valuenow': Math.round(practiced * 100) },
        h('span', { style: `width: ${practiced * 100}%` })),
      total ? todoCounts(unpracticed, due) : null),
    deck.readOnly ? null : menu([
      {
        label: '改名',
        onselect: () => {
          li.className = 'row editing';
          li.replaceChildren(groupForm({ name: group.name }, '改名', ({ name }) => api('PUT', url, { name }), render));
        },
      },
      unarchived.length > 0 && {
        label: '封存全部',
        confirm: `確定封存 ${unarchived.length} 張？`,
        onselect: () => markAll(unarchived, 'suspend', '封存失敗'),
      },
      archived.length > 0 && {
        label: '取消封存全部',
        onselect: () => markAll(archived, 'unsuspend', '取消封存失敗'),
      },
      count
        ? { label: '刪除', disabled: true, note: `群組裡還有 ${count} 張卡，要先搬走或刪掉` }
        : { label: '刪除', confirm: '確定刪除這個群組？', onselect: remove },
    ]),
    errorList(group.errors),
    error);
  return li;
}

// Each column sums to the home page figure of the same name.
function todoCounts(unpracticed, due) {
  if (!unpracticed && !due) return h('span', { class: 'row-todos done', 'aria-label': '都練完了' }, '✓');
  const count = (n, label) => h('span', { class: n ? 'row-todo' : 'row-todo zero', 'aria-label': `${label} ${n} 張` }, n || '–');
  return h('span', { class: 'row-todos' }, count(unpracticed, '沒練過'), count(due, '已到期'));
}

// Archived cards count toward none of the figures, so archiving a card never leaves a group looking unfinished.
function groupStatus(deck, group) {
  const active = group.order.map((id) => deck.schedule.get(id)).filter((s) => s && !s.suspended);
  const unpracticed = active.filter((s) => s.status === 'new').length;
  const due = active.filter(isDue).length;
  return {
    unpracticed,
    total: active.length,
    due,
    todo: unpracticed + due,
    practiced: active.length ? (active.length - unpracticed) / active.length : 0,
  };
}

function isDue(schedule) {
  return schedule.status === 'scheduled' && schedule.dueInDays <= 0;
}

// New and due cards both need practice now, so they are counted and practiced as one set.
function needsPractice(schedule) {
  return schedule.status === 'new' || isDue(schedule);
}

// The `edit` class keeps a hot reload from wiping what is being typed.
function groupForm(values, label, submit, cancel) {
  const inputs = Object.entries(values).map(([key, value]) => {
    const input = h('input', {
      name: key,
      placeholder: key === 'slug' ? 'slug（例如 graph-theory）' : '顯示名稱',
    });
    input.value = value;
    return input;
  });
  const message = h('span', { class: 'errors' });
  const form = h('form', {
    class: 'edit group-form',
    onsubmit: async (e) => {
      e.preventDefault();
      message.textContent = '';
      const data = Object.fromEntries(inputs.map((i) => [i.name, i.value]));
      try {
        await submit(data);
      } catch (err) {
        message.textContent = err.message;
        return;
      }
      render();
    },
  }, inputs, h('button', { class: 'primary' }, label), h('button', { type: 'button', onclick: cancel }, '取消'), message);
  queueMicrotask(() => inputs[0].focus());
  return form;
}

const SHUFFLE_ICON = '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M16 3h5v5M4 20 21 3M21 16v5h-5M15 15l6 6M4 4l5 5"/></svg>';

// The shuffle toggle steers every button next to it and is remembered across visits.
function practiceButtons(href, buttons) {
  const links = buttons.filter(Boolean).map(([label, scope, primary]) => {
    const link = h('a', { class: primary ? 'button primary' : 'button' }, label);
    return { link, scope };
  });
  const paint = () => {
    const random = shuffleOn();
    toggle.setAttribute('aria-pressed', String(random));
    for (const { link, scope } of links) link.href = `${href}/practice/${scope}${random ? 'random' : 'seq'}`;
  };
  const toggle = shuffleButton(() => {
    setShuffle(!shuffleOn());
    paint();
  });
  paint();
  return [...links.map((l) => l.link), toggle];
}

function shuffleButton(onclick) {
  const button = h('button', { type: 'button', class: 'shuffle', title: '隨機順序', 'aria-label': '隨機順序', onclick });
  button.innerHTML = SHUFFLE_ICON;
  return button;
}

function shuffleOn() {
  try {
    return localStorage.getItem('shuffle') === '1';
  } catch {
    return false;
  }
}

function setShuffle(on) {
  try {
    localStorage.setItem('shuffle', on ? '1' : '0');
  } catch {}
}

function renderGroup(deck, slug) {
  const group = deck.groups.find((g) => g.slug === slug);
  if (!group) return [breadcrumb([slug]), h('p', { class: 'empty' }, `找不到群組 ${slug}`)];
  const cards = groupCards(deck, slug);
  const href = `#/g/${encodeURIComponent(slug)}`;
  const { todo } = groupStatus(deck, group);
  const list = h('ul', { class: 'rows' }, group.order.map((id) =>
    cardRow(deck, cards.get(id), { href: `${href}/practice/seq/${encodeURIComponent(id)}`, handle: !deck.readOnly, insertable: true })));
  sortable(list, group.order, async (order, id) => {
    try {
      await api('PUT', `/api/groups/${encodeURIComponent(slug)}/order`, { order });
    } catch (err) {
      await render();
      showRowError(id, `排序失敗：${err.message}`);
    }
  });
  const empty = group.order.length ? null : h('p', { class: 'empty' }, '這個群組還沒有卡片');
  const noMatch = h('p', { class: 'empty', hidden: true });
  const search = group.order.length ? searchBox(`g/${slug}`, '搜尋 ID 或內容', (query) => {
    const terms = searchTerms(query);
    let shown = 0;
    for (const li of list.children) {
      const card = cards.get(li.dataset.id);
      if (!card || li.classList.contains('editing')) continue;
      const match = terms.length ? cardMatch(card, terms) : null;
      li.hidden = !!terms.length && !match;
      if (!li.hidden) shown++;
      paintCardMatch(li, card, terms, match);
    }
    list.classList.toggle('filtering', !!terms.length);
    noMatch.hidden = !!shown;
    noMatch.textContent = `找不到符合「${query}」的卡片`;
  }) : null;
  const add = (kind) => {
    const li = h('li', { class: 'row editing' }, editor(TEMPLATES[kind], (raw) => api('POST', '/api/cards', { group: slug, raw }).then(render), () => li.remove()));
    list.prepend(li);
    empty?.remove();
  };
  return [
    breadcrumb([group.name]),
    h('h1', {}, group.name, ' ', h('span', { class: 'count' }, `${group.order.length} 張`)),
    errorList(group.errors),
    h('p', { class: 'actions' },
      todo || !group.order.length ? null : h('span', { class: 'muted' }, '✓ 今天都練完了'),
      practiceButtons(href, [todo ? [`練習 ${todo} 張`, 'todo/', true] : null, ['練習全部', '', !todo]]),
      h('span', { class: 'spacer' }),
      search,
      deck.readOnly && !deck.canAdd ? null : menu(kindItems(add), { label: '+ 新增', class: 'soft' })),
    list,
    empty,
    noMatch,
  ];
}

function cardRow(deck, card, { href, handle = false, extra = null, insertable = false, scheduleText = false }) {
  const schedule = deck.schedule.get(card.id);
  const error = h('p', { class: 'errors row-error' });
  const li = h('li', { class: schedule?.suspended ? 'row archived' : 'row', 'data-id': card.id },
    handle ? dragHandle() : null,
    h('a', { class: 'row-main', href, draggable: 'false' },
      h('span', { class: 'id' }, card.id),
      extra,
      h('span', { class: 'row-text' }, questionPreview(card)),
      deck.conflicts?.includes(card.id) ? h('span', { class: 'row-status conflict-mark' }, '⚠ 衝突') : h('span', { class: 'row-status' },
        card.schedule === 'fsrs' ? null
          : scheduleText ? h('span', { class: 'schedule-mark' }, `${scheduleLabel(card.schedule)} · `)
          : h('span', { class: 'schedule-mark', title: scheduleLabel(card.schedule) }, '◇ '),
        dueLabel(schedule))),
    cardMenu(deck, card, {
      edit: () => {
        li.draggable = false;
        li.className = 'row editing';
        li.replaceChildren(
          h('span', { class: 'id' }, card.id),
          editor(card.raw, (raw) => api('PUT', cardUrl(card), { raw, version: card.version }).then(render), render));
      },
      // `side` is 'before' or 'after', which is also the DOM method that puts the editor there.
      insert: insertable && ((side, kind) => {
        const row = h('li', { class: 'row editing' }, editor(TEMPLATES[kind], (raw) => api('POST', '/api/cards', { group: card.group, raw, [side]: card.id }).then(render), () => row.remove()));
        li[side](row);
      }),
      report: (message) => { error.textContent = message; },
    }),
    errorList(card.errors),
    error);
  return li;
}

function showRowError(id, message) {
  const error = app.querySelector(`li[data-id="${CSS.escape(id)}"] > .row-error`);
  if (error) error.textContent = message;
}

// The row is draggable only while its handle is held, so pressing anywhere else is a click.
const PEN = '<path d="M21.17 6.81a2.83 2.83 0 0 0-4-4L3.84 16.15a2 2 0 0 0-.5.83l-1.32 4.35a.5.5 0 0 0 .62.62l4.35-1.32a2 2 0 0 0 .83-.5z"/><path d="m15 5 4 4"/>';
const FUNNEL = '<path d="M22 3H2l8 9.46V19l4 2v-8.54z"/>';
const MOON = '<path d="M12 3a6 6 0 0 0 9 9 9 9 0 1 1-9-9Z"/>';
const SUN = '<circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4.93 4.93l1.41 1.41M17.66 17.66l1.41 1.41M2 12h2M20 12h2M6.34 17.66l-1.41 1.41M19.07 4.93l-1.41 1.41"/>';

function icon(paths) {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  for (const [k, v] of Object.entries({ width: 18, height: 18, viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', 'stroke-width': 2, 'stroke-linecap': 'round', 'stroke-linejoin': 'round', 'aria-hidden': 'true' })) svg.setAttribute(k, v);
  svg.innerHTML = paths;
  return svg;
}

function dragHandle() {
  return h('span', {
    class: 'row-handle',
    title: '拖曳排序',
    onpointerdown: (e) => { e.currentTarget.closest('li').draggable = true; },
    onpointerup: (e) => { e.currentTarget.closest('li').draggable = false; },
  }, '⋮⋮');
}

function cardMenu(deck, card, { edit, insert, report, done = render }) {
  const schedule = deck.schedule.get(card.id);
  const run = async (action, failure) => {
    report('');
    try {
      await action();
    } catch (err) {
      report(`${failure}：${err.message}`);
      return;
    }
    done();
  };
  const progress = (type) => run(() => api('POST', '/api/progress', { id: card.id, type }), '操作失敗');
  const others = deck.readOnly ? [] : deck.groups.filter((g) => g.slug !== card.group);
  return menu([
    edit && { label: '編輯', onselect: edit },
    insert && (!deck.readOnly || deck.canAdd) && { label: '在前面新增', items: kindItems((kind) => insert('before', kind)) },
    insert && (!deck.readOnly || deck.canAdd) && { label: '在後面新增', items: kindItems((kind) => insert('after', kind)) },
    others.length > 0 && {
      label: '移到',
      items: others.map((g) => ({
        label: g.name,
        onselect: () => run(() => api('POST', `${cardUrl(card)}/move`, { to: g.slug }), '移動失敗'),
      })),
    },
    {
      label: '排程',
      items: [...new Set([...SCHEDULES, card.schedule])].map((value) => ({
        label: `${value === card.schedule ? '✓' : '\u3000'} ${scheduleLabel(value)}`,
        onselect: () => run(() => api('PUT', `${cardUrl(card)}/schedule`, { schedule: value }), '改排程失敗'),
      })),
    },
    schedule && {
      label: '重設進度',
      confirm: '確定重設進度？',
      onselect: () => progress('reset'),
    },
    schedule && (schedule.suspended
      ? { label: '取消封存', onselect: () => progress('unsuspend') }
      : { label: '封存', confirm: '確定封存？', onselect: () => progress('suspend') }),
    (!deck.readOnly || deck.canDelete) && {
      label: '刪除',
      confirm: '確定刪除這張卡？',
      onselect: () => run(() => api('DELETE', cardUrl(card)), '刪除失敗'),
    },
  ]);
}

let openMenu = null;

// Items are { label, onselect } or { label, items } for a list that expands inside the menu.
// A disabled item may carry a `note` saying why. An item with `confirm` asks again in place
// on the first click: the phone version runs in a sandboxed frame where confirm() is blocked.
// Menus open leftward from a trigger at the right edge; one that wrapped to the left of a narrow screen opens rightward instead.
function showPanel(panel) {
  panel.hidden = false;
  panel.classList.remove('align-left');
  if (panel.getBoundingClientRect().left < 0) panel.classList.add('align-left');
}

function menu(items, { label = '⋯', class: triggerClass = 'menu-trigger' } = {}) {
  if (!items.some(Boolean)) return null;
  const panel = h('div', { class: 'menu', role: 'menu', hidden: true }, menuItems(items));
  const trigger = h('button', {
    type: 'button',
    class: triggerClass,
    'aria-haspopup': 'menu',
    'aria-expanded': 'false',
    'aria-label': label === '⋯' ? '更多操作' : null,
    onclick: () => {
      if (openMenu?.panel === panel) return closeMenu();
      closeMenu();
      showPanel(panel);
      trigger.setAttribute('aria-expanded', 'true');
      openMenu = { wrap, panel, trigger };
    },
  }, label);
  const wrap = h('div', { class: 'menu-wrap' }, trigger, panel);
  return wrap;
}

function menuItems(items) {
  return items.filter(Boolean).flatMap((item) => {
    if (item.items) {
      const sub = h('div', { class: 'menu-sub', hidden: true }, menuItems(item.items));
      const toggle = h('button', {
        type: 'button',
        role: 'menuitem',
        'aria-expanded': 'false',
        onclick: () => {
          sub.hidden = !sub.hidden;
          toggle.setAttribute('aria-expanded', String(!sub.hidden));
        },
      }, item.label);
      return [toggle, sub];
    }
    const button = h('button', {
      type: 'button',
      role: 'menuitem',
      disabled: item.disabled,
      'data-label': item.confirm ? item.label : null,
      onclick: () => {
        if (item.confirm && !button.classList.contains('confirming')) {
          button.classList.add('confirming');
          button.textContent = item.confirm;
          return;
        }
        closeMenu();
        item.onselect();
      },
    }, item.label);
    return [
      button,
      item.disabled && item.note ? h('p', { class: 'menu-note' }, item.note) : null,
    ].filter(Boolean);
  });
}

function closeMenu() {
  if (!openMenu) return;
  openMenu.panel.hidden = true;
  openMenu.trigger.setAttribute('aria-expanded', 'false');
  for (const sub of openMenu.panel.querySelectorAll('.menu-sub')) sub.hidden = true;
  for (const button of openMenu.panel.querySelectorAll('.confirming')) {
    button.classList.remove('confirming');
    button.textContent = button.dataset.label;
  }
  openMenu = null;
}

addEventListener('pointerdown', (e) => {
  if (openMenu && !openMenu.wrap.contains(e.target)) closeMenu();
});

addEventListener('keydown', (e) => {
  if (e.key !== 'Escape' || !openMenu) return;
  const { trigger } = openMenu;
  closeMenu();
  trigger.focus();
});

// A re-render mid-drag detaches the dragged row; the drag then ends without a drop and counts as cancelled.
function sortable(list, initial, save) {
  let saved = initial.join();
  let dragging = null;
  let dropped = false;
  const ids = () => [...list.children].map((li) => li.dataset.id).filter(Boolean);
  list.addEventListener('dragstart', (e) => {
    const li = e.target.closest?.('li[draggable="true"]');
    if (!li || li.parentNode !== list) return;
    dragging = li;
    dropped = false;
    dragging.classList.add('dragging');
    e.dataTransfer.effectAllowed = 'move';
    e.dataTransfer.setData('text/plain', dragging.dataset.id);
    autoscroll(() => dragging === li && li.isConnected);
  });
  list.addEventListener('dragover', (e) => {
    if (!dragging) return;
    e.preventDefault();
    const over = e.target.closest('li[data-id]');
    if (!over || over === dragging || over.parentNode !== list) return;
    const r = over.getBoundingClientRect();
    list.insertBefore(dragging, e.clientY < r.top + r.height / 2 ? over : over.nextSibling);
  });
  list.addEventListener('drop', (e) => {
    if (!dragging) return;
    e.preventDefault();
    dropped = true;
  });
  list.addEventListener('dragend', () => {
    if (!dragging) return;
    const { id } = dragging.dataset;
    dragging.classList.remove('dragging');
    dragging.draggable = false;
    dragging = null;
    if (!list.isConnected) return;
    const order = ids();
    if (!dropped) return render();
    if (order.join() === saved) return;
    saved = order.join();
    save(order, id);
  });
}

// Native drag scrolls the page only in a thin strip at the window edge; this widens the strip and speeds it up.
function autoscroll(active) {
  const edge = 80;
  let y = 0;
  let seen = 0;
  const track = (e) => { y = e.clientY; seen = performance.now(); };
  const step = () => {
    if (!active()) return removeEventListener('dragover', track);
    const depth = y < edge ? y - edge : y > innerHeight - edge ? y - (innerHeight - edge) : 0;
    // dragover keeps firing while the pointer rests in the window, so a stale one means it has left.
    if (depth && performance.now() - seen < 200) scrollBy(0, depth / 4);
    requestAnimationFrame(step);
  };
  addEventListener('dragover', track);
  requestAnimationFrame(step);
}

function cardUrl(card) {
  return `/api/cards/${encodeURIComponent(card.group)}/${encodeURIComponent(card.id)}`;
}

function shuffle(arr) {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}

function groupCards(deck, slug) {
  return new Map(deck.cards.filter((c) => c.group === slug).map((c) => [c.id, c]));
}

// A smart group's cards are looked up deck-wide, so a card that leaves the group mid-session stays practicable.
function practiceSource(deck, kind, key) {
  if (kind === 's') {
    const smart = deck.smartGroups.find((g) => g.key === key);
    if (!smart) return null;
    const cards = new Map(deck.cards.map((c) => [c.id, c]));
    return { kind, key, name: smart.name, href: `#/s/${encodeURIComponent(key)}`, order: smart.ids, cards };
  }
  const group = deck.groups.find((g) => g.slug === key);
  if (!group) return null;
  const order = group.order.filter((id) => !deck.schedule.get(id)?.suspended);
  return { kind, key, name: group.name, href: `#/g/${encodeURIComponent(key)}`, order, cards: groupCards(deck, key) };
}

// A group round holds the whole group, or just its new and due cards in todo mode, and opens at `from`; a smart round is the next cards starting at `from`.
function startSession(deck, kind, key, { todo, random }, from) {
  const group = practiceSource(deck, kind, key);
  if (!group) return null;
  const { cards } = group;
  let ids = group.order.filter((id) => !cards.get(id).errors.length);
  const skipped = group.order.length - ids.length;
  if (todo) ids = ids.filter((id) => needsPractice(deck.schedule.get(id)));
  if (random) {
    shuffle(ids);
    // A reload keeps the card it was on; the rest of the round is reshuffled.
    const i = ids.indexOf(from);
    if (i > 0) ids.unshift(...ids.splice(i, 1));
  }
  const at = from && !random ? startIndex(deck, group, ids, from) : 0;
  if (kind === 's') {
    ids.splice(0, at);
    ids.splice(SMART_ROUND_SIZE);
  }
  return {
    deck,
    group,
    cards,
    todo,
    random,
    skipped,
    ...newRound(ids),
    pos: kind === 's' ? 0 : at,
  };
}

// A start card left out of the round (archived or malformed) opens the round at the next card after it.
function startIndex(deck, source, ids, from) {
  const rank = orderRank(deck, source);
  return Math.max(ids.findIndex((id) => rank.get(id) >= rank.get(from)), 0);
}

function orderRank(deck, source) {
  const all = source.kind === 'g' ? deck.groups.find((g) => g.slug === source.key).order : source.order;
  return new Map(all.map((id, i) => [id, i]));
}

// Switching keeps the round's cards and the card on screen; ratings and answers so far follow their cards.
function setRoundOrder(s, random) {
  const id = s.ids[s.pos];
  const entries = new Map(s.ids.map((cid, i) => [cid, s.entries[i]]));
  if (random) {
    s.ids = [id, ...shuffle(s.ids.filter((cid) => cid !== id))];
  } else {
    const rank = orderRank(s.deck, s.group);
    s.ids = [...s.ids].sort((a, b) => (rank.get(a) ?? Infinity) - (rank.get(b) ?? Infinity));
  }
  s.entries = s.ids.map((cid) => entries.get(cid));
  s.pos = s.ids.indexOf(id);
  const owned = ownsUrl(s);
  s.random = random;
  setShuffle(random);
  if (owned) history.replaceState(history.state, '', `${roundUrl(s)}/${encodeURIComponent(id)}`);
  showPractice();
}

function newRound(ids) {
  return { ids, pos: 0, entries: ids.map(newEntry) };
}

function newEntry() {
  return { input: '', revealed: false };
}

function markdown(text) {
  const el = h('div', { class: 'markdown' });
  el.innerHTML = marked.parse(text);
  for (const a of el.querySelectorAll('a[href^="http"]')) {
    a.target = '_blank';
    a.rel = 'noopener noreferrer';
  }
  for (const code of el.querySelectorAll('pre code[class*="language-"]')) {
    const lang = code.className.match(/language-(\S+)/)[1];
    if (hljs.getLanguage(lang)) hljs.highlightElement(code);
  }
  return el;
}

function section(title, ...body) {
  return h('section', {}, h('h3', {}, title), ...body);
}

function codeOf(sectionBody) {
  const block = marked.lexer(sectionBody).find((t) => t.type === 'code');
  return block ? block.text : sectionBody;
}

function diffBlock(segs, cls) {
  const code = h('code', { class: 'diff' });
  for (const s of segs) {
    if (!s.code || s.match) code.append(s.text);
    else if (code.lastChild?.nodeName === 'MARK') code.lastChild.append(s.text);
    else code.append(h('mark', { class: cls }, s.text));
  }
  return h('pre', {}, code);
}

function renderCodeAnswer(codeSections, input) {
  if (!input.trim()) {
    return codeSections.map((s, i) => section(i === 0 ? '標準答案' : '其他寫法', markdown(s.body)));
  }
  const best = codeSections
    .map((s, i) => ({ i, s, d: diff(input, codeOf(s.body)) }))
    .reduce((x, y) => (y.d.extra + y.d.missing < x.d.extra + x.d.missing ? y : x));
  const label = codeSections.length > 1 ? `標準答案（${best.i + 1}／${codeSections.length}）` : '標準答案';
  const { d } = best;
  const same = d.extra === 0 && d.missing === 0;
  return [
    h('div', { class: same ? 'verdict same' : 'verdict differs', role: 'status' },
      h('span', { class: 'verdict-icon', 'aria-hidden': 'true' }, same ? '✓' : '≠'),
      h('span', { class: 'verdict-text' },
        h('strong', {}, same ? '完全一致' : '有差異'),
        h('span', {}, same ? '和標準答案一字不差' : '紅色是你多寫的，綠色是你漏掉的'))),
    h('div', { class: 'compare' },
      section('你的答案', diffBlock(d.mine, 'extra')),
      section(label, diffBlock(d.ref, 'missing'))),
    codeSections.filter((_, i) => i !== best.i).map((s) => section('其他寫法', markdown(s.body))),
  ];
}

function renderResult(card, input) {
  const answer = card.kind === 'code'
    ? renderCodeAnswer(card.sections.filter((s) => s.name === 'Code'), input)
    : card.sections.filter((s) => s.name === 'Answer' && s.body).map((s) => section('答案', markdown(s.body)));
  const extras = card.sections.filter((s) => !KNOWN_SECTIONS.has(s.name) && s.body).map((s) => section(s.name, markdown(s.body)));
  return [...answer, ...extras].flat();
}

async function postReview(id, rating) {
  const res = await fetch('/api/progress', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(rating === 'seen' ? { id, type: 'review' } : { id, type: 'review', rating }),
  });
  if (!res.ok) throw new Error((await res.json().catch(() => null))?.error ?? `記錄評分失敗（${res.status}）`);
}

function ratingBar(card, entry) {
  const status = h('p', { class: 'errors' });
  const rate = async (rating) => {
    if (buttons[0].disabled) return;
    for (const b of buttons) b.disabled = true;
    try {
      await postReview(card.id, rating);
      entry.rating = rating;
      move(1);
    } catch (err) {
      status.textContent = err.message;
      for (const b of buttons) b.disabled = false;
    }
  };
  const preview = session.deck.schedule.get(card.id)?.preview;
  const choices = card.schedule === 'fsrs' ? RATINGS : SEEN;
  const buttons = choices.map(([rating, label], i) =>
    h('button', {
      type: 'button',
      'aria-pressed': String(entry.rating === rating),
      title: `按 ${i + 1}`,
      onclick: () => rate(rating),
    },
    h('span', { class: 'rating-name' }, label),
    preview ? h('span', { class: 'interval' }, `${preview[rating]} 天`) : null));
  session.rate = rate;
  session.choices = choices.map(([rating]) => rating);
  return h('div', { class: 'rating' },
    h('div', { class: card.schedule === 'fsrs' ? 'segmented' : 'segmented single' }, buttons),
    status);
}

function reviewStatus(schedule) {
  if (!schedule) return [];
  const last = schedule.lastReview;
  const rating = last?.rating ? ` · ${RATING_LABELS.get(last.rating)}` : '';
  const lastText = !last ? '還沒練過' : last.daysAgo === 0 ? `今天練過${rating}` : `上次 ${last.daysAgo} 天前${rating}`;
  const due = schedule.suspended || schedule.status === 'scheduled' ? dueLabel(schedule) : null;
  return [lastText, due === '今天' ? '今天到期' : due].filter(Boolean);
}

function renderPracticeView() {
  const s = session;
  const back = breadcrumb([s.group.name, s.group.href], [s.random ? '隨機練習' : '練習']);
  const skipped = s.skipped ? h('p', { class: 'errors' }, `已略過 ${s.skipped} 張格式錯誤的卡片`) : null;

  s.reveal = null;
  s.refresh = null;
  s.rate = null;
  s.choices = null;

  if (!s.ids.length) {
    return [back, skipped, h('p', { class: 'empty' }, '沒有可以練習的卡片')];
  }

  if (s.pos >= s.ids.length) {
    const smart = s.group.kind === 's';
    const error = h('p', { class: 'errors' });
    return [back, skipped,
      h('section', { class: 'card-featured round-done' },
        h('h2', {}, smart ? '這輪完成' : `這一輪 ${s.ids.length} 題練完了`),
        h('p', { class: 'actions' },
          h('button', {
            type: 'button',
            onclick: async (e) => {
              const button = e.currentTarget;
              button.disabled = true;
              error.textContent = '';
              let deck = s.deck;
              // The next smart round starts from the latest list, so cards that no longer qualify drop out.
              if (smart) {
                try {
                  deck = await fetchDeck();
                } catch (err) {
                  error.textContent = err.message;
                  button.disabled = false;
                  return;
                }
              }
              if (session !== s) return;
              session = startSession(deck, s.group.kind, s.group.key, s);
              if (session) showPractice();
              else render();
            },
            class: 'primary',
          }, smart ? `再練 ${SMART_ROUND_SIZE} 張` : '再練一輪'),
          h('button', { type: 'button', class: 'small', onclick: () => move(-1) }, '← 上一題')),
        error),
    ];
  }

  const id = s.ids[s.pos];
  const prevButton = h('button', { type: 'button', class: 'small soft', title: '⌘/Ctrl + [', disabled: s.pos === 0, onclick: () => move(-1) }, '← 上一題');
  const nextButton = h('button', { type: 'button', class: 'small soft', title: '⌘/Ctrl + ]', onclick: () => move(1) }, '下一題 →');
  const shuffleToggle = shuffleButton(() => setRoundOrder(s, !s.random));
  shuffleToggle.setAttribute('aria-pressed', String(s.random));
  const meta = h('p', { class: 'meta' });
  const paintMeta = () => meta.replaceChildren(...[
    h('span', { class: 'id' }, id),
    h('span', {}, `第 ${s.pos + 1} / ${s.ids.length} 題`),
    // The breadcrumb already names a group round's group; a smart round mixes groups.
    s.group.kind === 's' ? h('span', {}, groupName(s, id)) : null,
    h('span', { class: 'badges' },
      s.cards.has(id) ? h('span', { class: 'badge kind' }, cardKind(s.cards.get(id))) : null,
      s.cards.get(id)?.schedule && s.cards.get(id).schedule !== 'fsrs' ? h('span', { class: 'badge kind' }, scheduleLabel(s.cards.get(id).schedule)) : null,
      ...reviewStatus(s.deck.schedule.get(id)).map((text) => h('span', { class: 'badge' }, text))),
  ].filter(Boolean));
  paintMeta();

  if (!s.cards.has(id)) {
    s.refresh = showPractice;
    const moved = s.deck.cards.find((c) => c.id === id);
    return [back, skipped, meta,
      h('p', { class: 'errors' }, moved ? '這張卡已移到其他群組' : '這張卡已被刪除'),
      h('p', { class: 'actions' }, prevButton, nextButton)];
  }

  const entry = s.entries[s.pos];
  if (s.editing) {
    const card = s.cards.get(id);
    s.reveal = null;
    s.refresh = null;
    const done = () => {
      s.editing = false;
      showPractice();
    };
    const { side, kind } = s.editing;
    if (side) {
      const add = async (raw) => {
        const created = await api('POST', '/api/cards', { group: card.group, raw, [side]: id });
        updateSession(s, await fetchDeck());
        // The new card joins the round beside this one, and the round stays on this card.
        const at = side === 'before' ? s.pos : s.pos + 1;
        s.ids.splice(at, 0, created.id);
        s.entries.splice(at, 0, newEntry());
        if (side === 'before') s.pos += 1;
        done();
      };
      return [back, skipped,
        h('p', { class: 'meta' }, h('span', { class: 'id' }, id), h('span', {}, side === 'before' ? '在這張前面新增' : '在這張後面新增')),
        editor(TEMPLATES[kind], add, done)];
    }
    const save = async (raw) => {
      await api('PUT', cardUrl(card), { raw, version: card.version });
      updateSession(s, await fetchDeck());
      done();
    };
    return [back, skipped, h('p', { class: 'meta' }, h('span', { class: 'id' }, card.id)), editor(card.raw, save, done)];
  }

  const question = h('div', { class: 'question' });
  const result = h('div', { class: 'result' });
  const paint = () => {
    const card = s.cards.get(id);
    s.rate = null;
    revealButton.textContent = entry.revealed ? '收回' : '翻開';
    revealButton.className = entry.revealed ? '' : 'primary';
    if (card.errors.length) {
      question.replaceChildren(errorList(card.errors));
      result.replaceChildren();
      return;
    }
    question.replaceChildren(markdown(frontOf(card)));
    result.replaceChildren(...(entry.revealed ? [...renderResult(card, entry.input), ratingBar(card, entry)] : []));
  };
  const setRevealed = (revealed) => {
    entry.revealed = revealed;
    // Leaving focus in the answer box would swallow the 1–4 rating keys.
    if (revealed && document.activeElement === input) input.blur();
    paint();
  };
  // The button also takes back an answer shown by mistake; the shortcut only shows it, so pressing it again before rating is harmless.
  const revealButton = h('button', { type: 'button', onclick: () => setRevealed(!entry.revealed) });
  const error = h('p', { class: 'errors' });
  const menuSlot = h('div', { class: 'practice-menu' });
  const paintMenu = () => {
    if (openMenu && menuSlot.contains(openMenu.wrap)) return;
    menuSlot.replaceChildren(...[h('button', {
      type: 'button',
      class: 'edit-trigger',
      title: '編輯',
      'aria-label': '編輯',
      onclick: () => { s.editing = true; showPractice(); },
    }, icon(PEN)), cardMenu(s.deck, s.cards.get(id), {
      insert: (side, kind) => { s.editing = { side, kind }; showPractice(); },
      report: (message) => { error.textContent = message; },
      done: async () => {
        try {
          updateSession(s, await fetchDeck());
        } catch (err) {
          error.textContent = err.message;
          return;
        }
        if (session === s) showPractice();
      },
    })].filter(Boolean));
  };
  paint();
  paintMenu();
  const input = h('textarea', {
    spellcheck: 'false',
    placeholder: '先寫出你的答案',
    oninput: (e) => { entry.input = e.target.value; },
    onkeydown: (e) => {
      if (e.key === 'Tab') {
        e.preventDefault();
        e.target.setRangeText('    ', e.target.selectionStart, e.target.selectionEnd, 'end');
        entry.input = e.target.value;
      }
    },
  });
  input.value = entry.input;
  // On a phone, focusing pops up the keyboard over the question before it is read.
  if (!matchMedia('(pointer: coarse)').matches) queueMicrotask(() => input.focus());
  s.reveal = () => setRevealed(true);
  s.refresh = () => {
    if (!s.cards.has(id)) return showPractice();
    paintMeta();
    paintMenu();
    paint();
    paintNav(s);
  };

  return [back, skipped,
    h('div', { class: 'practice-head' }, meta, menuSlot),
    question,
    input,
    h('p', { class: 'actions' },
      revealButton,
      h('span', { class: 'shortcut' }, '⌘/Ctrl + Enter'),
      h('span', { class: 'spacer' }),
      shuffleToggle,
      prevButton,
      nextButton),
    error,
    result,
  ];
}

function showPractice() {
  const s = session;
  if (s.pos < s.ids.length) keepInUrl(s, s.ids[s.pos]);
  app.replaceChildren(...renderPracticeView().flat().filter((c) => c != null));
  showNav(s.pos < s.ids.length && !s.editing ? tickNavigator(s) : null);
}

// replaceState fires no hashchange and adds no history entry, so Back still leaves the practice page.
// The URL is left alone once it points elsewhere, since the old round stays on screen until the new page loads.
function keepInUrl(s, id) {
  const hash = `${roundUrl(s)}/${encodeURIComponent(id)}`;
  if (location.hash !== hash && ownsUrl(s)) history.replaceState(history.state, '', hash);
}

function roundUrl(s) {
  return `${s.group.href}/practice/${s.todo ? 'todo/' : ''}${s.random ? 'random' : 'seq'}`;
}

function ownsUrl(s) {
  const round = roundUrl(s);
  return location.hash === round || location.hash.startsWith(`${round}/`);
}

// The navigator lives outside #app and survives re-renders, so an open hover panel stays open across a jump.
function showNav(nav) {
  const current = document.querySelector('body > .tick-nav');
  if (current !== nav) current?.remove();
  if (nav && !nav.isConnected) app.after(nav);
}

function tickNavigator(s) {
  if (!s.nav) {
    const panel = h('div', { class: 'nav-panel' }, h('ol', { class: 'nav-list' }));
    const toggle = h('button', {
      type: 'button',
      class: 'soft nav-toggle',
      onclick: () => {
        s.nav.classList.toggle('open');
        centerCurrent(s);
      },
    });
    s.nav = h('nav', { class: 'tick-nav', onmouseenter: () => centerCurrent(s) },
      h('div', { class: 'nav-ticks', 'aria-hidden': 'true' }), panel, toggle);
  }
  paintNav(s);
  return s.nav;
}

function paintNav(s) {
  const [ticks, panel, toggle] = s.nav.children;
  ticks.replaceChildren(...s.ids.map((_, i) => h('span', { class: i === s.pos ? 'tick current' : 'tick' })));
  panel.firstChild.replaceChildren(...s.ids.map((id, i) => navRow(s, id, i)));
  toggle.textContent = `${s.pos + 1} / ${s.ids.length}`;
}

function navRow(s, id, i) {
  const card = s.cards.get(id);
  const rating = s.entries[i].rating;
  return h('li', {},
    h('button', {
      type: 'button',
      'aria-current': i === s.pos ? 'step' : null,
      onclick: () => {
        s.nav.classList.remove('open');
        if (session === s) move(i - s.pos);
      },
    },
    h('span', { class: 'id' }, id),
    card
      ? h('span', { class: 'preview' }, questionPreview(card).replaceAll('`', ''))
      : h('span', { class: 'preview deleted' }, s.deck.cards.some((c) => c.id === id) ? '已移到其他群組' : '已刪除'),
    rating ? h('span', { class: 'rating-label' }, RATING_LABELS.get(rating)) : null));
}

function centerCurrent(s) {
  const panel = s.nav.querySelector('.nav-panel');
  const row = panel.querySelector('[aria-current]');
  if (row) panel.scrollTop = row.offsetTop - (panel.clientHeight - row.offsetHeight) / 2;
}

function move(delta) {
  session.pos += delta;
  showPractice();
}

addEventListener('click', (e) => {
  const open = document.querySelector('.tick-nav.open');
  if (open && !open.contains(e.target)) open.classList.remove('open');
});

addEventListener('keydown', (e) => {
  if (session?.reveal && e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
    e.preventDefault();
    session.reveal();
  }
});

// Matched by `code`, not `key`, so a Chinese input method's 【 】 still counts; works inside the answer box too.
addEventListener('keydown', (e) => {
  const delta = { BracketLeft: -1, BracketRight: 1 }[e.code];
  if (!delta || !(e.metaKey || e.ctrlKey) || e.altKey || e.shiftKey || !session || session.editing || openMenu) return;
  e.preventDefault();
  const pos = session.pos + delta;
  if (pos >= 0 && pos <= session.ids.length) move(delta);
});

// Matched by `code`, not `key`: with the Zhuyin input method on, 1 and 2 come through as ㄅ and ㄉ.
addEventListener('keydown', (e) => {
  const rating = session?.choices?.[Number(e.code.match(/^Digit(\d)$/)?.[1]) - 1];
  if (!rating || !session?.rate || e.repeat || e.metaKey || e.ctrlKey || e.altKey || openMenu) return;
  if (e.target.closest?.('input, textarea, select, [contenteditable]')) return;
  e.preventDefault();
  session.rate(rating);
});

async function render() {
  let deck;
  try {
    deck = await fetchDeck();
  } catch (err) {
    app.replaceChildren(h('p', { class: 'errors' }, err.message));
    showNav(null);
    return;
  }
  session = null;
  if (location.hash === '#/conflicts') return renderConflicts();
  const p = location.hash.match(/^#\/([gs])\/([^/]+)\/practice\/(todo\/)?(seq|random)(?:\/([^/]+))?$/);
  if (p) {
    session = startSession(deck, p[1], decodeURIComponent(p[2]), { todo: !!p[3], random: p[4] === 'random' }, p[5] && decodeURIComponent(p[5]));
    if (session) return showPractice();
  }
  renderBrowse(deck);
}

function renderBrowse(deck) {
  const m = location.hash.match(/^#\/([gs])\/([^/]+)/);
  const page = !m ? renderHome(deck) : m[1] === 's' ? renderSmartGroup(deck, decodeURIComponent(m[2])) : renderGroup(deck, decodeURIComponent(m[2]));
  const typing = document.activeElement?.closest?.('.search') ? document.activeElement : null;
  app.replaceChildren(...page.flat().filter((c) => c != null));
  showNav(null);
  // A reload while typing a search hands the cursor to the same page's new box.
  const input = typing && app.querySelector(`.search[data-key="${CSS.escape(typing.parentNode.dataset.key)}"] input`);
  if (input) {
    input.focus();
    input.setSelectionRange(typing.selectionStart, typing.selectionEnd);
  }
}

// Matched by `code`, not `key`: with the Zhuyin input method on, / comes through as ㄥ.
addEventListener('keydown', (e) => {
  if (e.code !== 'Slash' || e.shiftKey || e.metaKey || e.ctrlKey || e.altKey || session || openMenu) return;
  if (e.target.closest?.('input, textarea, select, [contenteditable]')) return;
  const input = app.querySelector('.search input');
  if (!input) return;
  e.preventDefault();
  input.focus();
  input.select();
});

async function onDeckChange() {
  let deck;
  try {
    deck = await fetchDeck();
  } catch {
    return;
  }
  if (!session) {
    // An outside change must not wipe a card being edited on the group page, or a conflict being merged.
    if (document.querySelector('.edit') || location.hash === '#/conflicts') return;
    return renderBrowse(deck);
  }
  updateSession(session, deck);
  session.refresh?.();
}

function updateSession(s, deck) {
  const source = practiceSource(deck, s.group.kind, s.group.key);
  s.deck = deck;
  if (source) s.group = source;
  s.cards = source ? source.cards : new Map();
}

function groupName(s, id) {
  const slug = (s.cards.get(id) ?? s.deck.cards.find((c) => c.id === id))?.group;
  return s.deck.groups.find((g) => g.slug === slug)?.name ?? s.group.name;
}

// One conflict at a time: the phone's side can be edited before it is taken, the desktop's is shown with the lines the phone lacks marked.
async function renderConflicts() {
  showNav(null);
  let conflicts;
  try {
    ({ conflicts } = await api('GET', '/api/conflicts'));
  } catch (err) {
    app.replaceChildren(breadcrumb(['同步衝突']), h('p', { class: 'errors' }, err.message));
    return;
  }
  if (!conflicts.length) {
    location.hash = '#/';
    return;
  }
  const c = conflicts[0];
  const grow = (e) => {
    e.target.style.height = 'auto';
    e.target.style.height = `${e.target.scrollHeight}px`;
  };
  const phone = c.phone === null ? null : h('textarea', { class: 'conflict-edit', spellcheck: 'false', 'aria-label': '手機這邊', oninput: grow, onkeydown: insertSpacesOnTab });
  const ours = new Set((c.phone ?? '').split('\n'));
  const desktop = c.missingGroup ? `群組「${c.groupName}」已不存在`
    : c.desktop === null ? '已刪除'
    : h('pre', {}, c.desktop.split('\n').map((line) => (c.phone !== null && line && !ours.has(line) ? h('span', { class: 'conflict-changed' }, line) : `${line}\n`)));
  const message = h('p', { class: 'errors' });
  const choose = (use) => api('POST', `/api/conflicts/${encodeURIComponent(c.id)}`, { use, raw: phone?.value }).then(render, (err) => {
    message.textContent = err.message;
  });
  app.replaceChildren(...[
    breadcrumb(['同步衝突']),
    h('h1', {}, '同步衝突 ', h('span', { class: 'count' }, `${conflicts.length} 張`)),
    h('p', { class: 'conflict-meta' }, `${c.groupName} · `, h('span', { class: 'id' }, c.id)),
    conflictSide('手機這邊', phone ?? '已刪除'),
    conflictSide('電腦這邊', desktop),
    c.missingGroup ? h('p', { class: 'muted conflict-hint' }, '群組已不存在，手機無法建立群組。可以先複製上面的內容，之後到其他群組重新新增。') : null,
    message,
    h('div', { class: 'conflict-actions' },
      h('button', { type: 'button', class: 'primary', disabled: c.missingGroup, onclick: () => choose('phone') }, '用手機這邊'),
      h('button', { type: 'button', onclick: () => choose('desktop') }, '用電腦這邊')),
  ].filter(Boolean));
  scrollTo(0, 0);
  if (phone) {
    phone.value = c.phone;
    grow({ target: phone });
  }
}

function conflictSide(title, body) {
  return h('section', { class: 'conflict-side' }, h('h3', {}, title), typeof body === 'string' ? h('p', { class: 'conflict-gone' }, body) : body);
}

addEventListener('hashchange', render);
new EventSource('/api/events').addEventListener('message', onDeckChange);
render();
