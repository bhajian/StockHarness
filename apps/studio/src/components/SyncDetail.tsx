// Dataset sync detail page (#76) at /datasets/syncs/:id: Source, Symbols, Runs (FMP calls, per-symbol errors),
// History & backfill, Schedule (next run times) and Data, plus a link to the collection's Catalog page.
import React, { useEffect, useMemo, useState } from 'react';
import { ArrowLeft, BookOpen, Pencil, Play } from 'lucide-react';
import {
  type DatasetCatalogItem,
  type DatasetSyncRun,
  type Entity,
  fetchSyncRuns,
  fetchSyncSymbols,
  timestamp,
} from '../api';
import { describeSchedule, nextRunTimes } from '../../../../packages/core/src/schedule.js';
import type { Schedule } from '../../../../packages/core/src/schema.js';
import type { DatasetsRoute } from '../datasetsRoute';
import { Button } from './ui';
import { Drawer, Skeleton, StatusPill, Tabs } from './kit';
import { DataGrid } from './DataGrid';
import { fmtNumber } from '../charts/chartData';

type Tab = 'source' | 'symbols' | 'runs' | 'history' | 'schedule' | 'data';
const dur = (a?: string, b?: string) => {
  if (!a || !b) return '—';
  const ms = Date.parse(b) - Date.parse(a);
  return ms < 120000 ? `${Math.round(ms / 1000)} s` : `${Math.round(ms / 60000)} min`;
};

export function SyncDetail({
  sync,
  def,
  mongoId,
  isAdmin,
  go,
  onEdit,
  onRun,
  backfill,
}: {
  sync: Entity;
  def?: DatasetCatalogItem;
  mongoId?: string;
  isAdmin: boolean;
  go: (r: DatasetsRoute) => void;
  onEdit: () => void;
  onRun: () => void;
  backfill: React.ReactNode;
}) {
  const [tab, setTab] = useState<Tab>('source');
  const [runs, setRuns] = useState<DatasetSyncRun[] | null>(null);
  const [symbols, setSymbols] = useState<Awaited<ReturnType<typeof fetchSyncSymbols>> | null>(null);
  const [open, setOpen] = useState<DatasetSyncRun | null>(null);
  useEffect(() => {
    void fetchSyncRuns(sync.id).then(setRuns, () => setRuns([]));
    void fetchSyncSymbols(sync.id).then(setSymbols, () => undefined);
  }, [sync.id, sync.lastRunAt]);
  const collection = (sync.targetCollection as string) || def?.defaultCollection || '';
  const schedule = sync.schedule as Schedule | undefined;
  const upcoming = useMemo(() => nextRunTimes(schedule), [schedule]);
  const status = sync.running
    ? 'running'
    : sync.queued
      ? 'queued'
      : sync.enabled
        ? sync.lastError
          ? 'failed'
          : 'ready'
        : 'disabled';
  const history = sync.historyPeriods
    ? `${sync.historyPeriods} periods`
    : sync.from
      ? `from ${String(sync.from)}`
      : def?.defaultHistoryPeriods
        ? `${def.defaultHistoryPeriods} periods (default)`
        : 'incremental from the last cursor';
  return (
    <div className="sync-detail">
      <div className="transform-editor-head">
        <Button variant="ghost" onClick={() => go({ tab: 'syncs' })}>
          <ArrowLeft size={16} /> Syncs
        </Button>
        <h2>{sync.name}</h2>
        <StatusPill status={status} />
        <span className="muted-line">
          {def?.label ?? String(sync.dataset)} · last run{' '}
          {sync.lastRunAt ? timestamp(sync.lastRunAt as string) : 'never'}
          {sync.nextRunAt ? ` · next ${timestamp(sync.nextRunAt as string)}` : ''}
        </span>
        <div className="transform-editor-actions">
          <Button
            variant="secondary"
            onClick={() => go({ tab: 'catalog', item: collection })}
            title="Schema, coverage and caveats"
          >
            <BookOpen size={15} /> Catalog
          </Button>
          {isAdmin && (
            <Button variant="secondary" onClick={onRun}>
              <Play size={15} /> Run now
            </Button>
          )}
          {isAdmin && (
            <Button onClick={onEdit}>
              <Pencil size={15} /> Edit
            </Button>
          )}
        </div>
      </div>
      {sync.lastError && <div className="notice error">{String(sync.lastError)}</div>}
      <Tabs
        tabs={[
          { id: 'source', label: 'Source' },
          { id: 'symbols', label: 'Symbols' },
          { id: 'runs', label: `Runs${runs ? ` (${runs.length})` : ''}` },
          { id: 'history', label: 'History & backfill' },
          { id: 'schedule', label: 'Schedule' },
          { id: 'data', label: 'Data' },
        ]}
        value={tab}
        onChange={setTab}
      />
      {tab === 'source' ? (
        <dl className="collection-facts sync-facts">
          <dt>Dataset</dt>
          <dd>
            {def?.label ?? String(sync.dataset)} <span className="muted-line">({def?.category})</span>
          </dd>
          <dt>Endpoint</dt>
          <dd>
            <code>{def?.endpoint ?? '—'}</code>
          </dd>
          <dt>Target collection</dt>
          <dd>
            <button className="link-button" onClick={() => go({ tab: 'catalog', item: collection })}>
              <code>{collection}</code>
            </button>
          </dd>
          <dt>Key fields</dt>
          <dd>
            {(def?.keyFields ?? []).map((k) => (
              <code key={k}>{k}</code>
            ))}
            {def?.appendOnly && <StatusPill status="outline" label="append-only" />}
          </dd>
          <dt>Date field</dt>
          <dd>{def?.dateField ? <code>{def.dateField}</code> : '—'}</dd>
          <dt>History</dt>
          <dd>{history}</dd>
          <dt>Priority</dt>
          <dd>
            {String(sync.effectivePriority ?? '—')}
            {!sync.priority && <span className="muted-line"> (dataset default)</span>}
          </dd>
          <dt>Retention</dt>
          <dd>{sync.retentionDays ? `${sync.retentionDays} days` : 'keep everything'}</dd>
          <dt>Description</dt>
          <dd>{def?.description}</dd>
        </dl>
      ) : tab === 'symbols' ? (
        !symbols ? (
          <Skeleton rows={3} />
        ) : (
          <div className="sync-symbols">
            <p>
              <strong>
                {symbols.count === null ? 'Resolved at run time' : `${fmtNumber(symbols.count)} symbols`}
                {symbols.delisted ? ` incl. ${fmtNumber(symbols.delisted)} delisted` : ''}
              </strong>{' '}
              <span className="muted-line">
                {symbols.mode === 'universe'
                  ? 'from the sync universe (active screener names + delisted companies)'
                  : symbols.mode === 'preset'
                    ? `preset ${symbols.preset}. ${symbols.note ?? ''}`
                    : 'an explicit list'}
              </span>
            </p>
            {symbols.lastRun && (
              <p className="muted-line">
                Last run covered {fmtNumber(symbols.lastRun.covered ?? 0)} of{' '}
                {fmtNumber(symbols.lastRun.attempted ?? 0)} symbols ({timestamp(symbols.lastRun.at)})
              </p>
            )}
            {symbols.sample?.length ? (
              <p className="chips">
                {symbols.sample.map((s) => (
                  <code key={s} className="chip">
                    {s}
                  </code>
                ))}
                {(symbols.count ?? 0) > symbols.sample.length && <span className="muted-line">…</span>}
              </p>
            ) : null}
          </div>
        )
      ) : tab === 'runs' ? (
        !runs ? (
          <Skeleton rows={4} />
        ) : !runs.length ? (
          <p className="muted-line">No runs yet.</p>
        ) : (
          <div className="table-wrap">
            <table className="run-history">
              <thead>
                <tr>
                  <th>Started</th>
                  <th>Trigger</th>
                  <th>Duration</th>
                  <th>Status</th>
                  <th>Rows</th>
                  <th>FMP calls</th>
                  <th>Symbols</th>
                  <th>Errors</th>
                </tr>
              </thead>
              <tbody>
                {runs.map((r) => (
                  <tr
                    key={r.id}
                    className="clickable"
                    tabIndex={0}
                    onClick={() => setOpen(r)}
                    onKeyDown={(e) => e.key === 'Enter' && setOpen(r)}
                  >
                    <td>{timestamp(r.startedAt)}</td>
                    <td>{r.trigger}</td>
                    <td>{dur(r.startedAt, r.finishedAt)}</td>
                    <td>
                      <StatusPill status={r.status} />
                    </td>
                    <td>{r.rows !== undefined ? fmtNumber(r.rows) : '—'}</td>
                    <td>{r.calls !== undefined ? fmtNumber(r.calls) : '—'}</td>
                    <td>
                      {r.symbolsAttempted !== undefined
                        ? `${fmtNumber(r.symbolsCovered ?? 0)} / ${fmtNumber(r.symbolsAttempted)}`
                        : '—'}
                    </td>
                    <td>{r.symbolErrors?.length ? r.symbolErrors.length : r.error ? 1 : '—'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )
      ) : tab === 'history' ? (
        backfill
      ) : tab === 'schedule' ? (
        <div className="sync-schedule">
          <p>
            <strong>{describeSchedule(schedule)}</strong>
            {schedule?.timezone ? <span className="muted-line"> ({schedule.timezone})</span> : null}
          </p>
          {upcoming.length ? (
            <>
              <h4>Next runs</h4>
              <ol className="next-runs">
                {upcoming.map((t) => (
                  <li key={t.toISOString()}>{t.toLocaleString()}</li>
                ))}
              </ol>
            </>
          ) : (
            <p className="muted-line">
              No schedule: runs only when started (Run now, bulk run or a pipeline).
            </p>
          )}
          {isAdmin && (
            <Button variant="secondary" onClick={onEdit}>
              <Pencil size={14} /> Change the schedule
            </Button>
          )}
        </div>
      ) : mongoId && collection ? (
        <DataGrid connectionId={mongoId} collection={collection} />
      ) : (
        <div className="notice">Connect the built-in MongoDB to browse this collection.</div>
      )}
      {open && (
        <Drawer title={`Run ${timestamp(open.startedAt)}`} onClose={() => setOpen(null)}>
          <div className="run-drawer">
            <p>
              <StatusPill status={open.status} /> {open.trigger} · {dur(open.startedAt, open.finishedAt)} ·{' '}
              {fmtNumber(open.rows ?? 0)} rows · {fmtNumber(open.calls ?? 0)} FMP calls
            </p>
            {open.error && <div className="notice error">{open.error}</div>}
            <h4>
              Per-symbol errors{open.symbolErrors?.length ? ` (first ${open.symbolErrors.length})` : ''}
            </h4>
            {open.symbolErrors?.length ? (
              <table>
                <tbody>
                  {open.symbolErrors.map((e) => (
                    <tr key={e.symbol}>
                      <td>
                        <code>{e.symbol}</code>
                      </td>
                      <td>{e.error}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            ) : (
              <p className="muted-line">None.</p>
            )}
          </div>
        </Drawer>
      )}
    </div>
  );
}
