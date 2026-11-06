// Datasets → Catalog (#87): every collection grouped by layer (search, doc completeness per layer, select for
// "Export for agents"), and a collection page: header (description, grain, key, time rule, freshness) and
// tabs Fields (inline docs), Coverage (charts), Caveats, Sample (DataGrid), Joins and Agent view.
import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { BookOpen, Bot, Download, GitFork, Pencil, RefreshCw, Search, X } from 'lucide-react';
import { LineageGraph } from './LineageGraph';
import {
  type CatalogCoverage,
  type CatalogDetail,
  type CatalogListItem,
  type Data,
  exportCatalogMarkdown,
  fetchAgentView,
  fetchCatalog,
  fetchCatalogCoverage,
  fetchCatalogDetail,
  patchCatalogEntry,
  timestamp,
} from '../api';
import type { DatasetsRoute } from '../datasetsRoute';
import { Button, Empty, IconButton } from './ui';
import { KpiCard, Skeleton, StatusPill, Tabs } from './kit';
import { DataGrid } from './DataGrid';
import { HeatmapChart, TimeSeriesChart } from '../charts/Charts';
import { fmtNumber } from '../charts/chartData';

type Go = (r: DatasetsRoute) => void;
const TIME_PILL: Record<string, [string, string]> = {
  pit: ['ok', 'point-in-time'],
  current_only: ['stale', 'current only'],
  static: ['outline', 'static'],
  unknown: ['warn', 'time rule unknown'],
};
const layerName = (l: 1 | 2 | null) => (l === 1 ? 'Layer 1 · raw' : l === 2 ? 'Layer 2 · prepared' : 'Other');

export function CatalogTab({
  item,
  go,
  isAdmin,
  data,
}: {
  item?: string;
  go: Go;
  isAdmin: boolean;
  data: Data;
}) {
  const [list, setList] = useState<CatalogListItem[] | null>(null);
  const [error, setError] = useState('');
  const [q, setQ] = useState('');
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const load = useCallback(async () => {
    try {
      setList(await fetchCatalog());
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }, []);
  useEffect(() => {
    void load();
  }, [load]);
  const groups = useMemo(() => {
    const f = (list ?? []).filter(
      (c) => !q || `${c.collection} ${c.description}`.toLowerCase().includes(q.toLowerCase()),
    );
    return ([1, 2, null] as const)
      .map((layer) => {
        const items = f
          .filter((c) => c.layer === layer)
          .sort((a, b) => a.collection.localeCompare(b.collection));
        const doc = items.length
          ? Math.round(items.reduce((n, c) => n + c.docCompletenessPct, 0) / items.length)
          : 0;
        return { layer, items, doc };
      })
      .filter((g) => g.items.length);
  }, [list, q]);
  async function exportMd() {
    const text = await exportCatalogMarkdown([...picked]);
    const url = URL.createObjectURL(new Blob([text], { type: 'text/markdown' }));
    Object.assign(document.createElement('a'), { href: url, download: 'catalog-for-agents.md' }).click();
    URL.revokeObjectURL(url);
  }
  if (!list) return error ? <div className="notice error">{error}</div> : <Skeleton rows={8} />;
  if (!list.length)
    return (
      <Empty
        icon={<BookOpen size={28} />}
        title="The catalog is empty"
        text="Collections appear here after their first sync or transform run."
      />
    );
  if (item === '_graph')
    return (
      <>
        <div className="tab-head">
          <p>Lineage: what feeds what, from dataset syncs through transforms to every output collection.</p>
          <Button variant="secondary" onClick={() => go({ tab: 'catalog' })}>
            <BookOpen size={15} /> Collections
          </Button>
        </div>
        <LineageGraph go={go} height={640} />
      </>
    );
  const selected = item ?? groups[0]?.items[0]?.collection;
  return (
    <div className="catalog-panes">
      <aside className="catalog-list">
        <label className="catalog-search">
          <Search size={14} />
          <input
            aria-label="Search collections"
            placeholder="Search collections"
            value={q}
            onChange={(e) => setQ(e.target.value)}
          />
        </label>
        <Button variant="secondary" onClick={() => go({ tab: 'catalog', item: '_graph' })}>
          <GitFork size={14} /> Lineage graph
        </Button>
        <Button
          variant="secondary"
          disabled={!picked.size}
          onClick={() => void exportMd()}
          title="Markdown with exactly what agents see for the selected collections"
        >
          <Download size={14} /> Export for agents{picked.size ? ` (${picked.size})` : ''}
        </Button>
        {groups.map((g) => (
          <section key={String(g.layer)}>
            <h3>
              {layerName(g.layer)}{' '}
              <small>
                {g.items.length} · {g.doc}% documented
              </small>
            </h3>
            <ul>
              {g.items.map((c) => (
                <li key={c.collection} className={c.collection === selected ? 'active' : ''}>
                  <input
                    type="checkbox"
                    aria-label={`Select ${c.collection} for export`}
                    checked={picked.has(c.collection)}
                    onChange={() =>
                      setPicked((p) => {
                        const n = new Set(p);
                        if (n.has(c.collection)) n.delete(c.collection);
                        else n.add(c.collection);
                        return n;
                      })
                    }
                  />
                  <button className="link-button" onClick={() => go({ tab: 'catalog', item: c.collection })}>
                    <code>{c.collection}</code>
                  </button>
                  <small title={`${c.docCompletenessPct}% of fields documented`}>
                    {fmtNumber(c.coverage.rows)} · {c.docCompletenessPct}%
                  </small>
                </li>
              ))}
            </ul>
          </section>
        ))}
      </aside>
      <section className="catalog-page">
        {selected ? (
          <CollectionPage
            key={selected}
            name={selected}
            isAdmin={isAdmin}
            go={go}
            data={data}
            onChanged={load}
          />
        ) : (
          <p className="muted-line">No collection matches.</p>
        )}
      </section>
    </div>
  );
}

type Tab = 'fields' | 'coverage' | 'caveats' | 'sample' | 'joins' | 'lineage' | 'agent';
function CollectionPage({
  name,
  isAdmin,
  go,
  data,
  onChanged,
}: {
  name: string;
  isAdmin: boolean;
  go: Go;
  data: Data;
  onChanged: () => Promise<void>;
}) {
  const [e, setE] = useState<CatalogDetail | null>(null);
  const [error, setError] = useState('');
  const [tab, setTab] = useState<Tab>('fields');
  const [editing, setEditing] = useState<'description' | 'grain' | null>(null);
  const [text, setText] = useState('');
  useEffect(() => {
    void fetchCatalogDetail(name).then(setE, (x) => setError(String(x)));
  }, [name]);
  async function patch(body: NonNullable<CatalogDetail['curated']>) {
    setError('');
    try {
      setE(await patchCatalogEntry(name, body));
      await onChanged();
    } catch (x) {
      setError(x instanceof Error ? x.message : String(x));
    }
  }
  if (!e) return error ? <div className="notice error">{error}</div> : <Skeleton rows={6} />;
  const [tone, label] = TIME_PILL[e.timeSemantics.status] ?? ['warn', e.timeSemantics.status];
  const producer = e.producedBy?.[0];
  const mongo = data.connections.find((c) => c.kind === 'mongodb' && c.enabled);
  const inline = (field: 'description' | 'grain', value: string, placeholder: string) =>
    editing === field ? (
      <span className="inline-edit">
        {field === 'description' ? (
          <textarea
            aria-label={`Edit ${field}`}
            rows={3}
            value={text}
            onChange={(x) => setText(x.target.value)}
            autoFocus
          />
        ) : (
          <input
            aria-label={`Edit ${field}`}
            value={text}
            onChange={(x) => setText(x.target.value)}
            autoFocus
          />
        )}
        <Button
          onClick={async () => {
            await patch({ [field]: text });
            setEditing(null);
          }}
        >
          Save
        </Button>
        <Button variant="ghost" onClick={() => setEditing(null)}>
          Cancel
        </Button>
      </span>
    ) : (
      <span className="inline-value">
        {value || <span className="muted-line">{placeholder}</span>}
        {isAdmin && (
          <IconButton
            title={`Edit ${field}`}
            onClick={() => {
              setText(value);
              setEditing(field);
            }}
          >
            <Pencil size={13} />
          </IconButton>
        )}
      </span>
    );
  return (
    <div className="collection-page">
      <header className="collection-head">
        <h2>
          <code>{e.collection}</code>{' '}
          <StatusPill status={e.layer === 2 ? 'ready' : 'outline'} label={layerName(e.layer)} />{' '}
          <StatusPill status={tone === 'outline' ? 'disabled' : tone} label={label} />
        </h2>
        <div className="collection-desc">{inline('description', e.description, 'No description yet')}</div>
        <dl className="collection-facts">
          <dt>Grain</dt>
          <dd>{inline('grain', e.grain, 'unknown')}</dd>
          <dt>Key</dt>
          <dd>{e.primaryKey.length ? e.primaryKey.map((k) => <code key={k}>{k}</code>) : '—'}</dd>
          <dt>Time rule</dt>
          <dd>{e.timeSemantics.text}</dd>
          <dt>Freshness</dt>
          <dd>
            {e.freshness.lastUpdated ? timestamp(e.freshness.lastUpdated) : '—'}{' '}
            {e.freshness.lastStatus && (
              <StatusPill
                status={e.freshness.lastStatus === 'ok' ? 'ok' : 'failed'}
                label={e.freshness.lastStatus}
              />
            )}
          </dd>
          <dt>Produced by</dt>
          <dd>
            {producer ? (
              producer.type === 'transform' ? (
                <a
                  href={`/datasets/transforms/${producer.name}`}
                  onClick={(x) => {
                    x.preventDefault();
                    go({ tab: 'transforms', item: producer.name });
                  }}
                >
                  transform {producer.name}
                </a>
              ) : (
                `${producer.type} ${producer.name}`
              )
            ) : (
              '—'
            )}
          </dd>
        </dl>
      </header>
      {error && <div className="notice error">{error}</div>}
      <Tabs
        tabs={[
          { id: 'fields', label: `Fields (${e.fields.length})` },
          { id: 'coverage', label: 'Coverage' },
          { id: 'caveats', label: `Caveats (${e.caveats.length})` },
          { id: 'sample', label: 'Sample' },
          { id: 'joins', label: `Joins (${e.joins.length})` },
          { id: 'lineage', label: 'Lineage' },
          { id: 'agent', label: 'Agent view' },
        ]}
        value={tab}
        onChange={setTab}
      />
      {tab === 'fields' ? (
        <FieldsTable entry={e} isAdmin={isAdmin} onSave={(f, v) => patch({ fields: { [f]: v } })} />
      ) : tab === 'coverage' ? (
        <CoveragePanel entry={e} />
      ) : tab === 'caveats' ? (
        <CaveatsPanel entry={e} isAdmin={isAdmin} patch={patch} />
      ) : tab === 'sample' ? (
        mongo ? (
          <DataGrid connectionId={mongo.id} collection={e.collection} />
        ) : (
          <p className="muted-line">Connect the built-in MongoDB to browse rows.</p>
        )
      ) : tab === 'lineage' ? (
        <LineageGraph go={go} focus={e.collection} height={380} />
      ) : tab === 'joins' ? (
        e.joins.length ? (
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>Joins to</th>
                  <th>On</th>
                </tr>
              </thead>
              <tbody>
                {e.joins.map((j) => (
                  <tr key={j.to}>
                    <td>
                      <button className="link-button" onClick={() => go({ tab: 'catalog', item: j.to })}>
                        <code>{j.to}</code>
                      </button>
                    </td>
                    <td>
                      {(Array.isArray(j.on) ? j.on : [j.on]).map((k) => (
                        <code key={k}>{k}</code>
                      ))}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <p className="muted-line">No known joins.</p>
        )
      ) : (
        <AgentView name={e.collection} />
      )}
    </div>
  );
}

function FieldsTable({
  entry,
  isAdmin,
  onSave,
}: {
  entry: CatalogDetail;
  isAdmin: boolean;
  onSave: (field: string, v: { description?: string; unit?: string }) => Promise<void>;
}) {
  const [drafts, setDrafts] = useState<Record<string, { description: string; unit: string }>>({});
  const value = (f: CatalogDetail['fields'][number]) =>
    drafts[f.name] ?? { description: f.description ?? '', unit: f.unit ?? '' };
  const save = async (f: CatalogDetail['fields'][number]) => {
    const v = drafts[f.name];
    if (!v || (v.description === (f.description ?? '') && v.unit === (f.unit ?? ''))) return;
    await onSave(f.name, { description: v.description, ...(v.unit ? { unit: v.unit } : {}) });
    setDrafts((d) => {
      const { [f.name]: _, ...rest } = d;
      return rest;
    });
  };
  return (
    <div className="table-wrap catalog-fields">
      <table>
        <thead>
          <tr>
            <th>Field</th>
            <th>Type</th>
            <th>Null %</th>
            <th>Example</th>
            <th>Description</th>
            <th>Unit</th>
          </tr>
        </thead>
        <tbody>
          {entry.fields.map((f) => (
            <tr key={f.name}>
              <td>
                <code>{f.name}</code>
              </td>
              <td>{f.type}</td>
              <td>{f.null_pct}%</td>
              <td className="catalog-example">{exampleText(f.example)}</td>
              <td>
                <span className="field-doc">
                  {f.doc === 'dictionary' && !drafts[f.name] && (
                    <span title="Auto-filled from the built-in field dictionary">
                      <Bot size={13} aria-label="auto-filled" />
                    </span>
                  )}
                  {f.doc === 'none' && !drafts[f.name] && <StatusPill status="warn" label="undocumented" />}
                  {isAdmin ? (
                    <textarea
                      aria-label={`Description of ${f.name}`}
                      title={value(f).description}
                      value={value(f).description}
                      placeholder="Describe this field"
                      onChange={(x) =>
                        setDrafts((d) => ({ ...d, [f.name]: { ...value(f), description: x.target.value } }))
                      }
                      onBlur={() => void save(f)}
                      rows={2}
                      onKeyDown={(x) =>
                        x.key === 'Enter' &&
                        !x.shiftKey &&
                        (x.preventDefault(), (x.target as HTMLTextAreaElement).blur())
                      }
                    />
                  ) : (
                    f.description || '—'
                  )}
                </span>
              </td>
              <td>
                {isAdmin ? (
                  <input
                    aria-label={`Unit of ${f.name}`}
                    className="unit-input"
                    value={value(f).unit}
                    placeholder="unit"
                    onChange={(x) =>
                      setDrafts((d) => ({ ...d, [f.name]: { ...value(f), unit: x.target.value } }))
                    }
                    onBlur={() => void save(f)}
                  />
                ) : (
                  f.unit || ''
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function CoveragePanel({ entry }: { entry: CatalogDetail }) {
  const [cov, setCov] = useState<CatalogCoverage | null>(null);
  const [waiting, setWaiting] = useState(true);
  const [error, setError] = useState('');
  const load = useCallback(
    async (refresh = false) => {
      try {
        const c = await fetchCatalogCoverage(entry.collection, refresh);
        setCov(c);
        setWaiting(!c || c.computing);
      } catch (x) {
        setError(x instanceof Error ? x.message : String(x));
        setWaiting(false);
      }
    },
    [entry.collection],
  );
  useEffect(() => {
    void load();
  }, [load]);
  useEffect(() => {
    if (!waiting) return;
    const t = setInterval(() => void load(), 2500);
    return () => clearInterval(t);
  }, [waiting, load]);
  const c = entry.coverage;
  const weeks = Array.from({ length: 53 }, (_, i) => `W${i + 1}`);
  return (
    <div className="coverage-panel">
      <div className="kpi-row">
        <KpiCard label="Rows" value={fmtNumber(c.rows)} />
        {c.symbols !== undefined && <KpiCard label="Symbols" value={fmtNumber(c.symbols)} />}
        {c.universeCoveragePct !== undefined && (
          <KpiCard label="Universe coverage" value={`${c.universeCoveragePct}%`} />
        )}
        <KpiCard
          label={`Range (${c.dateField ?? 'no date field'})`}
          value={c.dateMin ? `${c.dateMin.slice(0, 10)} → ${(c.dateMax ?? '').slice(0, 10)}` : '—'}
        />
      </div>
      {error && <div className="notice error">{error}</div>}
      {!c.dateField ? (
        <p className="muted-line">This collection has no date field, so there is no coverage over time.</p>
      ) : !cov ? (
        <div className="notice" role="status">
          Computing coverage over {fmtNumber(c.rows)} rows…
        </div>
      ) : cov.error ? (
        <div className="notice error">{cov.error}</div>
      ) : (
        <>
          <div className="coverage-head">
            <span className="muted-line">
              {cov.days.toLocaleString()} days · computed {timestamp(cov.computedAt)}
              {cov.computing ? ' · refreshing…' : ''}
            </span>
            <Button variant="ghost" onClick={() => void load(true).then(() => setWaiting(true))}>
              <RefreshCw size={14} /> Recompute
            </Button>
          </div>
          <TimeSeriesChart
            title="Rows per day"
            data={{
              dates: cov.daily.dates,
              series: { rows: cov.daily.series.rows ?? [] },
              downsampled: cov.daily.downsampled,
            }}
            group={`coverage-${entry.collection}`}
            height={220}
          />
          {cov.daily.series.symbols && (
            <TimeSeriesChart
              title="Symbols per day"
              data={{
                dates: cov.daily.dates,
                series: { symbols: cov.daily.series.symbols },
                downsampled: cov.daily.downsampled,
              }}
              group={`coverage-${entry.collection}`}
              height={200}
            />
          )}
          <HeatmapChart
            title={`Gaps: average ${cov.heatmap.value} per day, by year and week`}
            subtitle="Pale or missing cells are weeks with little or no data"
            x={weeks}
            y={cov.heatmap.years}
            cells={cov.heatmap.cells}
            valueLabel={`${cov.heatmap.value} per day`}
            height={Math.max(160, 40 + cov.heatmap.years.length * 22)}
          />
        </>
      )}
    </div>
  );
}

function CaveatsPanel({
  entry,
  isAdmin,
  patch,
}: {
  entry: CatalogDetail;
  isAdmin: boolean;
  patch: (b: NonNullable<CatalogDetail['curated']>) => Promise<void>;
}) {
  const [text, setText] = useState('');
  const [severity, setSeverity] = useState<'info' | 'warn' | 'blocking'>('warn');
  const curated = entry.curated?.caveats ?? [];
  const dismissed = entry.curated?.dismissedCaveats ?? [];
  const tone = (s: string) => (s === 'blocking' ? 'failed' : s === 'warn' ? 'warn' : 'ok');
  return (
    <div className="caveats-panel">
      {!entry.caveats.length && <p className="muted-line">No caveats.</p>}
      <ul className="caveat-list">
        {entry.caveats.map((c) => (
          <li key={c.id}>
            <StatusPill status={tone(c.severity)} label={c.severity} />
            <span>{c.text}</span>
            <small className="muted-line">
              {c.source}
              {c.fix ? ` · lifted by ${c.fix}` : ''}
            </small>
            {isAdmin && (
              <IconButton
                title={c.source === 'curated' ? 'Remove this caveat' : 'Dismiss this caveat'}
                onClick={() =>
                  void (c.source === 'curated'
                    ? patch({ caveats: curated.filter((x) => x.id !== c.id) })
                    : patch({ dismissedCaveats: [...dismissed, c.id] }))
                }
              >
                <X size={13} />
              </IconButton>
            )}
          </li>
        ))}
      </ul>
      {isAdmin && dismissed.length > 0 && (
        <p className="muted-line">
          Dismissed: {dismissed.join(', ')}{' '}
          <button className="link-button" onClick={() => void patch({ dismissedCaveats: [] })}>
            restore all
          </button>
        </p>
      )}
      {isAdmin && (
        <div className="caveat-add">
          <select
            aria-label="Caveat severity"
            value={severity}
            onChange={(x) => setSeverity(x.target.value as typeof severity)}
          >
            <option value="info">info</option>
            <option value="warn">warn</option>
            <option value="blocking">blocking</option>
          </select>
          <input
            aria-label="New caveat"
            placeholder="Add a known data problem…"
            value={text}
            onChange={(x) => setText(x.target.value)}
          />
          <Button
            disabled={!text.trim()}
            onClick={async () => {
              const id = `c-${
                text
                  .toLowerCase()
                  .replace(/[^a-z0-9]+/g, '-')
                  .replace(/^-|-$/g, '')
                  .slice(0, 40) || 'note'
              }`;
              await patch({
                caveats: [...curated.filter((x) => x.id !== id), { id, severity, text: text.trim() }],
              });
              setText('');
            }}
          >
            Add caveat
          </Button>
        </div>
      )}
    </div>
  );
}

function AgentView({ name }: { name: string }) {
  const [v, setV] = useState<{ text: string; tokens: number } | null>(null);
  useEffect(() => {
    void fetchAgentView(name).then(setV, () => undefined);
  }, [name]);
  if (!v) return <Skeleton rows={4} />;
  return (
    <div className="agent-view">
      <p className="muted-line">
        Exactly what <code>describe_collection</code> returns to an agent · about {v.tokens.toLocaleString()}{' '}
        tokens
        <Button variant="ghost" onClick={() => void navigator.clipboard?.writeText(v.text)}>
          Copy
        </Button>
      </p>
      <pre className="run-log">{v.text}</pre>
    </div>
  );
}

/** A field's example value: numbers rounded (no float noise), long text and objects shortened. */
function exampleText(v: unknown): string {
  if (v === undefined || v === null) return '—';
  if (typeof v === 'number') return Number.isInteger(v) ? String(v) : String(Number(v.toPrecision(6)));
  const t = typeof v === 'object' ? JSON.stringify(v) : String(v);
  return t.length > 40 ? `${t.slice(0, 39)}…` : t;
}
