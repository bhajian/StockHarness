// Shared UI components (#73), used by Datasets (Syncs/Transforms/Catalog/Health) and later Research, Ideas,
// Simulations and Signals. Uses the studio's CSS tokens; status is always icon + text, never color alone.
import React, { useEffect, type ReactNode } from 'react';
import {
  AlertTriangle,
  Ban,
  CheckCircle2,
  Circle,
  CircleDashed,
  Clock,
  ExternalLink,
  Loader2,
  PauseCircle,
  X,
  XCircle,
} from 'lucide-react';

type PillTone = 'green' | 'amber' | 'red' | 'blue' | 'gray' | 'outline' | 'magenta' | 'green-solid';
/** The fixed vocabulary: data states, run states and idea states. */
const PILL: Record<string, { tone: PillTone; icon: typeof Circle; spin?: boolean }> = {
  fresh: { tone: 'green', icon: CheckCircle2 },
  ok: { tone: 'green', icon: CheckCircle2 },
  succeeded: { tone: 'green', icon: CheckCircle2 },
  completed: { tone: 'green', icon: CheckCircle2 },
  ready: { tone: 'green', icon: CheckCircle2 },
  successful: { tone: 'green', icon: CheckCircle2 },
  approved: { tone: 'green-solid', icon: CheckCircle2 },
  stale: { tone: 'amber', icon: AlertTriangle },
  warn: { tone: 'amber', icon: AlertTriangle },
  failed: { tone: 'red', icon: XCircle },
  error: { tone: 'red', icon: XCircle },
  blocked: { tone: 'red', icon: Ban },
  running: { tone: 'blue', icon: Loader2, spin: true },
  'in review': { tone: 'blue', icon: Loader2, spin: true },
  coding: { tone: 'blue', icon: Loader2, spin: true },
  evaluating: { tone: 'blue', icon: Loader2, spin: true },
  queued: { tone: 'gray', icon: Clock },
  pending: { tone: 'gray', icon: Clock },
  draft: { tone: 'gray', icon: CircleDashed },
  parked: { tone: 'gray', icon: PauseCircle },
  paused: { tone: 'gray', icon: PauseCircle },
  cancelled: { tone: 'gray', icon: Ban },
  disabled: { tone: 'outline', icon: Circle },
  'forward-only': { tone: 'magenta', icon: Clock },
};
export function StatusPill({ status, label }: { status: string; label?: string }) {
  const s = PILL[status] ?? { tone: 'gray' as PillTone, icon: Circle };
  const Icon = s.icon;
  return (
    <span className={`pill pill-${s.tone}`}>
      <Icon size={12} className={s.spin ? 'spin' : undefined} aria-hidden="true" />
      {label ?? status}
    </span>
  );
}

/** KPI card: icon tile, label, big number, optional delta chip, sparkline and footnote. */
export function KpiCard({
  icon,
  label,
  value,
  delta,
  footnote,
  spark,
}: {
  icon?: ReactNode;
  label: string;
  value: ReactNode;
  delta?: { text: string; tone?: 'up' | 'down' | 'neutral' };
  footnote?: ReactNode;
  spark?: number[];
}) {
  return (
    <div className="overview-card kpi-card">
      {icon && <div className="overview-icon">{icon}</div>}
      <div className="kpi-body">
        <span>{label}</span>
        <strong>{value}</strong>
        {delta && <em className={`kpi-delta ${delta.tone ?? 'neutral'}`}>{delta.text}</em>}
      </div>
      {spark && spark.length > 1 && <Sparkline values={spark} />}
      {footnote && <small>{footnote}</small>}
    </div>
  );
}
export function Sparkline({
  values,
  width = 80,
  height = 24,
}: {
  values: number[];
  width?: number;
  height?: number;
}) {
  const min = Math.min(...values);
  const span = Math.max(...values) - min || 1;
  const pts = values
    .map(
      (v, i) =>
        `${((i / (values.length - 1)) * width).toFixed(1)},${(height - ((v - min) / span) * height).toFixed(1)}`,
    )
    .join(' ');
  return (
    <svg
      className="sparkline"
      width={width}
      height={height}
      viewBox={`0 0 ${width} ${height}`}
      aria-hidden="true"
    >
      <polyline points={pts} fill="none" stroke="currentColor" strokeWidth="1.5" />
    </svg>
  );
}

/** Right-side drawer (520px) for quick views, with an optional "Open full page" link. */
export function Drawer({
  title,
  onClose,
  children,
  fullPage,
}: {
  title: ReactNode;
  onClose: () => void;
  children: ReactNode;
  fullPage?: { href: string; onOpen?: () => void };
}) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    addEventListener('keydown', onKey);
    return () => removeEventListener('keydown', onKey);
  }, [onClose]);
  return (
    <div className="drawer-backdrop" onClick={onClose}>
      <aside className="drawer" role="dialog" aria-modal="true" onClick={(e) => e.stopPropagation()}>
        <header className="drawer-head">
          <h2>{title}</h2>
          {fullPage && (
            <a
              href={fullPage.href}
              onClick={(e) => {
                if (fullPage.onOpen) {
                  e.preventDefault();
                  fullPage.onOpen();
                }
              }}
            >
              Open full page <ExternalLink size={13} />
            </a>
          )}
          <button className="icon-button" aria-label="Close" onClick={onClose}>
            <X size={17} />
          </button>
        </header>
        <div className="drawer-body">{children}</div>
      </aside>
    </div>
  );
}

export type TimelineEvent = {
  id: string;
  at: string | Date;
  role?: string;
  title: ReactNode;
  body?: ReactNode;
  status?: string;
};
/** Vertical event list: run history, agent debates, idea lifecycles. */
export function Timeline({ events }: { events: TimelineEvent[] }) {
  return (
    <ol className="timeline">
      {events.map((e) => (
        <li key={e.id}>
          <span className="timeline-dot" aria-hidden="true">
            {e.role ? e.role[0]?.toUpperCase() : ''}
          </span>
          <div>
            <div className="timeline-head">
              <strong>{e.title}</strong>
              {e.status && <StatusPill status={e.status} />}
              <time>{new Date(e.at).toLocaleString()}</time>
            </div>
            {e.body && (
              <details>
                <summary>Details</summary>
                <div className="timeline-body">{e.body}</div>
              </details>
            )}
          </div>
        </li>
      ))}
    </ol>
  );
}

export type Gate = {
  name: string;
  value: ReactNode;
  threshold: ReactNode;
  pass: boolean | null;
  definition?: string;
};
/** One row per gate: name, value, threshold, pass/fail, definition on hover. */
export function GateChecklist({ gates }: { gates: Gate[] }) {
  return (
    <table className="gate-checklist">
      <thead>
        <tr>
          <th>Gate</th>
          <th>Value</th>
          <th>Threshold</th>
          <th>Result</th>
        </tr>
      </thead>
      <tbody>
        {gates.map((g) => (
          <tr key={g.name} title={g.definition}>
            <td>{g.name}</td>
            <td>{g.value}</td>
            <td>{g.threshold}</td>
            <td>
              <StatusPill
                status={g.pass === null ? 'warn' : g.pass ? 'ok' : 'failed'}
                label={g.pass === null ? 'warn' : g.pass ? 'pass' : 'fail'}
              />
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

/** Skeleton rows while a list loads. */
export function Skeleton({ rows = 4 }: { rows?: number }) {
  return (
    <div className="skeleton" aria-busy="true" aria-label="Loading">
      {Array.from({ length: rows }, (_, i) => (
        <span key={i} />
      ))}
    </div>
  );
}

/** Page tabs bound to the URL. */
export function Tabs<T extends string>({
  tabs,
  value,
  onChange,
}: {
  tabs: { id: T; label: string; icon?: ReactNode; badge?: ReactNode }[];
  value: T;
  onChange: (t: T) => void;
}) {
  return (
    <div className="tabs page-tabs" role="tablist">
      {tabs.map((t) => (
        <button
          key={t.id}
          role="tab"
          aria-selected={value === t.id}
          className={value === t.id ? 'active' : ''}
          onClick={() => onChange(t.id)}
        >
          {t.icon}
          {t.label}
          {t.badge}
        </button>
      ))}
    </div>
  );
}

export type FilterDef = {
  id: string;
  label: string;
  value: string;
  options: { value: string; label?: string }[];
  onChange: (v: string) => void;
  /** Label of the empty option ("All …"). */
  all?: string;
};
/**
 * A one-row filter bar (#303): search, a Filters button that opens a popover with the selects, the active filters
 * as removable chips, and the match count. Replaces rows of full-width selects.
 */
export function FilterBar({
  search,
  onSearch,
  placeholder = 'Search',
  filters,
  shown,
  total,
}: {
  search: string;
  onSearch: (v: string) => void;
  placeholder?: string;
  filters: FilterDef[];
  shown?: number;
  total?: number;
}) {
  const [open, setOpen] = React.useState(false);
  const ref = React.useRef<HTMLDivElement>(null);
  const active = filters.filter((f) => f.value);
  useEffect(() => {
    if (!open) return;
    const close = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    const esc = (e: KeyboardEvent) => e.key === 'Escape' && setOpen(false);
    addEventListener('mousedown', close);
    addEventListener('keydown', esc);
    return () => {
      removeEventListener('mousedown', close);
      removeEventListener('keydown', esc);
    };
  }, [open]);
  const labelOf = (f: FilterDef) => f.options.find((o) => o.value === f.value)?.label ?? f.value;
  return (
    <div className="filter-row" role="search" ref={ref}>
      <label className="filter-search">
        <input
          aria-label={placeholder}
          placeholder={placeholder}
          value={search}
          onChange={(e) => onSearch(e.target.value)}
        />
      </label>
      <button
        type="button"
        className={`button secondary filter-button${active.length ? ' has-active' : ''}`}
        aria-expanded={open}
        aria-haspopup="dialog"
        onClick={() => setOpen(!open)}
      >
        Filters{active.length ? ` (${active.length})` : ''}
      </button>
      {active.map((f) => (
        <button
          key={f.id}
          type="button"
          className="filter-chip"
          title={`Remove the ${f.label} filter`}
          onClick={() => f.onChange('')}
        >
          {f.label}: {labelOf(f)} <X size={12} aria-hidden="true" />
        </button>
      ))}
      {shown !== undefined && total !== undefined && shown !== total && (
        <span className="muted-line">
          {shown} of {total}
        </span>
      )}
      {open && (
        <div className="filter-popover" role="dialog" aria-label="Filters">
          {filters.map((f) => (
            <label key={f.id} className="filter-field">
              <span>{f.label}</span>
              <select aria-label={f.label} value={f.value} onChange={(e) => f.onChange(e.target.value)}>
                <option value="">{f.all ?? `All`}</option>
                {f.options.map((o) => (
                  <option key={o.value} value={o.value}>
                    {o.label ?? o.value}
                  </option>
                ))}
              </select>
            </label>
          ))}
          <div className="filter-popover-actions">
            <button
              type="button"
              className="link-button"
              disabled={!active.length}
              onClick={() => active.forEach((f) => f.onChange(''))}
            >
              Clear all
            </button>
            <button type="button" className="button secondary small" onClick={() => setOpen(false)}>
              Done
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
