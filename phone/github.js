const API = 'https://api.github.com';

export class GitHubError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

export function textToBase64(text) {
  let binary = '';
  for (const byte of new TextEncoder().encode(text)) binary += String.fromCharCode(byte);
  return btoa(binary);
}

export function base64ToBytes(base64) {
  const binary = atob(base64.replace(/\s/g, ''));
  return Uint8Array.from(binary, (c) => c.charCodeAt(0));
}

const encodePath = (file) => file.split('/').map(encodeURIComponent).join('/');

// `repo` is "owner/name". Everything but blobs is read with no-store: GitHub lets browsers cache API responses for a minute,
// which would hide a push made a moment ago.
export function gitHub({ token, repo, fetch = globalThis.fetch.bind(globalThis) }) {
  async function call(method, path, body, cache = 'no-store') {
    const res = await fetch(`${API}/repos/${repo}${path}`, {
      method,
      cache,
      headers: {
        authorization: `Bearer ${token}`,
        accept: 'application/vnd.github+json',
        ...(body ? { 'content-type': 'application/json' } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
    });
    if (!res.ok) throw new GitHubError(res.status, (await res.json().catch(() => null))?.message ?? `GitHub 回應 ${res.status}`);
    return res.status === 204 ? null : res.json();
  }

  return {
    info: () => call('GET', ''),
    head: async (branch) => (await call('GET', `/git/ref/heads/${encodePath(branch)}`)).object.sha,
    // Only files: the paths and shas of every blob, plus the root tree that a new commit is built on.
    async tree(commit) {
      const tree = await call('GET', `/git/trees/${commit}?recursive=1`);
      if (tree.truncated) throw new GitHubError(500, 'repo 的檔案太多，GitHub 沒有回傳完整的檔案列表');
      return { sha: tree.sha, files: new Map(tree.tree.filter((e) => e.type === 'blob').map((e) => [e.path, e.sha])) };
    },
    // A blob's sha is its content, so a cached copy never goes stale.
    blob: async (sha) => base64ToBytes((await call('GET', `/git/blobs/${sha}`, undefined, 'force-cache')).content),
    // Without `sha` the file must not exist yet; with it, GitHub refuses (409) if the file has changed since.
    putFile: (file, text, { sha, branch, message }) =>
      call('PUT', `/contents/${encodePath(file)}`, { message, branch, content: textToBase64(text), ...(sha ? { sha } : {}) }),
    // One commit for several files. The branch moves only if nobody pushed since `parent` (422 otherwise).
    async commit({ branch, parent, baseTree, changes, message }) {
      const tree = await call('POST', '/git/trees', {
        base_tree: baseTree,
        tree: changes.map(({ path, text }) => (text === null
          ? { path, mode: '100644', type: 'blob', sha: null }
          : { path, mode: '100644', type: 'blob', content: text })),
      });
      const commit = await call('POST', '/git/commits', { message, tree: tree.sha, parents: [parent] });
      await call('PATCH', `/git/refs/heads/${encodePath(branch)}`, { sha: commit.sha, force: false });
      return commit.sha;
    },
  };
}
