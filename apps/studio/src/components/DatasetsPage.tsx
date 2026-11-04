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
};

export function DatasetsPage({ data, refresh, act, isAdmin }: Props) {
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
      <PageTitle
        eyebrow="Data"
        title="Dataset"
        text="Sync raw market data from FMP into MongoDB collections you can browse here and reuse in harnesses (as a MongoDB tool or via oh.read in Python nodes)."
        action={addBtn}
      />
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
                  <th>Schedule</th>
                  <th>Last run</th>
                  <th>Rows</th>
                  <th>Status</th>
                  {isAdmin && <th aria-label="Actions" />}
                </tr>
              </thead>
              <tbody>
                {syncs.map((s) => (
                  <tr
                    key={s.id}
                    className={`${current?.id === s.id ? 'active' : ''} ${checked.has(s.id) ? 'checked' : ''}`}
                    onClick={() => setSelected(s.id)}
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
                    <td>{describeSchedule(s.schedule as Schedule | undefined)}</td>
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

          {current && (
            <section className="dataset-grid-section">
              <div className="dataset-grid-head">
                <div>
                  <h2>{current.name}</h2>
                  <div className="dataset-grid-meta">
                    <code>{currentCollection}</code>
                    {current.lastError ? (
                      <span className="dataset-error">· {String(current.lastError)}</span>
                    ) : null}
                  </div>
                </div>
              </div>
              {mongo && currentCollection ? (
                <DataGrid connectionId={mongo.id} collection={currentCollection} />
              ) : (
                <div className="notice">Connect the built-in MongoDB to browse this collection.</div>
              )}
            </section>
          )}
        </div>
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

            <ScheduleFields
              value={editing.schedule}
              onChange={(schedule) => setEditing({ ...editing, schedule })}
            />
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
