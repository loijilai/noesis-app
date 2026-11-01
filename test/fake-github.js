// An in-memory GitHub that answers the calls phone/github.js makes, with the same refusals for stale shas.
import { createHash } from 'node:crypto';

const blobSha = (bytes) => createHash('sha1').update(`blob ${bytes.length}\0`).update(bytes).digest('hex');
const json = (status, body) => new Response(body === undefined ? null : JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

export function fakeGitHub(initial, { branch = 'master' } = {}) {
  const blobs = new Map();
  const trees = new Map();
  const commits = new Map();
  const refs = new Map();
  const calls = [];
  let n = 0;

  const putBlob = (bytes) => {
    const sha = blobSha(bytes);
    blobs.set(sha, bytes);
    return sha;
  };
  const putTree = (files) => {
    const sha = `tree${++n}`;
    trees.set(sha, new Map(files));
    return sha;
  };
  const putCommit = (tree, parents, message) => {
    const sha = `commit${++n}`;
    commits.set(sha, { tree, parents, message });
    return sha;
  };
  const filesAt = (commit) => trees.get(commits.get(commit).tree);
  const isAncestor = (a, b) => a === b || (commits.get(b)?.parents ?? []).some((p) => isAncestor(a, p));

  const root = putTree(Object.entries(initial).map(([p, t]) => [p, putBlob(Buffer.from(t))]));
  refs.set(branch, putCommit(root, [], 'init'));

  // Commits made outside the phone, as a push from the desktop would.
  function push(changes, message = 'desktop') {
    const files = new Map(filesAt(refs.get(branch)));
    for (const [p, t] of Object.entries(changes)) {
      if (t === null) files.delete(p);
      else files.set(p, putBlob(Buffer.from(t)));
    }
    refs.set(branch, putCommit(putTree(files), [refs.get(branch)], message));
  }

  function read(p) {
    const sha = filesAt(refs.get(branch)).get(p);
    return sha === undefined ? undefined : Buffer.from(blobs.get(sha)).toString('utf8');
  }

  async function fetch(url, { method = 'GET', body } = {}) {
    const { pathname, searchParams } = new URL(url);
    const rest = decodeURIComponent(pathname.replace(/^\/repos\/[^/]+\/[^/]+/, ''));
    const data = body ? JSON.parse(body) : undefined;
    calls.push(`${method} ${rest}`);
    let m;
    if (method === 'GET' && rest === '') return json(200, { default_branch: branch });
    if (method === 'GET' && (m = rest.match(/^\/git\/ref\/heads\/(.+)$/))) return json(200, { object: { sha: refs.get(m[1]) } });
    if (method === 'GET' && (m = rest.match(/^\/git\/trees\/(.+)$/))) {
      const tree = commits.get(m[1])?.tree ?? m[1];
      if (!searchParams.has('recursive')) return json(400);
      return json(200, { sha: tree, truncated: false, tree: [...trees.get(tree)].map(([path, sha]) => ({ path, sha, type: 'blob', mode: '100644' })) });
    }
    if (method === 'GET' && (m = rest.match(/^\/git\/blobs\/(.+)$/))) return json(200, { content: Buffer.from(blobs.get(m[1])).toString('base64'), encoding: 'base64' });
    if (method === 'PUT' && (m = rest.match(/^\/contents\/(.+)$/))) {
      const files = new Map(filesAt(refs.get(data.branch)));
      const current = files.get(m[1]);
      if (current !== undefined && data.sha === undefined) return json(422, { message: '"sha" wasn\'t supplied.' });
      if (current !== data.sha) return json(409, { message: 'does not match' });
      const sha = putBlob(Buffer.from(data.content, 'base64'));
      files.set(m[1], sha);
      const commit = putCommit(putTree(files), [refs.get(data.branch)], data.message);
      refs.set(data.branch, commit);
      return json(200, { content: { sha }, commit: { sha: commit } });
    }
    if (method === 'POST' && rest === '/git/trees') {
      const files = new Map(trees.get(data.base_tree));
      for (const e of data.tree) {
        if (e.sha === null) files.delete(e.path);
        else files.set(e.path, putBlob(Buffer.from(e.content)));
      }
      return json(201, { sha: putTree(files) });
    }
    if (method === 'POST' && rest === '/git/commits') return json(201, { sha: putCommit(data.tree, data.parents, data.message) });
    if (method === 'PATCH' && (m = rest.match(/^\/git\/refs\/heads\/(.+)$/))) {
      if (!data.force && !isAncestor(refs.get(m[1]), data.sha)) return json(422, { message: 'Update is not a fast forward' });
      refs.set(m[1], data.sha);
      return json(200, { object: { sha: data.sha } });
    }
    return json(404, { message: `fake: ${method} ${rest}` });
  }

  return { fetch, push, read, calls, log: () => {
    const out = [];
    for (let c = refs.get(branch); c; c = commits.get(c).parents[0]) out.push(commits.get(c).message);
    return out;
  } };
}
