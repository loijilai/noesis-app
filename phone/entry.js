import './polyfills.js';
import { forgetSettings, loadSettings, saveSettings, start } from './backend.js';
import { askForToken, showLoading } from './setup.js';

const app = document.getElementById('app');
let settings = loadSettings();
let problem;
for (;;) {
  settings ??= await askForToken(app, problem);
  try {
    await start(settings, showLoading(app));
    break;
  } catch (err) {
    if (err.status !== 401 && err.status !== 404) {
      app.replaceChildren(Object.assign(document.createElement('p'), { className: 'errors', textContent: `載入失敗：${err.message}` }));
      throw err;
    }
    forgetSettings();
    settings = null;
    problem = 'token 不對、已經失效，或沒有這個 repo 的權限';
  }
}
saveSettings(settings);
await import('../public/app.js');
