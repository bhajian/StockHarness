import React, { useEffect, useMemo, useRef, useState } from 'react';
import { Database, Plus, Play, Pencil, Trash2, Power, PowerOff, RotateCcw, Eraser, X } from 'lucide-react';
import {
  type Data,
  type DatasetCatalogItem,
  type TickerPreset,
  fetchDatasetCatalog,
  saveDatasetSync,
  deleteDatasetSync,
  runDatasetSyncNow,
  bulkDatasetSyncs,
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
          run: `Queued ${plural(r.queued?.length ?? 0, 'sync')} to run one after another${
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

  const selectedItem = editing ? catalogById.get(editing.dataset) : undefined;
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
          action={addBtn}
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
                    <td>{describeSchedule(s.schedule as Schedule | undefined)}</td>
                    <td>{s.lastRunAt ? timestamp(s.lastRunAt) : '—'}</td>
                    <td>{typeof s.lastRows === 'number' ? s.lastRows.toLocaleString() : '—'}</td>
                    <td>
                      <Status
                        status={
                          s.running ? 'running' : s.enabled ? (s.lastError ? 'failed' : 'ready') : 'disabled'
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

            <div className="two-columns">
              <Field label="Collection" hint={`Default: ${selectedItem?.defaultCollection ?? '—'}`}>
                <input
                  value={editing.targetCollection}
                  onChange={(e) => setEditing({ ...editing, targetCollection: e.target.value })}
                  placeholder={selectedItem?.defaultCollection ?? ''}
                />
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
