// Standard chart series payload (#74): `{ dates: [], series: { name: [] } }`, shared by every chart (Catalog
// coverage, Health, research results). Above 5,000 points the server downsamples with LTTB
// (Largest-Triangle-Three-Buckets), always keeping the first and last points and each series' extremes.
export type SeriesPayload = { dates: string[]; series: Record<string, (number | null)[]> };
export const DOWNSAMPLE_ABOVE = 5000;

/** LTTB indices for one series (nulls are treated as gaps and never chosen as a bucket's pick). */
export function lttbIndices(values: (number | null)[], threshold: number): number[] {
  const n = values.length;
  if (threshold >= n || threshold < 3) return [...Array(n).keys()];
  const out = [0];
  const every = (n - 2) / (threshold - 2);
  let a = 0;
  for (let i = 0; i < threshold - 2; i++) {
    // Average of the next bucket (the triangle's third point).
    const nextStart = Math.floor((i + 1) * every) + 1;
    const nextEnd = Math.min(Math.floor((i + 2) * every) + 1, n);
    let avgX = 0;
    let avgY = 0;
    let cnt = 0;
    for (let j = nextStart; j < nextEnd; j++)
      if (values[j] !== null && Number.isFinite(values[j]))
        ((avgX += j), (avgY += values[j] as number), cnt++);
    if (cnt) ((avgX /= cnt), (avgY /= cnt));
    else ((avgX = nextStart), (avgY = 0));
    const start = Math.floor(i * every) + 1;
    const end = Math.floor((i + 1) * every) + 1;
    const ay = (values[a] ?? 0) as number;
    let best = -1;
    let pick = start;
    for (let j = start; j < end; j++) {
      const v = values[j];
      if (v === null || !Number.isFinite(v)) continue;
      const area = Math.abs((a - avgX) * (v - ay) - (a - j) * (avgY - ay));
      if (area > best) ((best = area), (pick = j));
    }
    out.push(pick);
    a = pick;
  }
  out.push(n - 1);
  return out;
}

/**
 * Downsample a multi-series payload to about `threshold` points: the union of every series' LTTB picks plus
 * each series' minimum and maximum, so no spike or trough disappears. Returns the payload unchanged when small.
 */
export function downsample(
  p: SeriesPayload,
  threshold = DOWNSAMPLE_ABOVE,
): SeriesPayload & { downsampled?: number } {
  const n = p.dates.length;
  if (n <= threshold) return p;
  const names = Object.keys(p.series);
  const per = Math.max(3, Math.floor(threshold / Math.max(1, names.length)));
  const keep = new Set<number>([0, n - 1]);
  for (const name of names) {
    const v = p.series[name];
    for (const i of lttbIndices(v, per)) keep.add(i);
    let lo = -1;
    let hi = -1;
    v.forEach((x, i) => {
      if (x === null || !Number.isFinite(x)) return;
      if (lo < 0 || x < (v[lo] as number)) lo = i;
      if (hi < 0 || x > (v[hi] as number)) hi = i;
    });
    if (lo >= 0) keep.add(lo);
    if (hi >= 0) keep.add(hi);
  }
  const idx = [...keep].sort((a, b) => a - b);
  return {
    dates: idx.map((i) => p.dates[i]),
    series: Object.fromEntries(names.map((name) => [name, idx.map((i) => p.series[name][i] ?? null)])),
    downsampled: n,
  };
}
