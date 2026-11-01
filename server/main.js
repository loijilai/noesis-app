import { startServer } from './app.js';
import { dataPaths, loadConfig } from './config.js';
import { checkDevice } from './progress.js';

const port = Number(process.env.PORT ?? 4173);
const config = loadConfig();
const { deckDir, progressDir } = dataPaths(config);

const problem = checkDevice(config.device);
if (problem) {
  console.warn(`noesis: ${problem}，評分不會被記錄。範例：`);
  console.warn(`  ${JSON.stringify({ device: 'home-mac', dataDir: '../noesis' })}`);
}

const { url } = await startServer({ deckDir, progressDir, device: config.device, port });
console.log(`noesis: ${url}  (deck: ${deckDir}, progress: ${progressDir}, device: ${config.device ?? '未設定'})`);
