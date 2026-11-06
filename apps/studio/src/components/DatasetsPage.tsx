import React, { useEffect, useMemo, useRef, useState } from 'react';
import {
  Database,
  Plus,
  Play,
  Pencil,
  Trash2,
  Power,
  PowerOff,
  RotateCcw,
  Eraser,
  X,
  Download,
  Upload,
  History,
  RefreshCw,
  Code2,
  BookOpen,
  Activity,
  GitBranch,
} from 'lucide-react';
import {
  type Data,
  type DatasetCatalogItem,
  type TickerPreset,
  fetchDatasetCatalog,
  saveDatasetSync,
  deleteDatasetSync,
  runDatasetSyncNow,
  bulkDatasetSyncs,
  probeDatasetDepth,
  fetchBackfill,
  fetchSyncStats,
  fetchTransforms,
  fetchCatalog,
  startBackfill,
  backfillControl,
  type DatasetBackfill,
  type DepthProbe,
  exportDatasetSyncsYaml,
  importDatasetSyncsYaml,
  type DatasetImportPlan,
  type DatasetBulkAction,
  timestamp,
} from '../api';
import { describeSchedule } from '../../../../packages/core/src/schedule.js';
import type { Schedule } from '../../../../packages/core/src/schema.js';
import { Button, IconButton, Field, Modal, SaveForm, Empty, PageTitle, Status } from './ui';
import { ScheduleFields } from './agentFields';
import { DataGrid } from './DataGrid';
import { FilterBar, KpiCard, Tabs } from './kit';
import { fmtNumber } from '../charts/chartData';
import { TransformsTab } from './TransformsTab';
import { PipelinesTab } from './PipelinesTab';
import { CatalogTab } from './CatalogTab';
import { HealthTab } from './HealthTab';
import { SyncDetail } from './SyncDetail';
import { SyncScheduleFields, type SyncTrigger } from './SyncScheduleFields';
import {
  DATASET_TABS,
  datasetsPath,
  parseDatasetsPath,
  type DatasetTab,
  type DatasetsRoute,
} from '../datasetsRoute';

type Props = {
  data: Data;
  refresh: () => Promise<void>;
  act: (task: () => Promise<void>) => Promise<void>;
  isAdmin: boolean;
};

type SyncForm = {
  id?: string;
  name: string;
  connectionId: string;
  dataset: string;
  symbolsMode: 'universe' | 'list' | 'preset';
  preset: string;
  symbols: string;
  from: string;
  to: string;
  targetCollection: string;
  retentionDays: string;
  priority: '' | 'P0' | 'P1' | 'P2';
  historyPeriods: string;
  statementPeriod: '' | 'quarter' | 'annual';
  enabled: boolean;
  schedule: Schedule;
  /** Event triggers (#82). */
  trigger?: SyncTrigger;
};

const TAB_LABELS: Record<DatasetTab, { label: string; icon: React.ReactNode }> = {
  syncs: { label: 'Syncs', icon: <RefreshCw size={15} /> },
  transforms: { label: 'Transforms', icon: <Code2 size={15} /> },
  pipelines: { label: 'Pipelines', icon: <GitBranch size={15} /> },
  catalog: { label: 'Catalog', icon: <BookOpen size={15} /> },
  health: { label: 'Health', icon: <Activity size={15} /> },
};

/** Datasets: Syncs (Layer 1) | Transforms (Layer 2) | Catalog | Health, routed as /datasets/<tab>[/<item>]. */
export function DatasetsPage(props: Props) {
  const [route, setRoute] = useState<DatasetsRoute>(() => parseDatasetsPath(location.pathname));
  useEffect(() => {
    const onPop = () => setRoute(parseDatasetsPath(location.pathname));
    addEventListener('popstate', onPop);
    // Normalise /datasets to /datasets/syncs so the tab is always in the URL.
    if (location.pathname !== datasetsPath(route)) history.replaceState({}, '', datasetsPath(route));
    return () => removeEventListener('popstate', onPop);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  const go = (next: DatasetsRoute) => {
    setRoute(next);
    history.pushState({}, '', datasetsPath(next));
  };
  return (
    <>
      <PageTitle
        eyebrow="Data"
        title="Datasets"
        text="Layer 1 syncs pull raw data; optional Layer 2 transforms (Python) turn it into flat point-in-time collections. Everything is exportable as YAML."
      />
      <Tabs
        tabs={DATASET_TABS.map((id) => ({ id, ...TAB_LABELS[id] }))}
        value={route.tab}
        onChange={(tab) => go({ tab })}
      />
      {route.tab === 'syncs' ? (
        <SyncsTab {...props} go={go} item={route.item} />
      ) : route.tab === 'transforms' ? (
        <TransformsTab item={route.item} go={go} isAdmin={props.isAdmin} />
      ) : route.tab === 'pipelines' ? (
        <PipelinesTab item={route.item} go={go} isAdmin={props.isAdmin} data={props.data} />
      ) : route.tab === 'catalog' ? (
        <CatalogTab item={route.item} go={go} isAdmin={props.isAdmin} data={props.data} />
      ) : (
        <HealthTab go={go} isAdmin={props.isAdmin} />
      )}
    </>
  );
}

function SyncsTab({
  data,
  refresh,
  act,
  isAdmin,
  go,
  item,
}: Props & { go?: (r: DatasetsRoute) => void; item?: string }) {
  const [catalog, setCatalog] = useState<DatasetCatalogItem[]>([]);
  const [presets, setPresets] = useState<TickerPreset[]>([]);
  const [selected, setSelected] = useState<string>('');
  const [editing, setEditing] = useState<SyncForm | null>(null);
  const [checked, setChecked] = useState<Set<string>>(new Set());
  const [confirming, setConfirming] = useState<{
    action: 'purge' | 'delete';
    dropCollections: boolean;
  } | null>(null);
  const [bulkBusy, setBulkBusy] = useState(false);
  const [notice, setNotice] = useState('');
  const [importing, setImporting] = useState<{
    yaml: string;
    mode: 'merge' | 'replace';
    plan?: DatasetImportPlan;
    busy?: boolean;
    error?: string;
  } | null>(null);

  useEffect(() => {
    fetchDatasetCatalog()
      .then((r) => {
        setCatalog(r.datasets);
        setPresets(r.presets ?? []);
      })
      .catch(() => undefined);
  }, []);

  const syncs = data.datasetSyncs ?? [];
  const catalogById = useMemo(() => new Map(catalog.map((c) => [c.id, c])), [catalog]);
  const presetById = useMemo(() => new Map(presets.map((p) => [p.id, p])), [presets]);
  const mongo = data.connections.find((c) => c.kind === 'mongodb' && c.enabled);
  const fmpConnections = data.connections.filter((c) => c.kind === 'mcp' && c.enabled);
  const defaultFmp =
    fmpConnections.find((c) => /financialmodelingprep|fmp/i.test(`${c.name} ${c.url ?? ''}`))?.id ??
    fmpConnections[0]?.id ??
    '';

  // Drop selections for syncs that no longer exist (deleted here or elsewhere).
  const checkedIds = syncs.filter((s) => checked.has(s.id)).map((s) => s.id as string);
  const allChecked = syncs.length > 0 && checkedIds.length === syncs.length;
  const someChecked = checkedIds.length > 0 && !allChecked;
  const selectAllRef = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (selectAllRef.current) selectAllRef.current.indeterminate = someChecked;
  }, [someChecked]);
  const toggle = (id: string) =>
    setChecked((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  const toggleAll = () => setChecked(allChecked ? new Set() : new Set(syncs.map((s) => s.id as string)));
  const collectionOf = (s: Record<string, any>) =>
    (s.targetCollection as string) || catalogById.get(s.dataset as string)?.defaultCollection || '';
  const checkedCollections = [
    ...new Set(
      syncs
        .filter((s) => checked.has(s.id))
        .map(collectionOf)
        .filter(Boolean),
    ),
  ];
  const anyRunning = syncs.some((s) => s.running);

  // While a sync runs, refresh so rows, counts and status update without a manual reload.
  useEffect(() => {
    if (!anyRunning) return;
    const t = setInterval(() => void refresh(), 5000);
    return () => clearInterval(t);
  }, [anyRunning, refresh]);

  const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'}`;
  async function bulk(action: DatasetBulkAction, dropCollections = false) {
    if (!checkedIds.length) return;
    setBulkBusy(true);
    setNotice('');
    try {
      await act(async () => {
        const r = await bulkDatasetSyncs(checkedIds, action, dropCollections);
        const n = plural(r.matched, 'sync');
        const messages: Record<DatasetBulkAction, string> = {
          backfill: `Backfill queued for ${plural(r.backfillsQueued?.length ?? 0, 'sync')}${
            r.backfillsSkipped?.length
              ? `; skipped ${r.backfillsSkipped.length} (${[...new Set(r.backfillsSkipped.map((x) => x.reason))].join(' / ')})`
              : ''
          }. History is pulled in resumable batches at the lowest priority.`,
          run: `Queued ${plural(r.queued?.length ?? 0, 'sync')} by priority (they share the FMP rate limit)${
            r.alreadyRunning?.length ? ` (${r.alreadyRunning.length} already running)` : ''
          }.`,
          enable: `Enabled ${n}.`,
          disable: `Disabled ${n}.`,
          reset: `Reset ${n}: the next run re-pulls history from its start date.`,
          purge: `Purged ${(r.collections ?? [])
            .map((c) => `${c.name} (${(c.deleted ?? 0).toLocaleString()} rows)`)
            .join(', ')}.`,
          delete: `Deleted ${n}.${
            r.collections?.length ? ` Dropped ${r.collections.map((c) => c.name).join(', ')}.` : ''
          }${r.keptCollections?.length ? ` Kept ${r.keptCollections.join(', ')} (used by other syncs).` : ''}`,
        };
        setNotice(messages[action]);
        if (action === 'delete') {
          setChecked(new Set());
          setSelected('');
        }
        await refresh();
      });
    } finally {
      setBulkBusy(false);
      setConfirming(null);
    }
  }

  const current = syncs.find((s) => s.id === selected) ?? syncs[0];
  const detail = item ? syncs.find((s) => s.id === item) : undefined;
  const [transformNames, setTransformNames] = useState<string[]>([]);
  useEffect(() => {
    if (editing)
      void fetchTransforms().then(
        (t) => setTransformNames(t.map((x) => x.name)),
        () => undefined,
      );
  }, [editing?.id]);
  // List KPIs, filters and the coverage column (#76).
  const [q, setQ] = useState('');
  const [fCategory, setFCategory] = useState('');
  const [fPriority, setFPriority] = useState('');
  const [fStatus, setFStatus] = useState('');
  const [fCadence, setFCadence] = useState('');
  const [stats, setStats] = useState<{ runs: number; failed: number; calls: number; rows: number } | null>(
    null,
  );
  const [coverage, setCoverage] = useState<Map<string, { pct?: number; rows: number }>>(new Map());
  useEffect(() => {
    const d = new Date();
    d.setHours(0, 0, 0, 0);
    void fetchSyncStats(d).then(setStats, () => undefined);
    void fetchCatalog().then(
      (c) =>
        setCoverage(
          new Map(
            c.map((e) => [e.collection, { pct: e.coverage.universeCoveragePct, rows: e.coverage.rows }]),
          ),
        ),
      () => undefined,
    );
  }, [data.datasetSyncs]);
  const statusOf = (s: Record<string, any>) =>
    s.running ? 'running' : s.queued ? 'queued' : s.enabled ? (s.lastError ? 'failed' : 'ready') : 'disabled';
  const cadenceOf = (s: Record<string, any>) => {
    const m = s.schedule?.enabled ? Number(s.schedule.everyMinutes) : 0;
    return !m ? 'manual' : m < 1440 ? 'intraday' : m === 1440 ? 'daily' : m <= 10080 ? 'weekly' : 'monthly';
  };
  const visible = syncs.filter(
    (s) =>
      (!q || `${s.name} ${s.dataset}`.toLowerCase().includes(q.toLowerCase())) &&
      (!fCategory || catalogById.get(s.dataset as string)?.category === fCategory) &&
      (!fPriority || s.effectivePriority === fPriority) &&
      (!fStatus || statusOf(s) === fStatus) &&
      (!fCadence || cadenceOf(s) === fCadence),
  );
  const collections = [...new Set(syncs.map(collectionOf).filter(Boolean))];
  const healthy = syncs.filter((s) => s.enabled && !s.lastError).length;
  const historyOf = (s: Record<string, any>) =>
    s.historyPeriods
      ? `${s.historyPeriods} periods`
      : s.from
        ? `from ${String(s.from).slice(0, 10)}`
        : catalogById.get(s.dataset as string)?.defaultHistoryPeriods
          ? `${catalogById.get(s.dataset as string)!.defaultHistoryPeriods} periods`
          : 'incremental';
  const currentCollection = current
    ? (current.targetCollection as string) ||
      catalogById.get(current.dataset as string)?.defaultCollection ||
      ''
    : '';

  const blankForm = (): SyncForm => ({
    name: '',
    connectionId: defaultFmp,
    dataset: catalog[0]?.id ?? '',
    symbolsMode: 'universe',
    preset: presets[0]?.id ?? '',
    symbols: '',
    from: '',
    to: '',
    targetCollection: '',
    retentionDays: '',
    priority: '',
    historyPeriods: '',
    statementPeriod: '',
    enabled: true,
    schedule: {
      enabled: true,
      everyMinutes: catalog[0]?.recommendedEveryMinutes ?? 1440,
      at: '18:30',
      input: 'Scheduled dataset sync',
      timezone: Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC',
    },
  });
  const editForm = (s: Record<string, any>): SyncForm => ({
    id: s.id,
    name: s.name ?? '',
    connectionId: s.connectionId ?? defaultFmp,
    dataset: s.dataset ?? catalog[0]?.id ?? '',
    symbolsMode: s.symbolsMode ?? 'universe',
    preset: s.preset ?? presets[0]?.id ?? '',
    symbols: Array.isArray(s.symbols) ? s.symbols.join(', ') : '',
    from: s.from ?? '',
    to: s.to ?? '',
    targetCollection: s.targetCollection ?? '',
    retentionDays: s.retentionDays ? String(s.retentionDays) : '',
    priority: s.priority ?? '',
    historyPeriods: s.historyPeriods ? String(s.historyPeriods) : '',
    statementPeriod: s.statementPeriod ?? '',
    enabled: s.enabled ?? true,
    schedule: s.schedule ?? blankForm().schedule,
    ...(s.trigger ? { trigger: s.trigger as SyncTrigger } : {}),
  });

  async function save() {
    if (!editing) return;
    const item = catalogById.get(editing.dataset);
    const body: Record<string, unknown> = {
      name: editing.name.trim(),
      connectionId: editing.connectionId,
      dataset: editing.dataset,
      enabled: editing.enabled,
      schedule: editing.schedule,
      symbolsMode: editing.symbolsMode,
      ...(editing.trigger && (editing.trigger.after.length || editing.trigger.afterEarnings)
        ? { trigger: editing.trigger }
        : {}),
    };
    if (item?.perSymbol) {
      if (editing.symbolsMode === 'list')
        body.symbols = editing.symbols
          .split(/[\s,]+/)
          .map((s) => s.trim().toUpperCase())
          .filter(Boolean);
      if (editing.symbolsMode === 'preset') body.preset = editing.preset;
    }
    if (item?.supportsDateRange) {
      if (editing.from) body.from = editing.from;
      if (editing.to) body.to = editing.to;
    }
    if (editing.targetCollection.trim()) body.targetCollection = editing.targetCollection.trim();
    if (editing.retentionDays) body.retentionDays = Number(editing.retentionDays);
    if (editing.priority) body.priority = editing.priority;
    if (item?.defaultHistoryPeriods && editing.historyPeriods)
      body.historyPeriods = Number(editing.historyPeriods);
    if (item?.periodParam && editing.statementPeriod) body.statementPeriod = editing.statementPeriod;
    await saveDatasetSync(body, editing.id);
    await refresh();
    setEditing(null);
  }

  const symbolsLabel = (s: Record<string, any>) => {
    const item = catalogById.get(s.dataset);
    if (!item?.perSymbol) return 'Market';
    if (s.symbolsMode === 'list') return `${(s.symbols ?? []).length} tickers`;
    if (s.symbolsMode === 'preset') return presetById.get(s.preset)?.label ?? 'Preset';
    return 'Universe';
  };

  async function exportYaml() {
    await act(async () => {
      const text = await exportDatasetSyncsYaml(checkedIds);
      const url = URL.createObjectURL(new Blob([text], { type: 'application/yaml' }));
      const a = document.createElement('a');
      a.href = url;
      a.download = `dataset-syncs-${new Date().toISOString().slice(0, 10)}.yaml`;
      a.click();
      URL.revokeObjectURL(url);
      setNotice(`Exported ${plural(checkedIds.length || syncs.length, 'sync')} to YAML.`);
    });
  }
  async function runImport(dryRun: boolean) {
    if (!importing) return;
    setImporting({ ...importing, busy: true, error: undefined });
    try {
      const r = await importDatasetSyncsYaml(importing.yaml, importing.mode, dryRun);
      if (dryRun || !r.applied) return setImporting({ ...importing, plan: r.plan, busy: false });
      setImporting(null);
      setChecked(new Set());
      setSelected('');
      const p = r.plan;
      setNotice(
        `Imported YAML: ${p.create.length} created, ${p.update.length} updated, ${p.unchanged.length} unchanged${
          p.remove.length ? `, ${p.remove.length} removed` : ''
        }.`,
      );
      await refresh();
    } catch (e) {
      setImporting({ ...importing, busy: false, error: e instanceof Error ? e.message : String(e) });
    }
  }
  const editImport = (patch: Partial<NonNullable<typeof importing>>) =>
    // Any edit invalidates the preview: Apply always applies what was last previewed.
    importing && setImporting({ ...importing, ...patch, plan: undefined, error: undefined });

  const selectedItem = editing ? catalogById.get(editing.dataset) : undefined;
  const importBtn = isAdmin && (
    <Button variant="secondary" onClick={() => setImporting({ yaml: '', mode: 'merge' })}>
      <Upload size={16} /> Import YAML
    </Button>
  );
  const addBtn = isAdmin && (
    <Button onClick={() => setEditing(blankForm())} disabled={!catalog.length}>
      <Plus size={16} /> Add dataset sync
    </Button>
  );

  return (
    <>
      {detail && go ? (
        <SyncDetail
          sync={detail}
          def={catalogById.get(detail.dataset as string)}
          mongoId={mongo?.id}
          isAdmin={isAdmin}
          go={go}
          onEdit={() => setEditing(editForm(detail))}
          onRun={() =>
            act(async () => {
              await runDatasetSyncNow(detail.id);
              setTimeout(() => void refresh(), 4000);
            })
          }
          backfill={<BackfillPanel syncId={detail.id} defaultFrom={String(detail.from ?? '')} />}
        />
      ) : (
        <>
          <div className="tab-head">
            <p>
              Layer 1: raw market data synced from FMP into MongoDB collections, browsable here and reusable
              by transforms and agents.
            </p>
            {addBtn}
          </div>
          {!syncs.length ? (
            <Empty
              icon={<Database size={28} />}
              title="No datasets yet"
              text="Add a dataset sync to pull raw data from FMP on a schedule into a reusable collection."
              action={
                isAdmin && (
                  <div className="dataset-empty-actions">
                    {addBtn}
                    {importBtn}
                  </div>
                )
              }
            />
          ) : (
            <div className="dataset-v2">
              <div className="kpi-row">
                <KpiCard
                  label="Syncs"
                  value={syncs.length}
                  footnote={`${syncs.filter((s) => s.enabled).length} enabled`}
                />
                <KpiCard
                  label="Collections"
                  value={collections.length}
                  footnote={`${fmtNumber(collections.reduce((n, c) => n + (coverage.get(c)?.rows ?? 0), 0))} rows`}
                />
                <KpiCard
                  label="Healthy"
                  value={healthy}
                  footnote={`${syncs.length - healthy} need attention`}
                />
                <KpiCard
                  label="FMP calls today"
                  value={stats ? fmtNumber(stats.calls) : '—'}
                  footnote={stats ? `${stats.runs} runs, ${stats.failed} failed` : undefined}
                />
              </div>
              <FilterBar
                search={q}
                onSearch={setQ}
                placeholder="Search syncs"
                shown={visible.length}
                total={syncs.length}
                filters={[
                  {
                    id: 'category',
                    label: 'Category',
                    all: 'All categories',
                    value: fCategory,
                    onChange: setFCategory,
                    options: [...new Set(catalog.map((c) => c.category))].sort().map((c) => ({ value: c })),
                  },
                  {
                    id: 'priority',
                    label: 'Priority',
                    all: 'All priorities',
                    value: fPriority,
                    onChange: setFPriority,
                    options: ['P0', 'P1', 'P2'].map((p) => ({ value: p })),
                  },
                  {
                    id: 'status',
                    label: 'Status',
                    all: 'All statuses',
                    value: fStatus,
                    onChange: setFStatus,
                    options: ['ready', 'running', 'queued', 'failed', 'disabled'].map((p) => ({ value: p })),
                  },
                  {
                    id: 'cadence',
                    label: 'Cadence',
                    all: 'Any cadence',
                    value: fCadence,
                    onChange: setFCadence,
                    options: ['intraday', 'daily', 'weekly', 'monthly', 'manual'].map((p) => ({ value: p })),
                  },
                ]}
              />
              {isAdmin && (
                <div className="dataset-toolbar" role="toolbar" aria-label="Dataset sync actions">
                  <label className="dataset-toolbar-select">
                    <input type="checkbox" checked={allChecked} onChange={toggleAll} />
                    {checkedIds.length ? `${checkedIds.length} of ${syncs.length} selected` : 'Select all'}
                  </label>
                  <div className="dataset-toolbar-actions">
                    <Button
                      variant="secondary"
                      title={
                        checkedIds.length ? 'Export the selected syncs as YAML' : 'Export every sync as YAML'
                      }
                      onClick={exportYaml}
                    >
                      <Download size={15} /> {checkedIds.length ? 'Export selected' : 'Export all'}
                    </Button>
                    {importBtn}
                    <span className="dataset-toolbar-divider" aria-hidden="true" />
                    <Button
                      variant="secondary"
                      disabled={!checkedIds.length || bulkBusy}
                      onClick={() => bulk('run')}
                    >
                      <Play size={15} /> Run
                    </Button>
                    <Button
                      variant="secondary"
                      disabled={!checkedIds.length || bulkBusy}
                      onClick={() => bulk('enable')}
                    >
                      <Power size={15} /> Enable
                    </Button>
                    <Button
                      variant="secondary"
                      disabled={!checkedIds.length || bulkBusy}
                      onClick={() => bulk('disable')}
                    >
                      <PowerOff size={15} /> Disable
                    </Button>
                    <Button
                      variant="secondary"
                      disabled={!checkedIds.length || bulkBusy}
                      title="Forget the sync cursor so the next run re-pulls history from the start date"
                      onClick={() => bulk('reset')}
                    >
                      <RotateCcw size={15} /> Reset cursor
                    </Button>
                    <Button
                      variant="secondary"
                      disabled={!checkedIds.length || bulkBusy}
                      title="Pull each selected sync's history (10 years by default) in resumable batches"
                      onClick={() => {
                        if (
                          confirm(
                            `Start a backfill for ${plural(checkedIds.length, 'sync')}? It runs in the background at the lowest FMP priority.`,
                          )
                        )
                          void bulk('backfill');
                      }}
                    >
                      <History size={15} /> Backfill
                    </Button>
                    <Button
                      variant="danger"
                      disabled={!checkedIds.length || bulkBusy}
                      title="Delete every record in the selected collections; the syncs are kept"
                      onClick={() => setConfirming({ action: 'purge', dropCollections: false })}
                    >
                      <Eraser size={15} /> Purge records
                    </Button>
                    <Button
                      variant="danger"
                      disabled={!checkedIds.length || bulkBusy}
                      onClick={() => setConfirming({ action: 'delete', dropCollections: false })}
                    >
                      <Trash2 size={15} /> Delete
                    </Button>
                    {checkedIds.length > 0 && (
                      <IconButton title="Clear selection" onClick={() => setChecked(new Set())}>
                        <X size={15} />
                      </IconButton>
                    )}
                  </div>
                </div>
              )}
              {notice && (
                <div className="notice dataset-notice" role="status">
                  <span>{notice}</span>
                  <IconButton title="Dismiss" onClick={() => setNotice('')}>
                    <X size={14} />
                  </IconButton>
                </div>
              )}
              <div className="table-wrap dataset-table">
                <table>
                  <thead>
                    <tr>
                      {isAdmin && (
                        <th className="dataset-check">
                          <input
                            ref={selectAllRef}
                            type="checkbox"
                            aria-label="Select all dataset syncs"
                            checked={allChecked}
                            onChange={toggleAll}
                          />
                        </th>
                      )}
                      <th>Name</th>
                      <th>Dataset</th>
                      <th>Symbols</th>
                      <th>Priority</th>
                      <th>History</th>
                      <th>Coverage</th>
                      <th>Schedule</th>
                      <th>Next run</th>
                      <th>Last run</th>
                      <th>Rows</th>
                      <th>Status</th>
                      {isAdmin && <th aria-label="Actions" />}
                    </tr>
                  </thead>
                  <tbody>
                    {visible.map((s) => (
                      <tr
                        key={s.id}
                        className={`${current?.id === s.id ? 'active' : ''} ${checked.has(s.id) ? 'checked' : ''}`}
                        onClick={() => (go ? go({ tab: 'syncs', item: s.id }) : setSelected(s.id))}
                      >
                        {isAdmin && (
                          <td className="dataset-check" onClick={(e) => e.stopPropagation()}>
                            <input
                              type="checkbox"
                              aria-label={`Select ${s.name}`}
                              checked={checked.has(s.id)}
                              onChange={() => toggle(s.id)}
                            />
                          </td>
                        )}
                        <td>
                          <strong>{s.name}</strong>
                        </td>
                        <td>{catalogById.get(s.dataset as string)?.label ?? s.dataset}</td>
                        <td>{symbolsLabel(s)}</td>
                        <td>
                          <span
                            className={`priority-pill ${String(s.effectivePriority ?? '').toLowerCase()}`}
                            title={s.priority ? 'Set on this sync' : 'Default for this dataset'}
                          >
                            {s.effectivePriority ?? '—'}
                            {!s.priority && <small> auto</small>}
                          </span>
                        </td>
                        <td>{historyOf(s)}</td>
                        <td>
                          {(() => {
                            const c = coverage.get(collectionOf(s));
                            return c?.pct !== undefined ? (
                              <span className="coverage-bar" title={`${c.pct}% of the universe`}>
                                <span style={{ width: `${Math.min(100, c.pct)}%` }} />
                                <small>{c.pct}%</small>
                              </span>
                            ) : (
                              <span className="muted-line">{c ? fmtNumber(c.rows) : '—'}</span>
                            );
                          })()}
                        </td>
                        <td>{describeSchedule(s.schedule as Schedule | undefined)}</td>
                        <td>{s.nextRunAt && s.schedule?.enabled ? timestamp(s.nextRunAt) : '—'}</td>
                        <td>{s.lastRunAt ? timestamp(s.lastRunAt) : '—'}</td>
                        <td>{typeof s.lastRows === 'number' ? s.lastRows.toLocaleString() : '—'}</td>
                        <td>
                          <Status
                            status={
                              s.running
                                ? 'running'
                                : s.queued
                                  ? 'queued'
                                  : s.enabled
                                    ? s.lastError
                                      ? 'failed'
                                      : 'ready'
                                    : 'disabled'
                            }
                          />
                          {s.backfill &&
                            ['queued', 'running', 'paused', 'failed'].includes(s.backfill.status) && (
                              <span
                                className={`backfill-badge ${s.backfill.status}`}
                                title="Backfill progress"
                              >
                                backfill{' '}
                                {s.backfill.status === 'running' ? `${s.backfill.pct}%` : s.backfill.status}
                              </span>
                            )}
                        </td>
                        {isAdmin && (
                          <td className="dataset-row-actions" onClick={(e) => e.stopPropagation()}>
                            <IconButton
                              title="Run now"
                              onClick={() =>
                                act(async () => {
                                  await runDatasetSyncNow(s.id);
                                  setTimeout(() => void refresh(), 4000);
                                })
                              }
                            >
                              <Play size={15} />
                            </IconButton>
                            <IconButton title="Edit" onClick={() => setEditing(editForm(s))}>
                              <Pencil size={15} />
                            </IconButton>
                            <IconButton
                              title="Delete"
                              onClick={() =>
                                act(async () => {
                                  if (!confirm(`Delete sync "${s.name}"? The collection is kept.`)) return;
                                  await deleteDatasetSync(s.id);
                                  setSelected('');
                                  await refresh();
                                })
                              }
                            >
                              <Trash2 size={15} />
                            </IconButton>
                          </td>
                        )}
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          )}
        </>
      )}

      {importing && (
        <Modal title="Import dataset syncs from YAML" onClose={() => setImporting(null)} wide>
          <div className="form-content">
            <Field label="YAML file" hint="A file from Export, or the deploy/config-io dataset-syncs.json.">
              <input
                type="file"
                accept=".yaml,.yml,.json,application/yaml,text/yaml"
                onChange={async (e) => {
                  const file = e.target.files?.[0];
                  if (file) editImport({ yaml: await file.text() });
                }}
              />
            </Field>
            <Field label="Or paste YAML">
              <textarea
                className="dataset-import-text"
                rows={10}
                spellCheck={false}
                value={importing.yaml}
                onChange={(e) => editImport({ yaml: e.target.value })}
                placeholder={
                  'syncs:\n  - name: Daily EOD prices\n    dataset: eod_prices\n    connection: FMP\n    ...'
                }
              />
            </Field>
            <Field label="Mode">
              <select
                value={importing.mode}
                onChange={(e) => editImport({ mode: e.target.value as 'merge' | 'replace' })}
              >
                <option value="merge">Merge: create new syncs and update ones with the same name</option>
                <option value="replace">Replace: also remove syncs that are not in the file</option>
              </select>
            </Field>
            <p className="field-help">
              Syncs are matched by name. Updated syncs keep their cursor, so they don&apos;t re-pull history.
              Collections and their records are never changed by an import.
            </p>
            {importing.error && <div className="notice error">{importing.error}</div>}
            {importing.plan && <ImportPlanView plan={importing.plan} />}
          </div>
          <div className="form-actions">
            <Button type="button" variant="secondary" onClick={() => setImporting(null)}>
              Cancel
            </Button>
            <Button
              type="button"
              variant="secondary"
              disabled={!importing.yaml.trim() || importing.busy}
              onClick={() => runImport(true)}
            >
              Preview
            </Button>
            <Button
              type="button"
              variant={importing.plan?.remove.length ? 'danger' : 'primary'}
              disabled={!importing.plan || importing.plan.errors.length > 0 || importing.busy}
              title={!importing.plan ? 'Preview the import first' : undefined}
              onClick={() => runImport(false)}
            >
              <Upload size={15} /> Apply import
            </Button>
          </div>
        </Modal>
      )}

      {confirming && (
        <Modal
          title={
            confirming.action === 'purge'
              ? `Purge records from ${plural(checkedCollections.length, 'collection')}?`
              : `Delete ${plural(checkedIds.length, 'dataset sync')}?`
          }
          onClose={() => setConfirming(null)}
        >
          <div className="form-content">
            {confirming.action === 'purge' ? (
              <p>
                Every document in these collections will be deleted. The syncs are kept and their cursors are
                reset, so the next run re-pulls history from the start date. Other syncs writing to the same
                collection are reset too.
              </p>
            ) : (
              <p>
                The selected sync configurations will be removed. Their collections are kept unless you choose
                to drop them.
              </p>
            )}
            <ul className="dataset-confirm-list">
              {checkedCollections.map((c) => (
                <li key={c}>
                  <code>{c}</code>
                </li>
              ))}
            </ul>
            {confirming.action === 'delete' && (
              <label className="check-row">
                <input
                  type="checkbox"
                  checked={confirming.dropCollections}
                  onChange={(e) => setConfirming({ ...confirming, dropCollections: e.target.checked })}
                />
                Also drop these collections (skipped for any collection another sync still writes to)
              </label>
            )}
          </div>
          <div className="form-actions">
            <Button type="button" variant="secondary" onClick={() => setConfirming(null)}>
              Cancel
            </Button>
            <Button
              type="button"
              variant="danger"
              disabled={bulkBusy}
              onClick={() => bulk(confirming.action, confirming.dropCollections)}
            >
              {confirming.action === 'purge' ? <Eraser size={15} /> : <Trash2 size={15} />}{' '}
              {confirming.action === 'purge' ? 'Purge records' : 'Delete'}
            </Button>
          </div>
        </Modal>
      )}

      {editing && (
        <Modal
          title={editing.id ? 'Edit dataset sync' : 'Add dataset sync'}
          onClose={() => setEditing(null)}
          wide
        >
          <SaveForm onSave={save} onCancel={() => setEditing(null)} label={editing.id ? 'Save' : 'Create'}>
            <Field label="Name">
              <input
                value={editing.name}
                onChange={(e) => setEditing({ ...editing, name: e.target.value })}
                placeholder="e.g. Daily EOD prices"
              />
            </Field>
            <div className="two-columns">
              <Field label="Source connection" hint="FMP MCP connection; its API key is used for sync.">
                <select
                  value={editing.connectionId}
                  onChange={(e) => setEditing({ ...editing, connectionId: e.target.value })}
                >
                  {fmpConnections.map((c) => (
                    <option key={c.id} value={c.id}>
                      {c.name}
                    </option>
                  ))}
                </select>
              </Field>
              <Field label="Dataset">
                <select
                  value={editing.dataset}
                  onChange={(e) => {
                    const item = catalogById.get(e.target.value);
                    setEditing({
                      ...editing,
                      dataset: e.target.value,
                      schedule: {
                        ...editing.schedule,
                        everyMinutes: item?.recommendedEveryMinutes ?? editing.schedule.everyMinutes,
                      },
                    });
                  }}
                >
                  {catalog.map((c) => (
                    <option key={c.id} value={c.id}>
                      {c.category} · {c.label}
                    </option>
                  ))}
                </select>
              </Field>
            </div>
            {selectedItem?.description && <p className="field-help">{selectedItem.description}</p>}

            {selectedItem?.perSymbol && (
              <Field label="Symbols" hint="Per-symbol dataset: choose which tickers to pull.">
                <select
                  value={editing.symbolsMode}
                  onChange={(e) =>
                    setEditing({ ...editing, symbolsMode: e.target.value as SyncForm['symbolsMode'] })
                  }
                >
                  <option value="universe">Reuse the Universe collection</option>
                  <option value="preset">Screener preset</option>
                  <option value="list">Explicit ticker list</option>
                </select>
              </Field>
            )}
            {selectedItem?.perSymbol && editing.symbolsMode === 'preset' && (
              <Field label="Preset" hint={presetById.get(editing.preset)?.description}>
                <select
                  value={editing.preset}
                  onChange={(e) => setEditing({ ...editing, preset: e.target.value })}
                >
                  {presets.map((p) => (
                    <option key={p.id} value={p.id}>
                      {p.label}
                    </option>
                  ))}
                </select>
              </Field>
            )}
            {selectedItem?.perSymbol && editing.symbolsMode === 'list' && (
              <Field label="Tickers" hint="Comma or space separated, e.g. AAPL, MSFT, NVDA">
                <textarea
                  rows={2}
                  value={editing.symbols}
                  onChange={(e) => setEditing({ ...editing, symbols: e.target.value })}
                />
              </Field>
            )}

            {selectedItem?.supportsDateRange && (
              <div className="two-columns">
                <Field label="From" hint="First pull starts here (e.g. 5 years ago).">
                  <input
                    type="date"
                    value={editing.from}
                    onChange={(e) => setEditing({ ...editing, from: e.target.value })}
                  />
                </Field>
                <Field label="To" hint="Leave blank for today.">
                  <input
                    type="date"
                    value={editing.to}
                    onChange={(e) => setEditing({ ...editing, to: e.target.value })}
                  />
                </Field>
              </div>
            )}

            {selectedItem?.perSymbol &&
              (selectedItem.defaultHistoryPeriods ||
                selectedItem.periodParam ||
                selectedItem.supportsDateRange) && (
                <DepthFields editing={editing} setEditing={setEditing} item={selectedItem} />
              )}

            <div className="two-columns">
              <Field label="Collection" hint={`Default: ${selectedItem?.defaultCollection ?? '—'}`}>
                <input
                  value={editing.targetCollection}
                  onChange={(e) => setEditing({ ...editing, targetCollection: e.target.value })}
                  placeholder={selectedItem?.defaultCollection ?? ''}
                />
              </Field>
              <Field
                label="Priority"
                hint="Which syncs get FMP capacity first when the rate limit is reached."
              >
                <select
                  value={editing.priority}
                  onChange={(e) =>
                    setEditing({ ...editing, priority: e.target.value as SyncForm['priority'] })
                  }
                >
                  <option value="">Auto (dataset default)</option>
                  <option value="P0">P0: prices, corporate actions, calendars</option>
                  <option value="P1">P1: fundamentals, estimates, ownership</option>
                  <option value="P2">P2: news, segments, peers, movers</option>
                </select>
              </Field>
              <Field label="Retention (days)" hint="Optional: prune rows older than this.">
                <input
                  type="number"
                  min={1}
                  value={editing.retentionDays}
                  onChange={(e) => setEditing({ ...editing, retentionDays: e.target.value })}
                  placeholder="Keep everything"
                />
              </Field>
            </div>

            {editing.id && selectedItem && <BackfillPanel syncId={editing.id} defaultFrom={editing.from} />}
            {editing.id && go && (
              <p className="muted-line">
                Schema, coverage and caveats of{' '}
                <a
                  href={`/datasets/catalog/${editing.targetCollection || selectedItem?.defaultCollection || ''}`}
                  onClick={(e) => {
                    e.preventDefault();
                    const c = editing.targetCollection || selectedItem?.defaultCollection;
                    if (c) {
                      setEditing(null);
                      go({ tab: 'catalog', item: c });
                    }
                  }}
                >
                  {editing.targetCollection || selectedItem?.defaultCollection} in the Catalog
                </a>
              </p>
            )}

            <Field label="Schedule">
              <SyncScheduleFields
                schedule={editing.schedule}
                trigger={editing.trigger}
                dataset={catalogById.get(editing.dataset)}
                upstreams={[
                  ...syncs
                    .filter((x) => x.id !== editing.id)
                    .map((x) => collectionOf(x))
                    .filter((c, i, a) => c && a.indexOf(c) === i)
                    .map((c) => ({ value: `dataset:${c}`, label: `sync → ${c}` })),
                  ...transformNames.map((n) => ({ value: `transform:${n}`, label: `transform ${n}` })),
                ]}
                onChange={(schedule, trigger) => setEditing({ ...editing, schedule, trigger })}
              />
            </Field>
            <label className="check-row">
              <input
                type="checkbox"
                checked={editing.enabled}
                onChange={(e) => setEditing({ ...editing, enabled: e.target.checked })}
              />
              Sync enabled
            </label>
          </SaveForm>
        </Modal>
      )}
    </>
  );
}

function ImportPlanView({ plan }: { plan: DatasetImportPlan }) {
  const section = (title: string, items: string[], tone = '') =>
    items.length > 0 && (
      <div className={`dataset-plan-section ${tone}`}>
        <strong>
          {title} ({items.length})
        </strong>
        <ul>
          {items.map((t, i) => (
            <li key={i}>{t}</li>
          ))}
        </ul>
      </div>
    );
  const nothing = !plan.errors.length && !plan.create.length && !plan.update.length && !plan.remove.length;
  return (
    <div className="dataset-plan" aria-live="polite">
      {section(
        'Errors - fix these first; nothing is applied',
        plan.errors.map((e) => `Entry ${e.index + 1}${e.name ? ` "${e.name}"` : ''}: ${e.message}`),
        'error',
      )}
      {section(
        'Create',
        plan.create.map((c) => `${c.name} (${c.dataset})`),
      )}
      {section(
        'Update',
        plan.update.map((u) => `${u.name}: ${u.changed.join(', ')}`),
      )}
      {section(
        'Remove',
        plan.remove.map((r) => `${r.name} (sync only; collection kept)`),
        'error',
      )}
      {plan.unchanged.length > 0 && (
        <div className="dataset-plan-section muted">Unchanged: {plan.unchanged.length}</div>
      )}
      {nothing && <div className="dataset-plan-section muted">Nothing to change.</div>}
    </div>
  );
}

/** History depth (#77): rows per symbol / statement period, plus a probe of what the FMP plan returns. */
function DepthFields({
  editing,
  setEditing,
  item,
}: {
  editing: SyncForm;
  setEditing: (f: SyncForm) => void;
  item: DatasetCatalogItem;
}) {
  const [probe, setProbe] = useState<DepthProbe | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const unit =
    item.periodParam === 'quarter' && editing.statementPeriod !== 'annual' ? 'quarters' : 'periods';
  return (
    <div className="depth-fields">
      <div className="two-columns">
        {item.defaultHistoryPeriods ? (
          <Field
            label={`History depth (${unit} per symbol)`}
            hint={`Default ${item.defaultHistoryPeriods}. Target for statements: 40 quarters.`}
          >
            <input
              type="number"
              min={1}
              max={200}
              value={editing.historyPeriods}
              onChange={(e) => setEditing({ ...editing, historyPeriods: e.target.value })}
              placeholder={String(item.defaultHistoryPeriods)}
            />
          </Field>
        ) : (
          <div />
        )}
        {item.periodParam ? (
          <Field label="Statement period">
            <select
              value={editing.statementPeriod}
              onChange={(e) =>
                setEditing({ ...editing, statementPeriod: e.target.value as SyncForm['statementPeriod'] })
              }
            >
              <option value="">Default ({item.periodParam})</option>
              <option value="quarter">Quarterly</option>
              <option value="annual">Annual</option>
            </select>
          </Field>
        ) : (
          <div />
        )}
      </div>
      <div className="depth-probe">
        <Button
          type="button"
          variant="secondary"
          disabled={busy || !editing.connectionId}
          onClick={async () => {
            setBusy(true);
            setError('');
            try {
              setProbe(
                await probeDatasetDepth({
                  dataset: editing.dataset,
                  connectionId: editing.connectionId,
                  statementPeriod: editing.statementPeriod || undefined,
                  syncId: editing.id,
                }),
              );
            } catch (e) {
              setError(e instanceof Error ? e.message : String(e));
            } finally {
              setBusy(false);
            }
          }}
        >
          Test depth
        </Button>
        <span className="field-help">
          {probe
            ? `FMP returned ${probe.rows} rows for ${probe.symbol}: ${probe.earliest ?? '—'} → ${probe.latest ?? '—'} (${probe.years} years).`
            : error ||
              'Asks FMP for as much history as possible for one symbol (AAPL), to check what the plan allows.'}
        </span>
      </div>
    </div>
  );
}

/** Backfill (#80): history in resumable batches; progress refreshes while it runs. */
function BackfillPanel({ syncId, defaultFrom }: { syncId: string; defaultFrom: string }) {
  const tenYearsAgo = new Date(Date.now() - 10 * 365.25 * 86400000).toISOString().slice(0, 10);
  const [from, setFrom] = useState(defaultFrom || tenYearsAgo);
  const [bf, setBf] = useState<DatasetBackfill | null>(null);
  const [error, setError] = useState('');
  const load = () =>
    fetchBackfill(syncId)
      .then(setBf)
      .catch((e) => setError(String(e)));
  useEffect(() => {
    void load();
  }, [syncId]);
  useEffect(() => {
    if (!bf || !['queued', 'running'].includes(bf.status)) return;
    const t = setInterval(() => void load(), 5000);
    return () => clearInterval(t);
  }, [bf?.status]);
  const act = async (fn: () => Promise<DatasetBackfill>) => {
    setError('');
    try {
      setBf(await fn());
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  };
  const active = bf && ['queued', 'running', 'paused'].includes(bf.status);
  const eta = bf?.progress.etaMs ? `${Math.max(1, Math.round(bf.progress.etaMs / 60000))} min left` : '';
  return (
    <div className="backfill-panel">
      <strong>History backfill</strong>
      <p className="field-help">
        Pulls this sync's history in resumable batches at the lowest FMP priority, so scheduled syncs always
        go first. It never changes the incremental cursor. Safe to pause, and it resumes after a restart.
      </p>
      {!active && (
        <div className="backfill-start">
          <Field label="History from">
            <input type="date" value={from} onChange={(e) => setFrom(e.target.value)} />
          </Field>
          <Button
            type="button"
            variant="secondary"
            onClick={() => act(() => startBackfill(syncId, { from }))}
          >
            <History size={15} /> Start backfill
          </Button>
        </div>
      )}
      {bf && (
        <div className="backfill-status">
          <div className="backfill-bar" aria-label={`Backfill ${bf.progress.pct}%`}>
            <span style={{ width: `${bf.progress.pct}%` }} />
          </div>
          <div className="field-help">
            <Status status={bf.status === 'completed' ? 'succeeded' : bf.status} /> {bf.progress.pct}% ·{' '}
            {bf.from} → {bf.to} · batches {bf.progress.batchesDone}/{bf.progress.batchesTotal}
            {bf.progress.batchesFailed ? `, ${bf.progress.batchesFailed} failed` : ''} ·{' '}
            {bf.rows.toLocaleString()} rows · {bf.calls.toLocaleString()} FMP calls
            {bf.symbolCount ? ` · ${bf.symbolCount} symbols` : ''}
            {eta ? ` · ${eta}` : ''}
          </div>
          {bf.lastError && <div className="notice error">{bf.lastError}</div>}
          <div className="backfill-actions">
            {['queued', 'running'].includes(bf.status) && (
              <Button
                type="button"
                variant="secondary"
                onClick={() => act(() => backfillControl(syncId, 'pause'))}
              >
                Pause
              </Button>
            )}
            {bf.status === 'paused' && (
              <Button
                type="button"
                variant="secondary"
                onClick={() => act(() => backfillControl(syncId, 'resume'))}
              >
                Resume
              </Button>
            )}
            {active && (
              <Button
                type="button"
                variant="ghost"
                onClick={() => act(() => backfillControl(syncId, 'cancel'))}
              >
                Cancel
              </Button>
            )}
            {bf.progress.batchesFailed > 0 && ['failed', 'completed'].includes(bf.status) && (
              <Button
                type="button"
                variant="secondary"
                onClick={() => act(() => backfillControl(syncId, 'retry'))}
              >
                Retry failed ({bf.progress.batchesFailed})
              </Button>
            )}
          </div>
        </div>
      )}
      {error && <div className="notice error">{error}</div>}
    </div>
  );
}
