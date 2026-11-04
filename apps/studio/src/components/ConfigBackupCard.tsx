import React, { useEffect, useState } from 'react';
import { GitBranch, RefreshCw } from 'lucide-react';
import { fetchConfigBackup, runConfigBackupNow, timestamp, type ConfigBackupStatus } from '../api';
import { Button, Status } from './ui';

/** Settings -> Configuration: the git backup of the workspace configuration (#149). */
export function ConfigBackupCard({ isAdmin }: { isAdmin: boolean }) {
  const [status, setStatus] = useState<ConfigBackupStatus | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  useEffect(() => {
    fetchConfigBackup()
      .then(setStatus)
      .catch((e) => setError(String(e)));
  }, []);
  if (!status) return error ? <div className="notice error">{error}</div> : null;
  const st = status.state ?? {};
  const stale = st.outOfSyncSince && Date.now() - new Date(st.outOfSyncSince).getTime() > 24 * 3600 * 1000;
  const pill = !status.configured
    ? 'disabled'
    : st.lastError
      ? 'failed'
      : st.inSyncWithBase
        ? 'fresh'
        : stale
          ? 'stale'
          : 'queued';
  const label = !status.configured
    ? 'not connected'
    : st.lastError
      ? 'failed'
      : st.inSyncWithBase
        ? `in sync with ${status.base}`
        : 'snapshot PR open';
  return (
    <div className="config-backup-card">
      <div className="config-backup-head">
        <GitBranch size={18} />
        <strong>Backup to git</strong>
        <Status status={pill} />
        <span className="config-backup-label">{label}</span>
      </div>
      {!status.configured ? (
        <p className="field-help">
          Not connected: changes are detected (see Last change) but not pushed. Set{' '}
          <code>CONFIG_BACKUP_REPO</code> and a GitHub token in the <code>openharness-config-backup</code>{' '}
          secret (<code>CONFIG_BACKUP_GITHUB_TOKEN</code>, contents and pull-request write on the repo) to
          commit every change to <code>{status.branch}</code> and keep a snapshot PR into{' '}
          <code>{status.base}</code> open.
        </p>
      ) : (
        <p className="field-help">
          Every {status.intervalMinutes} minutes, changed objects are committed to <code>{status.repo}</code>{' '}
          branch <code>{status.branch}</code> under <code>{status.path}/</code>, and a snapshot PR into{' '}
          <code>{status.base}</code> is kept up to date. Merge it to make <code>{status.base}</code> the
          recovery point.
        </p>
      )}
      <dl className="config-backup-facts">
        <dt>Last checked</dt>
        <dd>{st.lastCheckedAt ? timestamp(st.lastCheckedAt) : '—'}</dd>
        <dt>Last change</dt>
        <dd>{st.lastChangeAt ? timestamp(st.lastChangeAt) : '—'}</dd>
        <dt>Last commit</dt>
        <dd>
          {st.lastCommitSha && status.repo ? (
            <a
              href={`https://github.com/${status.repo}/commit/${st.lastCommitSha}`}
              target="_blank"
              rel="noreferrer"
            >
              {st.lastCommitSha.slice(0, 7)}
            </a>
          ) : (
            '—'
          )}
          {st.lastCommitAt ? ` · ${timestamp(st.lastCommitAt)}` : ''}
        </dd>
        <dt>Snapshot PR</dt>
        <dd>
          {st.prUrl ? (
            <a href={st.prUrl} target="_blank" rel="noreferrer">
              {st.prUrl.replace(/^https:\/\/github.com\//, '')}
            </a>
          ) : (
            '—'
          )}
        </dd>
        <dt>Objects</dt>
        <dd>
          {st.objects
            ? Object.entries(st.objects)
                .map(([k, n]) => `${n} ${k}`)
                .join(' · ')
            : '—'}
        </dd>
      </dl>
      {st.lastError && <div className="notice error">{st.lastError}</div>}
      {stale && (
        <div className="notice">
          The repo's {status.base} has been behind the live configuration for over a day.
        </div>
      )}
      {error && <div className="notice error">{error}</div>}
      {isAdmin && (
        <Button
          variant="secondary"
          disabled={busy}
          onClick={async () => {
            setBusy(true);
            setError('');
            try {
              setStatus(await runConfigBackupNow());
            } catch (e) {
              setError(e instanceof Error ? e.message : String(e));
            } finally {
              setBusy(false);
            }
          }}
        >
          <RefreshCw size={15} className={busy ? 'spin' : ''} /> Back up now
        </Button>
      )}
    </div>
  );
}
