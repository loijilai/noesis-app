import { gitHub } from './github.js';

const el = (tag, attrs = {}, ...children) => {
  const node = Object.assign(document.createElement(tag), attrs);
  node.append(...children.filter(Boolean));
  return node;
};

export function showLoading(app) {
  const status = el('p', { className: 'muted' }, '從 GitHub 載入卡片…');
  app.replaceChildren(el('section', { className: 'card-featured' }, status));
  return (done, total) => {
    status.textContent = `從 GitHub 載入卡片… ${done} / ${total}`;
  };
}

// Resolves with the settings once a token has been shown to reach the repo.
export function askForToken(app, problem) {
  return new Promise((resolve) => {
    const repo = el('input', { name: 'repo', placeholder: 'owner/repo', autocapitalize: 'off', autocomplete: 'off', spellcheck: false, required: true });
    const token = el('input', { name: 'token', type: 'password', placeholder: 'github_pat_…', autocomplete: 'off', required: true });
    const message = el('p', { className: 'errors' }, problem ?? '');
    const button = el('button', { className: 'primary', type: 'submit' }, '連接');
    const form = el('form', {
      className: 'card-featured setup',
      onsubmit: async (e) => {
        e.preventDefault();
        message.textContent = '';
        button.disabled = true;
        const settings = { repo: repo.value.trim(), token: token.value.trim() };
        try {
          const info = await gitHub(settings).info();
          resolve({ ...settings, branch: info.default_branch });
        } catch (err) {
          message.textContent = err.status === 401 ? 'token 不對或已經失效' : err.status === 404 ? '找不到這個 repo，或 token 沒有開它的權限' : err.message;
          button.disabled = false;
        }
      },
    },
    el('h2', {}, '連接卡片的 repo'),
    el('p', { className: 'muted' }, '輸入放卡片的 GitHub repo 和 fine-grained token（只開這個 repo，Contents 設為 Read and write）。token 只存在這支手機的瀏覽器裡。'),
    el('label', {}, 'Repo', repo),
    el('label', {}, 'Token', token),
    button,
    message);
    app.replaceChildren(form);
    repo.focus();
  });
}
