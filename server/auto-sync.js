import { parseCard } from './card-text.js';
import { CardError } from './new-card.js';
import { SyncError, gitIn, pendingFiles, syncRepo, upstreamOf } from './git-sync.js';

const CARD_FILE = /^decks\/([^/]+)\/([a-z0-9]{5})\.md$/;

// Keeps the data repo in step with its remote: pulls on start, then syncs whenever asked, at the same moments the
// phone does. A conflict stays until a person has decided every file.
export async function createAutoSync({ dataDir, device, onStatus = () => {} }) {
  const git = gitIn(dataDir);
  const target = await upstreamOf(git);
  if (!target) return null;
  const message = `sync: ${device ?? 'unknown device'}`;

  let pending = 0;
  let syncing = false;
  let error = null;
  let conflicts = [];
  const resolutions = new Map();
  let running = null;
  let queued = null;
  let closed = false;
  let lock = Promise.resolve();

  const status = () => ({ pending, conflicts: conflicts.length, syncing, error });
  const announce = () => onStatus(status());

  // Writes from the app and the git steps that rewrite files take turns, so neither sees the other half done.
  function exclusive(fn) {
    const result = lock.then(fn);
    lock = result.catch(() => {});
    return result;
  }

  async function count() {
    try {
      const next = (await pendingFiles(git, target)).size;
      if (next !== pending) {
        pending = next;
        announce();
      }
    } catch {}
  }

  // A call while one runs waits for a fresh run after it, so its caller sees what is there now.
  function syncNow() {
    if (running) return (queued ??= running.then(() => {
      queued = null;
      return closed ? undefined : syncNow();
    }));
    running = (async () => {
      syncing = true;
      announce();
      try {
        const result = await syncRepo(git, target, { message, resolutions, exclusive });
        conflicts = result.conflicts;
        if (!conflicts.length) resolutions.clear();
        error = null;
      } catch (err) {
        error = err instanceof SyncError ? err.message : `同步失敗：${(err.stderr || err.message || String(err)).trim()}`;
      }
      await count();
      syncing = false;
      announce();
    })().finally(() => {
      running = null;
    });
    return running;
  }

  await count();
  syncNow();

  return {
    status,
    exclusive,
    syncNow,
    // Something in the data repo changed: it waits, counted, for the next sync.
    touched() {
      count();
    },
    conflicts(groupNames = new Map()) {
      return conflicts.map((c) => {
        const card = c.path.match(CARD_FILE);
        return {
          id: c.path,
          group: card?.[1] ?? null,
          groupName: card ? groupNames.get(card[1]) ?? card[1] : c.path,
          local: c.local,
          remote: c.remote,
          missingGroup: false,
        };
      });
    },
    conflictCardIds() {
      return conflicts.map((c) => c.path.match(CARD_FILE)?.[2]).filter(Boolean);
    },
    async resolve(file, use, raw) {
      const conflict = conflicts.find((c) => c.path === file);
      if (!conflict) throw new CardError(404, `${file} 沒有衝突`);
      if (use !== 'local' && use !== 'remote') throw new CardError(400, 'use 必須是 local 或 remote');
      if (use === 'local' && raw != null && CARD_FILE.test(file)) {
        const { errors } = parseCard(raw);
        if (errors.length) throw new CardError(400, `卡片格式錯誤：${errors.join('；')}`);
      }
      resolutions.set(file, { use, raw: use === 'local' && conflict.local !== null ? raw : undefined });
      conflicts = conflicts.filter((c) => c !== conflict);
      announce();
      if (!conflicts.length) await syncNow();
    },
    async close() {
      closed = true;
      await queued;
      await running;
    },
  };
}
