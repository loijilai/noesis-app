import { startServer } from './app.js';
import { dataPaths, loadConfig } from './config.js';
import { isDataRepo } from './git-sync.js';
import { checkDevice } from './progress.js';

const port = Number(process.env.PORT ?? 4173);
const config = loadConfig();
const { dataDir, deckDir, progressDir } = dataPaths(config);

const problem = checkDevice(config.device);
if (problem) {
  console.warn(`noesis: ${problem}，評分不會被記錄。範例：`);
  console.warn(`  ${JSON.stringify({ device: 'home-mac', dataDir: '../noesis' })}`);
}

const autoSync = config.autoSync !== false && isDataRepo(dataDir) ? { dataDir } : null;
const { url, sync, close } = await startServer({ deckDir, progressDir, device: config.device, port, autoSync });
console.log(`noesis: ${url}  (deck: ${deckDir}, progress: ${progressDir}, device: ${config.device ?? '未設定'}, 自動同步: ${sync ? '開' : '關'})`);

// What changed since the last push goes out before the app stops.
for (const signal of ['SIGINT', 'SIGTERM']) {
  process.once(signal, async () => {
    if (sync && !sync.status().conflicts && sync.status().pending) {
      console.log('noesis: 關閉前同步中…');
      await sync.syncNow();
    }
    await close();
    process.exit(0);
  });
}
