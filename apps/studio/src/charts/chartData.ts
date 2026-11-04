// Pure chart helpers (#74): palette slots, range presets, CSV and histogram bins. Unit-tested.
import type { SeriesPayload } from '../../../../packages/core/src/series.js';
export type { SeriesPayload };

/**
 * Categorical slots in fixed order (validated: CVD-adjacent ΔE ≥ 9.1, normal-vision ≥ 19.6 on the white
 * surface). Slots 3–5 are below 3:1 contrast, so charts always carry a legend and a table view.
 */
export const SERIES_COLORS = [
  '#2a78d6',
  '#eb6834',
  '#1baf7a',
  '#eda100',
  '#e87ba4',
  '#008300',
  '#6250d6',
  '#e34948',
];
/** Sequential blue ramp (magnitude: heatmaps). */
export const SEQUENTIAL = ['#cde2fb', '#9ec5f4', '#6da7ec', '#3987e5', '#256abf', '#184f95', '#0d366b'];
export const INK = {
  primary: '#242625',
  secondary: '#626761',
  muted: '#737970',
  grid: '#eceee9',
  axis: '#dfe2dd',
};

export const PRESETS = ['1Y', '3Y', '5Y', 'Max'] as const;
export type Preset = (typeof PRESETS)[number];
/** Index of the first date inside a preset window ending at the last date. */
export function presetStart(dates: string[], preset: Preset): number {
  if (preset === 'Max' || !dates.length) return 0;
  const years = Number(preset.slice(0, -1));
  const last = new Date(`${dates[dates.length - 1].slice(0, 10)}T00:00:00Z`);
  const from = new Date(Date.UTC(last.getUTCFullYear() - years, last.getUTCMonth(), last.getUTCDate()))
    .toISOString()
    .slice(0, 10);
  const i = dates.findIndex((d) => d.slice(0, 10) >= from);
  return i < 0 ? 0 : i;
}
/** The payload as CSV: date column plus one column per series. */
export function seriesCsv(p: SeriesPayload): string {
  const names = Object.keys(p.series);
  const q = (s: string) => (/[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s);
  return [
    ['date', ...names].map(q).join(','),
    ...p.dates.map((d, i) => [d, ...names.map((n) => (p.series[n][i] ?? '') + '')].map(q).join(',')),
  ].join('\n');
}
/** Equal-width histogram bins. */
export function histogramBins(values: number[], bins = 20) {
  const v = values.filter((x) => Number.isFinite(x));
  if (!v.length) return [];
  const lo = Math.min(...v);
  const hi = Math.max(...v);
  const w = (hi - lo) / bins || 1;
  const counts = Array(bins).fill(0);
  for (const x of v) counts[Math.min(bins - 1, Math.floor((x - lo) / w))]++;
  return counts.map((count, i) => ({ from: lo + i * w, to: lo + (i + 1) * w, count }));
}
export const escapeHtml = (s: string) =>
  s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
export const fmtNumber = (v: unknown) =>
  typeof v !== 'number' || !Number.isFinite(v)
    ? '—'
    : Math.abs(v) >= 1e9
      ? `${(v / 1e9).toFixed(2)}B`
      : Math.abs(v) >= 1e6
        ? `${(v / 1e6).toFixed(2)}M`
        : Math.abs(v) >= 1e4
          ? `${(v / 1e3).toFixed(1)}k`
          : Number.isInteger(v)
            ? v.toLocaleString('en-US')
            : v.toFixed(Math.abs(v) < 1 ? 4 : 2);
