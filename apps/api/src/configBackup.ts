// Config backup to git (#149): keeps deploy/config-io/exports/ in the repo current with the live workspace.
// Every few minutes the YAML export of each kind is rendered. When it changed, it is committed to a backup
// branch and a "Config snapshot" PR into the base branch is opened or updated (the repo's PR rule applies).
// Without a token it still detects drift, so Settings shows that the repo copy is out of date.
import { createHash } from 'node:crypto';
import { Router } from 'express';
import { collection } from '../../../packages/core/src/db.js';
import { config } from '../../../packages/core/src/config.js';
import { HttpError, safeError } from '../../../packages/core/src/security.js';
import { OBJECT_KINDS, type ObjectKind } from '../../../packages/core/src/objectEnvelope.js';
import { exportObjects } from './objects.js';

/** One file per kind, matching deploy/config-io/config_io.py. */
export const BACKUP_FILES: Record<ObjectKind, string> = {
  Skill: 'skills.yaml',
  Agent: 'agents.yaml',
  Harness: 'harnesses.yaml',
  DatasetSync: 'dataset-syncs.yaml',
  Transform: 'transforms.yaml',
  CatalogEntry: 'catalog.yaml',
};
/** Older export files, removed from the repo once the new files are written. */
export const LEGACY_FILES = ['workflows.yaml', 'dataset-syncs.json'];

export type BackupState = {
  _id: string; // workspace (owner) id
  hash?: string; // of the last rendered files
  committedHash?: string; // of the files last pushed to the backup branch
  lastCheckedAt?: Date;
  lastChangeAt?: Date;
  lastCommitSha?: string;
  lastCommitAt?: Date;
  prUrl?: string;
  inSyncWithBase?: boolean;
  outOfSyncSince?: Date;
  lastError?: string;
  objects?: Record<string, number>;
};
const states = () => collection<BackupState>('config_backups');

export type BackupSettings = {
  token: string;
  repo: string;
  branch: string;
  base: string;
  path: string;
  fetchImpl?: typeof fetch;
};
const settingsFromConfig = (): BackupSettings => ({
  token: config.CONFIG_BACKUP_GITHUB_TOKEN,
  repo: config.CONFIG_BACKUP_REPO,
  branch: config.CONFIG_BACKUP_BRANCH,
  base: config.CONFIG_BACKUP_BASE,
  path: config.CONFIG_BACKUP_PATH.replace(/\/+$/, ''),
});
export const backupConfigured = (s: BackupSettings) => Boolean(s.token && s.repo);

/** The workspace to back up: explicit, else the first administrator's. */
export async function backupOwnerId(): Promise<string | undefined> {
  if (config.CONFIG_BACKUP_OWNER_ID) return config.CONFIG_BACKUP_OWNER_ID;
  const admin = await collection<{ _id: string; tenantId?: string; role: string; createdAt: Date }>('users')
    .find({ role: 'admin' })
    .sort({ createdAt: 1 })
    .limit(1)
    .next();
  return admin ? (admin.tenantId ?? admin._id) : undefined;
}

export async function renderBackupFiles(ownerId: string) {
  const files: Record<string, string> = {};
  const objects: Record<string, number> = {};
  for (const kind of OBJECT_KINDS) {
    const { yaml, count } = await exportObjects(ownerId, [kind]);
    files[BACKUP_FILES[kind]] = yaml;
    objects[kind] = count;
  }
  const hash = createHash('sha256')
    .update(
      Object.entries(files)
        .map(([n, c]) => `${n}\n${c}`)
        .join('\n\u0000'),
    )
    .digest('hex');
  return { files, objects, hash };
}

/** Minimal GitHub client for the git data API (blobs via tree content, commit, ref, PR). */
function github(s: BackupSettings) {
  const doFetch = s.fetchImpl ?? fetch;
  return async function call<T = any>(method: string, path: string, body?: unknown): Promise<T> {
    const res = await doFetch(`https://api.github.com/repos/${s.repo}${path}`, {
      method,
      headers: {
        Authorization: `Bearer ${s.token}`,
        Accept: 'application/vnd.github+json',
        'X-GitHub-Api-Version': '2022-11-28',
        'User-Agent': 'stockharness-config-backup',
        ...(body ? { 'Content-Type': 'application/json' } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(30000),
    });
    if (res.status === 404 && method === 'GET') return undefined as T;
    if (!res.ok)
      throw new Error(`GitHub ${method} ${path}: ${res.status} ${(await res.text()).slice(0, 200)}`);
    return (res.status === 204 ? undefined : await res.json()) as T;
  };
}

/** Commit `files` (and delete legacy files) on the backup branch; open or update the snapshot PR. */
export async function pushBackup(s: BackupSettings, files: Record<string, string>, summary: string) {
  const gh = github(s);
  const ref = await gh<{ object: { sha: string } }>('GET', `/git/ref/heads/${encodeURIComponent(s.branch)}`);
  let head = ref?.object.sha;
  if (!head) {
    const base = await gh<{ object: { sha: string } }>('GET', `/git/ref/heads/${encodeURIComponent(s.base)}`);
    if (!base) throw new Error(`Base branch ${s.base} not found in ${s.repo}`);
    await gh('POST', '/git/refs', { ref: `refs/heads/${s.branch}`, sha: base.object.sha });
    head = base.object.sha;
  }
  const headCommit = await gh<{ tree: { sha: string } }>('GET', `/git/commits/${head}`);
  const existing = await gh<{ tree: { path: string; type: string }[] }>(
    'GET',
    `/git/trees/${headCommit.tree.sha}?recursive=1`,
  );
  const present = new Set((existing?.tree ?? []).filter((e) => e.type === 'blob').map((e) => e.path));
  const entries = [
    ...Object.entries(files).map(([name, content]) => ({
      path: `${s.path}/${name}`,
      mode: '100644',
      type: 'blob',
      content,
    })),
    // Deleting a path that does not exist is an error, so only delete what is there.
    ...LEGACY_FILES.filter((n) => present.has(`${s.path}/${n}`)).map((n) => ({
      path: `${s.path}/${n}`,
      mode: '100644',
      type: 'blob',
      sha: null,
    })),
  ];
  const tree = await gh<{ sha: string }>('POST', '/git/trees', {
    base_tree: headCommit.tree.sha,
    tree: entries,
  });
  let commitSha: string | undefined;
  if (tree.sha !== headCommit.tree.sha) {
    const commit = await gh<{ sha: string }>('POST', '/git/commits', {
      message: `chore(config): snapshot of live configuration\n\n${summary}`,
      tree: tree.sha,
      parents: [head],
    });
    await gh('PATCH', `/git/refs/heads/${encodeURIComponent(s.branch)}`, { sha: commit.sha });
    commitSha = commit.sha;
  }
  // Is the backup branch different from the base for the exported files?
  const cmp = await gh<{ files?: { filename: string }[] }>(
    'GET',
    `/compare/${encodeURIComponent(s.base)}...${encodeURIComponent(s.branch)}`,
  );
  const differs = (cmp?.files ?? []).some((f) => f.filename.startsWith(`${s.path}/`));
  const owner = s.repo.split('/')[0];
  const open = await gh<{ html_url: string; number: number }[]>(
    'GET',
    `/pulls?state=open&head=${encodeURIComponent(`${owner}:${s.branch}`)}&base=${encodeURIComponent(s.base)}`,
  );
  let prUrl = open?.[0]?.html_url;
  if (differs && !prUrl) {
    const pr = await gh<{ html_url: string }>('POST', '/pulls', {
      title: 'Config snapshot: live configuration backup',
      head: s.branch,
      base: s.base,
      body:
        'Automatic backup of the live StockHarness configuration (#149): every object exported as ' +
        '`stockharness/v1` YAML into `' +
        s.path +
        '/`. References are by name; no secrets or data rows.\n\n' +
        summary +
        '\n\nMerge to keep `main` the recovery point. This PR is updated in place on every change.',
    });
    prUrl = pr.html_url;
  }
  return { commitSha, prUrl, inSyncWithBase: !differs };
}

let running = false;
/** Render, detect changes, and push when configured. Safe to call often; cheap when nothing changed. */
export async function runConfigBackup(
  opts: { force?: boolean; settings?: BackupSettings; ownerId?: string } = {},
) {
  if (running) return { skipped: 'already running' as const };
  running = true;
  try {
    const s = opts.settings ?? settingsFromConfig();
    const ownerId = opts.ownerId ?? (await backupOwnerId());
    if (!ownerId) return { skipped: 'no workspace' as const };
    const prev = (await states().findOne({ _id: ownerId })) ?? { _id: ownerId };
    const { files, objects, hash } = await renderBackupFiles(ownerId);
    const now = new Date();
    const changed = hash !== prev.hash;
    const set: Partial<BackupState> = {
      hash,
      objects,
      lastCheckedAt: now,
      ...(changed ? { lastChangeAt: now } : {}),
    };
    // Push when the files differ from what was last pushed, or on a forced (manual / daily) run.
    const due = hash !== prev.committedHash || opts.force;
    if (backupConfigured(s) && due) {
      try {
        const summary = Object.entries(objects)
          .map(([k, n]) => `- ${k}: ${n}`)
          .join('\n');
        const r = await pushBackup(s, files, summary);
        Object.assign(set, {
          committedHash: hash,
          ...(r.commitSha ? { lastCommitSha: r.commitSha, lastCommitAt: now } : {}),
          prUrl: r.prUrl,
          inSyncWithBase: r.inSyncWithBase,
          lastError: undefined,
        });
        if (r.inSyncWithBase) set.outOfSyncSince = undefined;
        else if (!prev.outOfSyncSince) set.outOfSyncSince = now;
      } catch (error) {
        set.lastError = safeError(error);
      }
    }
    const unset = Object.fromEntries(
      Object.entries(set)
        .filter(([, v]) => v === undefined)
        .map(([k]) => [k, '']),
    );
    const defined = Object.fromEntries(
      Object.entries(set).filter(([, v]) => v !== undefined),
    ) as Partial<BackupState>;
    await states().updateOne(
      { _id: ownerId },
      {
        $set: defined,
        ...(Object.keys(unset).length ? { $unset: unset as Record<keyof BackupState, ''> } : {}),
      },
      { upsert: true },
    );
    return {
      changed,
      pushed: Boolean(backupConfigured(s) && due),
      state: await states().findOne({ _id: ownerId }),
    };
  } finally {
    running = false;
  }
}

export async function backupStatus() {
  const s = settingsFromConfig();
  const ownerId = await backupOwnerId();
  const state = ownerId ? await states().findOne({ _id: ownerId }) : null;
  return {
    configured: backupConfigured(s),
    repo: s.repo || undefined,
    branch: s.branch,
    base: s.base,
    path: s.path,
    intervalMinutes: config.CONFIG_BACKUP_INTERVAL_MINUTES,
    workspace: ownerId,
    // Only knowable when connected: detect-only mode cannot see what the repo holds.
    pendingChanges: backupConfigured(s) && Boolean(state?.hash && state.hash !== state.committedHash),
    state,
  };
}

/** Mounted under /api with requireSession. */
export const configBackupRouter = Router();
configBackupRouter.get('/config-backup', async (_req, res) => res.json(await backupStatus()));
configBackupRouter.post('/config-backup/run', async (req, res) => {
  if (req.principal!.user.role !== 'admin')
    throw new HttpError(403, 'Only administrators can run the backup');
  await runConfigBackup({ force: true });
  res.json(await backupStatus());
});

let lastForced = 0;
/** Called from the server's dispatcher; runs every CONFIG_BACKUP_INTERVAL_MINUTES, forced once a day. */
export async function dispatchConfigBackup(nowMs = Date.now()) {
  const force = nowMs - lastForced > 24 * 3600 * 1000;
  if (force) lastForced = nowMs;
  await runConfigBackup({ force }).catch((e) => console.warn('Config backup failed:', safeError(e)));
}
