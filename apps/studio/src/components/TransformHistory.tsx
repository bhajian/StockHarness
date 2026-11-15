// Transform versions (list, diff any two, restore, export with history) and run history (table, drawer with
// logs and DQ issues, backfill progress) for the transform editor (#96).
import React, { useEffect, useMemo, useState } from 'react';
import { Download, RotateCcw } from 'lucide-react';
import { stringify } from 'yaml';
import {
  type DqIssue,
  type Transform,
  type TransformRun,
  type TransformVersion,
  exportObjectsYaml,
  fetchTransformRun,
  fetchTransformRunDq,
  fetchTransformVersion,
  fetchTransformVersions,
  restoreTransformVersion,
  timestamp,
} from '../api';
import { Button } from './ui';
import { Drawer, Skeleton, StatusPill } from './kit';
import { PagedRows, rankOf, SortHead, useSort } from './tableKit';
import { CodeEditor } from '../editor/CodeEditor';

const fmtMs = (ms?: number) =>
  ms === undefined || ms === null
    ? '—'
    : ms < 1000
      ? `${ms} ms`
      : ms < 120000
        ? `${(ms / 1000).toFixed(1)} s`
        : `${Math.round(ms / 60000)} min`;
const sum = (o: Record<string, { written?: number; dq?: number }> | undefined, k: 'written' | 'dq') =>
  Object.values(o ?? {}).reduce((n, x) => n + (x[k] ?? 0), 0);
const sumReads = (r?: Record<string, number>) => Object.values(r ?? {}).reduce((n, x) => n + x, 0);

/** Progress of the newest backfill (a batch of yearly chunks), while it has chunks left. */
export function BackfillProgress({ runs }: { runs: TransformRun[] }) {
  const batchId = runs.find((r) => r.batchId)?.batchId;
  const batch = useMemo(
    () =>
      runs
        .filter((r) => r.batchId === batchId)
        .sort((a, b) => (a.window?.start ?? '').localeCompare(b.window?.start ?? '')),
    [runs, batchId],
  );
  if (!batchId || !batch.some((r) => ['queued', 'running'].includes(r.status))) return null;
  const done = batch.filter((r) => r.status === 'succeeded').length;
  const failed = batch.find((r) => r.status === 'failed');
  const current = batch.find((r) => r.status === 'running');
  const pct = Math.round((100 * done) / batch.length);
  return (
    <div className="backfill-progress" role="status">
      <div className="backfill-progress-head">
        <strong>Backfill</strong>
        <span>
          {done} of {batch.length} chunks ·{' '}
          {sum(Object.assign({}, ...batch.map((r) => r.outputs ?? {})), 'written').toLocaleString()} rows
          written
        </span>
        {current?.window && (
          <span className="muted-line">
            running {current.window.start} → {current.window.end}
          </span>
        )}
        {failed && (
          <StatusPill status="failed" label={`chunk ${failed.window?.start} failed; later chunks wait`} />
        )}
      </div>
      <div className="progress-track" aria-label={`${pct}%`}>
        <span style={{ width: `${pct}%` }} />
      </div>
    </div>
  );
}

export function RunHistory({ runs }: { runs: TransformRun[] }) {
  const [open, setOpen] = useState<TransformRun | null>(null);
  // Click a header to sort (#385); unsorted, newest first as the server sends them.
  const { sorted, sort, toggle } = useSort(runs, {
    started: { value: (r) => new Date(r.startedAt ?? r.createdAt), firstDesc: true },
    version: { value: (r) => r.version, firstDesc: true },
    trigger: { value: (r) => r.trigger },
    window: { value: (r) => r.window?.start ?? '' },
    status: { value: (r) => rankOf(['failed', 'running', 'queued', 'succeeded'])(r.status) },
    read: { value: (r) => sumReads(r.reads), firstDesc: true },
    written: { value: (r) => sum(r.outputs, 'written'), firstDesc: true },
    dq: { value: (r) => sum(r.outputs, 'dq') || null, firstDesc: true },
    duration: { value: (r) => r.durationMs, firstDesc: true },
  });
  if (!runs.length) return <p className="muted-line">No runs yet.</p>;
  return (
    <>
      <div className="table-wrap">
        <table className="run-history">
          <SortHead
            heads={[
              ['started', 'Started'],
              ['version', 'Version'],
              ['trigger', 'Trigger'],
              ['window', 'Window'],
              ['status', 'Status'],
              ['read', 'Read'],
              ['written', 'Written'],
              ['dq', 'DQ'],
              ['duration', 'Duration'],
            ]}
            sort={sort}
            toggle={toggle}
          />
          <tbody>
            <PagedRows rows={sorted} resetKey={sort}>
              {(r) => (
                <tr
                  key={r.id}
                  className="clickable"
                  onClick={() => setOpen(r)}
                  tabIndex={0}
                  onKeyDown={(e) => e.key === 'Enter' && setOpen(r)}
                >
                  <td>{timestamp(r.startedAt ?? r.createdAt)}</td>
                  <td>v{r.version}</td>
                  <td>{r.trigger}</td>
                  <td>{r.window ? `${r.window.start} → ${r.window.end}` : 'full'}</td>
                  <td>
                    <StatusPill status={r.status} />
                  </td>
                  <td>{sumReads(r.reads).toLocaleString()}</td>
                  <td>{sum(r.outputs, 'written').toLocaleString()}</td>
                  <td>{sum(r.outputs, 'dq') || '—'}</td>
                  <td>{fmtMs(r.durationMs)}</td>
                </tr>
              )}
            </PagedRows>
          </tbody>
        </table>
      </div>
      {open && <RunDrawer run={open} onClose={() => setOpen(null)} />}
    </>
  );
}

function RunDrawer({ run, onClose }: { run: TransformRun; onClose: () => void }) {
  const [detail, setDetail] = useState<TransformRun | null>(null);
  const [dq, setDq] = useState<DqIssue[] | null>(null);
  useEffect(() => {
    void fetchTransformRun(run.id).then(setDetail, () => setDetail(run));
    void fetchTransformRunDq(run.id).then(setDq, () => setDq([]));
  }, [run]);
  const r = detail ?? run;
  return (
    <Drawer title={`Run ${r.transformName} v${r.version}`} onClose={onClose}>
      <div className="run-drawer">
        <p>
          <StatusPill status={r.status} /> {r.trigger} · {timestamp(r.startedAt ?? r.createdAt)} ·{' '}
          {fmtMs(r.durationMs)}
          {r.window
            ? ` · ${r.window.start} → ${r.window.end} (lookback from ${r.window.lookback_start})`
            : ''}
        </p>
        {r.error && <div className="notice error">{r.error}</div>}
        <h4>Outputs</h4>
        <OutputsTable run={r} />
        <h4>DQ issues{dq ? ` (${dq.length})` : ''}</h4>
        {!dq ? <Skeleton rows={2} /> : !dq.length ? <p className="muted-line">None.</p> : <DqTable dq={dq} />}
        <h4>stdout</h4>
        <pre className="run-log">{detail ? detail.stdout || '(empty)' : '…'}</pre>
        <h4>stderr</h4>
        <pre className="run-log">{detail ? detail.stderr || '(empty)' : '…'}</pre>
      </div>
    </Drawer>
  );
}

/** Settings of a version without its code, as YAML (for the settings diff). */
const settingsYaml = (spec?: TransformVersion['spec']) => {
  if (!spec) return '';
  const { code: _c, ...rest } = spec;
  return stringify(rest);
};

export function VersionsPanel({
  transform,
  isAdmin,
  onRestored,
}: {
  transform: Transform;
  isAdmin: boolean;
  onRestored: (t: Transform, from: number) => Promise<void>;
}) {
  const [versions, setVersions] = useState<TransformVersion[] | null>(null);
  const [a, setA] = useState(Math.max(1, transform.version - 1));
  const [b, setB] = useState(transform.version);
  const [specs, setSpecs] = useState<Record<number, TransformVersion['spec']>>({});
  const [what, setWhat] = useState<'code' | 'settings'>('code');
  const [error, setError] = useState('');
  useEffect(() => {
    void fetchTransformVersions(transform.id).then(setVersions, (e) => setError(String(e)));
    setA(Math.max(1, transform.version - 1));
    setB(transform.version);
  }, [transform.id, transform.version]);
  useEffect(() => {
    for (const v of [a, b])
      if (!specs[v])
        void fetchTransformVersion(transform.id, v).then(
          (r) => setSpecs((s) => ({ ...s, [v]: r.spec })),
          () => undefined,
        );
  }, [a, b, specs, transform.id]);
  const versionSort = useSort(versions ?? [], {
    version: { value: (v) => v.version, firstDesc: true },
    saved: { value: (v) => new Date(v.createdAt), firstDesc: true },
    note: { value: (v) => v.note },
  });
  async function restore(v: number) {
    if (!confirm(`Restore v${v}? This saves its content as a new version (v${transform.version + 1}).`))
      return;
    try {
      const t = await restoreTransformVersion(transform.id, v);
      await onRestored(t, v);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }
  async function exportHistory() {
    const text = await exportObjectsYaml(['Transform'], [transform.name], true);
    const url = URL.createObjectURL(new Blob([text], { type: 'application/yaml' }));
    const link = Object.assign(document.createElement('a'), {
      href: url,
      download: `stockharness-${transform.name}-history-${new Date().toISOString().slice(0, 10)}.yaml`,
    });
    link.click();
    URL.revokeObjectURL(url);
  }
  if (!versions) return error ? <div className="notice error">{error}</div> : <Skeleton rows={3} />;
  const sa = specs[a];
  const sb = specs[b];
  const options = versions.map((v) => (
    <option key={v.version} value={v.version}>
      v{v.version}
      {v.version === transform.version ? ' (current)' : ''}
    </option>
  ));
  return (
    <div className="versions-panel">
      {error && <div className="notice error">{error}</div>}
      <div className="versions-list">
        <table>
          <SortHead
            heads={[
              ['version', 'Version'],
              ['saved', 'Saved'],
              ['note', 'Note'],
            ]}
            sort={versionSort.sort}
            toggle={versionSort.toggle}
            extra={<th />}
          />
          <tbody>
            <PagedRows rows={versionSort.sorted} resetKey={versionSort.sort}>
              {(v) => (
                <tr key={v.version} className={v.version === a || v.version === b ? 'selected' : ''}>
                  <td>
                    <strong>v{v.version}</strong>
                    {v.version === transform.version && <StatusPill status="ok" label="current" />}
                  </td>
                  <td>{timestamp(v.createdAt)}</td>
                  <td>{v.note ?? ''}</td>
                  <td className="row-actions">
                    {isAdmin && v.version !== transform.version && (
                      <Button
                        variant="ghost"
                        onClick={() => void restore(v.version)}
                        title={`Save v${v.version} as a new version`}
                      >
                        <RotateCcw size={14} /> Restore
                      </Button>
                    )}
                  </td>
                </tr>
              )}
            </PagedRows>
          </tbody>
        </table>
        <Button
          variant="secondary"
          onClick={() => void exportHistory()}
          title="YAML with every version; an import restores them"
        >
          <Download size={15} /> Export with history
        </Button>
      </div>
      <div className="versions-diff">
        <CodeEditor
          language={what === 'code' ? 'python' : 'yaml'}
          original={what === 'code' ? (sa?.code ?? '') : settingsYaml(sa)}
          value={what === 'code' ? (sb?.code ?? '') : settingsYaml(sb)}
          height={360}
          readOnly
          toolbar={
            <>
              <label>
                Compare{' '}
                <select
                  aria-label="Diff from version"
                  value={a}
                  onChange={(e) => setA(Number(e.target.value))}
                >
                  {options}
                </select>
              </label>
              <label>
                with{' '}
                <select aria-label="Diff to version" value={b} onChange={(e) => setB(Number(e.target.value))}>
                  {options}
                </select>
              </label>
              <span className="tabs compact" role="tablist">
                {(['code', 'settings'] as const).map((w) => (
                  <button
                    key={w}
                    role="tab"
                    aria-selected={what === w}
                    className={what === w ? 'active' : ''}
                    onClick={() => setWhat(w)}
                  >
                    {w === 'code' ? 'Code' : 'Settings'}
                  </button>
                ))}
              </span>
            </>
          }
        />
      </div>
    </div>
  );
}

function OutputsTable({ run: r }: { run: TransformRun }) {
  const rows = [...new Set([...Object.keys(r.reads ?? {}), ...Object.keys(r.outputs ?? {})])].map((c) => ({
    c,
    read: r.reads?.[c],
    written: r.outputs?.[c]?.written,
    unchanged: r.outputs?.[c]?.unchanged,
    dq: r.outputs?.[c]?.dq,
  }));
  const { sorted, sort, toggle } = useSort(rows, {
    collection: { value: (x) => x.c },
    read: { value: (x) => x.read, firstDesc: true },
    written: { value: (x) => x.written, firstDesc: true },
    unchanged: { value: (x) => x.unchanged, firstDesc: true },
    dq: { value: (x) => x.dq || null, firstDesc: true },
  });
  return (
    <table>
      <SortHead
        heads={[
          ['collection', 'Collection'],
          ['read', 'Read'],
          ['written', 'Written'],
          ['unchanged', 'Unchanged'],
          ['dq', 'DQ'],
        ]}
        sort={sort}
        toggle={toggle}
      />
      <tbody>
        <PagedRows rows={sorted} resetKey={sort}>
          {(x) => (
            <tr key={x.c}>
              <td>
                <code>{x.c}</code>
              </td>
              <td>{x.read?.toLocaleString() ?? '—'}</td>
              <td>{x.written?.toLocaleString() ?? '—'}</td>
              <td>{x.unchanged?.toLocaleString() ?? '—'}</td>
              <td>{x.dq || '—'}</td>
            </tr>
          )}
        </PagedRows>
      </tbody>
    </table>
  );
}

function DqTable({ dq }: { dq: DqIssue[] }) {
  const { sorted, sort, toggle } = useSort(dq, {
    issue: { value: (d) => d.issue_type },
    severity: { value: (d) => rankOf(['error', 'warn', 'info'])(d.severity) },
    collection: { value: (d) => d.collection },
    symbol: { value: (d) => d.security_id },
    date: { value: (d) => d.date },
  });
  return (
    <table>
      <SortHead
        heads={[
          ['issue', 'Issue'],
          ['severity', 'Severity'],
          ['collection', 'Collection'],
          ['symbol', 'Symbol'],
          ['date', 'Date'],
        ]}
        sort={sort}
        toggle={toggle}
      />
      <tbody>
        <PagedRows rows={sorted} resetKey={sort}>
          {(d, i) => (
            <tr key={i}>
              <td>{d.issue_type}</td>
              <td>{d.severity}</td>
              <td>
                <code>{d.collection}</code>
              </td>
              <td>{d.security_id ?? '—'}</td>
              <td>{d.date ?? '—'}</td>
            </tr>
          )}
        </PagedRows>
      </tbody>
    </table>
  );
}
