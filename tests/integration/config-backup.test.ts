// Config backup to git (#149), against real MongoDB (TEST_DIRECT_MONGODB_URI) and an in-memory fake GitHub.
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';

const DIRECT_MONGO = process.env.TEST_DIRECT_MONGODB_URI;
const skipReason = DIRECT_MONGO ? undefined : 'set TEST_DIRECT_MONGODB_URI (scripts/test-stack.sh does)';
if (DIRECT_MONGO) {
  process.env.MONGODB_URI = DIRECT_MONGO;
  process.env.MONGODB_DATABASE = 'agentic_direct_test';
}
process.env.ENCRYPTION_KEY ??= 'ab'.repeat(32);
process.env.SETUP_TOKEN ??= 'unit-test-setup-token'.repeat(3);
const { mongo, collection } = await import('../../packages/core/src/db.js');
const { saveResource } = await import('../../apps/api/src/resources.js');
const { runConfigBackup, renderBackupFiles } = await import('../../apps/api/src/configBackup.js');

const owner = `backup-${randomUUID()}`;
const who = { tenantId: owner, user: { _id: 'u', role: 'admin' } } as any;
const PATH = 'deploy/config-io/exports';

/** A tiny in-memory GitHub: commits are full snapshots {path: content}. */
function fakeGitHub(seed: Record<string, string>) {
  const commits = new Map<string, { tree: string; files: Record<string, string> }>();
  const trees = new Map<string, Record<string, string>>();
  const refs = new Map<string, string>();
  const pulls: { html_url: string; number: number; head: string; base: string }[] = [];
  const calls: string[] = [];
  const sha = (o: unknown) => createHash('sha1').update(JSON.stringify(o)).digest('hex');
  const addTree = (files: Record<string, string>) => {
    const sorted = Object.fromEntries(Object.entries(files).sort());
    const t = sha(sorted);
    trees.set(t, sorted);
    return t;
  };
  const addCommit = (files: Record<string, string>, parents: string[]) => {
    const tree = addTree(files);
    const c = sha({ tree, parents, n: commits.size });
    commits.set(c, { tree, files });
    return c;
  };
  refs.set('main', addCommit(seed, []));
  const json = (status: number, body?: unknown) =>
    new Response(body === undefined ? null : JSON.stringify(body), { status });
  const fetchImpl = (async (url: string, init: RequestInit = {}) => {
    const method = init.method ?? 'GET';
    const path = String(url).replace('https://api.github.com/repos/acme/repo', '');
    const body = init.body ? JSON.parse(String(init.body)) : undefined;
    calls.push(`${method} ${path.split('?')[0]}`);
    let m: RegExpMatchArray | null;
    if (method === 'GET' && (m = path.match(/^\/git\/ref\/heads\/(.+)$/))) {
      const s = refs.get(decodeURIComponent(m[1]));
      return s ? json(200, { object: { sha: s } }) : json(404, { message: 'Not Found' });
    }
    if (method === 'POST' && path === '/git/refs') {
      refs.set(body.ref.replace('refs/heads/', ''), body.sha);
      return json(201, {});
    }
    if (method === 'GET' && (m = path.match(/^\/git\/commits\/(\w+)$/)))
      return json(200, { tree: { sha: commits.get(m[1])!.tree } });
    if (method === 'GET' && (m = path.match(/^\/git\/trees\/(\w+)/)))
      return json(200, { tree: Object.keys(trees.get(m[1])!).map((p) => ({ path: p, type: 'blob' })) });
    if (method === 'POST' && path === '/git/trees') {
      const files = { ...trees.get(body.base_tree)! };
      for (const e of body.tree) {
        if (e.sha === null) delete files[e.path];
        else files[e.path] = e.content;
      }
      return json(201, { sha: addTree(files) });
    }
    if (method === 'POST' && path === '/git/commits') {
      const c = sha({ tree: body.tree, parents: body.parents, n: commits.size });
      commits.set(c, { tree: body.tree, files: trees.get(body.tree)! });
      return json(201, { sha: c });
    }
    if (method === 'PATCH' && (m = path.match(/^\/git\/refs\/heads\/(.+)$/))) {
      refs.set(decodeURIComponent(m[1]), body.sha);
      return json(200, {});
    }
    if (method === 'GET' && (m = path.match(/^\/compare\/(.+)\.\.\.(.+)$/))) {
      const a = commits.get(refs.get(decodeURIComponent(m[1]))!)!.files;
      const b = commits.get(refs.get(decodeURIComponent(m[2]))!)!.files;
      const changed = [...new Set([...Object.keys(a), ...Object.keys(b)])].filter((p) => a[p] !== b[p]);
      return json(200, { files: changed.map((filename) => ({ filename })) });
    }
    if (method === 'GET' && path.startsWith('/pulls'))
      return json(
        200,
        pulls.filter((p) => p.head === 'config-backup'),
      );
    if (method === 'POST' && path === '/pulls') {
      const pr = {
        html_url: `https://github.com/acme/repo/pull/${pulls.length + 1}`,
        number: pulls.length + 1,
        head: body.head,
        base: body.base,
      };
      pulls.push(pr);
      return json(201, pr);
    }
    return json(500, { message: `unhandled ${method} ${path}` });
  }) as unknown as typeof fetch;
  const branchFiles = () => commits.get(refs.get('config-backup')!)!.files;
  return { fetchImpl, calls, pulls, refs, branchFiles };
}
const settings = (gh: ReturnType<typeof fakeGitHub>) => ({
  token: 't',
  repo: 'acme/repo',
  branch: 'config-backup',
  base: 'main',
  path: PATH,
  fetchImpl: gh.fetchImpl,
});

before(async () => {
  if (!DIRECT_MONGO) return;
  await mongo.connect();
  await saveResource('skills', who, {
    name: 'pit-rules',
    description: 'PIT',
    instructions: 'Use acceptedDate.',
  });
});
after(async () => {
  if (!DIRECT_MONGO) return;
  for (const c of ['skills', 'skill_versions', 'config_backups', 'harness_events'])
    await collection<any>(c).deleteMany({ $or: [{ ownerId: owner }, { _id: owner }] });
  await mongo.close();
});

test('without a token it only detects changes', { skip: skipReason }, async () => {
  const r: any = await runConfigBackup({
    ownerId: owner,
    settings: { token: '', repo: '', branch: 'b', base: 'main', path: PATH },
  });
  assert.equal(r.pushed, false);
  assert.ok(r.state.hash && !r.state.committedHash, 'pending changes recorded');
});

test(
  'first push: branch from main, every kind written, legacy files removed, one snapshot PR',
  { skip: skipReason },
  async () => {
    const gh = fakeGitHub({
      [`${PATH}/dataset-syncs.json`]: '[]',
      [`${PATH}/workflows.yaml`]: '[]',
      'README.md': 'x',
    });
    const r: any = await runConfigBackup({ ownerId: owner, settings: settings(gh), force: true });
    assert.equal(r.pushed, true, JSON.stringify(r.state));
    const files = gh.branchFiles();
    const { files: expected } = await renderBackupFiles(owner);
    for (const [name, content] of Object.entries(expected)) assert.equal(files[`${PATH}/${name}`], content);
    assert.ok(
      !(`${PATH}/dataset-syncs.json` in files) && !(`${PATH}/workflows.yaml` in files),
      'legacy files deleted',
    );
    assert.equal(files['README.md'], 'x', 'other files untouched');
    assert.match(files[`${PATH}/skills.yaml`], /name: pit-rules/);
    assert.equal(gh.pulls.length, 1);
    assert.equal(r.state.prUrl, gh.pulls[0].html_url);
    assert.equal(r.state.inSyncWithBase, false);
    assert.ok(r.state.outOfSyncSince);

    // Nothing changed: no GitHub calls at all.
    const before = gh.calls.length;
    const again: any = await runConfigBackup({ ownerId: owner, settings: settings(gh) });
    assert.equal(again.pushed, false);
    assert.equal(gh.calls.length, before);

    // A change: one new commit on the branch, the same PR.
    await collection<any>('skills').updateOne(
      { ownerId: owner, name: 'pit-rules' },
      { $set: { instructions: 'Use acceptedDate, lag 45d.' } },
    );
    const head = gh.refs.get('config-backup');
    const changed: any = await runConfigBackup({ ownerId: owner, settings: settings(gh) });
    assert.equal(changed.changed, true);
    assert.notEqual(gh.refs.get('config-backup'), head);
    assert.match(gh.branchFiles()[`${PATH}/skills.yaml`], /lag 45d/);
    assert.equal(gh.pulls.length, 1, 'PR updated in place, not duplicated');

    // Forced run with nothing new: same tree, so no empty commit.
    const head2 = gh.refs.get('config-backup');
    await runConfigBackup({ ownerId: owner, settings: settings(gh), force: true });
    assert.equal(gh.refs.get('config-backup'), head2);
  },
);

test('GitHub errors are recorded, not thrown', { skip: skipReason }, async () => {
  const failing = {
    token: 't',
    repo: 'acme/repo',
    branch: 'config-backup',
    base: 'main',
    path: PATH,
    fetchImpl: (async () =>
      new Response('{"message":"Bad credentials"}', { status: 401 })) as unknown as typeof fetch,
  };
  const r: any = await runConfigBackup({ ownerId: owner, settings: failing, force: true });
  assert.match(r.state.lastError, /401/);
});
