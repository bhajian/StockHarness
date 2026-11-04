// #74 Chart components on the standard series payload `{ dates, series }`:
// TimeSeriesChart (crosshair tooltip with every series, 1Y/3Y/5Y/Max presets, log toggle, zoom, synced
// crosshair via `group`, PNG/CSV export, table view), BarChart, HeatmapChart and Histogram.
// Identity is never colour alone: ≥ 2 series get a legend; every chart has a table view.
import React, { lazy, Suspense, useMemo, useRef, useState } from 'react';
import { Download, Image, Table2 } from 'lucide-react';
import type { EChartHandle } from './EChart';
import {
  INK,
  PRESETS,
  SEQUENTIAL,
  SERIES_COLORS,
  escapeHtml,
  fmtNumber,
  histogramBins,
  presetStart,
  seriesCsv,
  type Preset,
  type SeriesPayload,
} from './chartData';

const EChart = lazy(() => import('./EChart'));

const axisStyle = {
  axisLine: { lineStyle: { color: INK.axis } },
  axisTick: { show: false },
  axisLabel: { color: INK.secondary, fontSize: 11 },
  splitLine: { lineStyle: { color: INK.grid } },
};
const download = (href: string, name: string) => {
  const a = Object.assign(document.createElement('a'), { href, download: name });
  a.click();
};
const fileName = (title: string, ext: string) => `${title.toLowerCase().replace(/[^a-z0-9]+/g, '-')}.${ext}`;

function ChartFrame({
  title,
  subtitle,
  tools,
  table,
  children,
}: {
  title: string;
  subtitle?: React.ReactNode;
  tools?: React.ReactNode;
  table?: React.ReactNode;
  children: React.ReactNode;
}) {
  const [showTable, setShowTable] = useState(false);
  return (
    <figure className="chart-card">
      <figcaption className="chart-head">
        <div>
          <strong>{title}</strong>
          {subtitle && <small>{subtitle}</small>}
        </div>
        <div className="chart-tools">
          {tools}
          {table && (
            <button
              className={`chart-tool${showTable ? ' active' : ''}`}
              aria-pressed={showTable}
              onClick={() => setShowTable(!showTable)}
              title="Show the data as a table"
            >
              <Table2 size={14} /> Table
            </button>
          )}
        </div>
      </figcaption>
      <Suspense fallback={<div className="echart-loading" />}>{children}</Suspense>
      {showTable && <div className="chart-table">{table}</div>}
    </figure>
  );
}

function SeriesTable({ data, unit }: { data: SeriesPayload; unit?: string }) {
  const names = Object.keys(data.series);
  return (
    <table>
      <thead>
        <tr>
          <th>Date</th>
          {names.map((n) => (
            <th key={n}>
              {n}
              {unit ? ` (${unit})` : ''}
            </th>
          ))}
        </tr>
      </thead>
      <tbody>
        {data.dates.map((d, i) => (
          <tr key={d + i}>
            <td>{d}</td>
            {names.map((n) => (
              <td key={n}>{fmtNumber(data.series[n][i])}</td>
            ))}
          </tr>
        ))}
      </tbody>
    </table>
  );
}

export function TimeSeriesChart({
  data,
  title,
  subtitle,
  unit,
  height = 280,
  group,
  kind = 'line',
  presets = true,
  logToggle = true,
}: {
  data: SeriesPayload & { downsampled?: number };
  title: string;
  subtitle?: React.ReactNode;
  unit?: string;
  height?: number;
  group?: string;
  kind?: 'line' | 'bar';
  presets?: boolean;
  logToggle?: boolean;
}) {
  const handle = useRef<EChartHandle | null>(null);
  const [preset, setPreset] = useState<Preset>('Max');
  const [log, setLog] = useState(false);
  const names = Object.keys(data.series);
  const option = useMemo(
    () => ({
      animation: false,
      color: SERIES_COLORS,
      grid: { left: 56, right: 18, top: names.length > 1 ? 34 : 14, bottom: 56 },
      legend:
        names.length > 1
          ? {
              top: 0,
              left: 0,
              icon: kind === 'line' ? 'roundRect' : 'rect',
              itemWidth: 14,
              itemHeight: kind === 'line' ? 3 : 10,
              textStyle: { color: INK.primary },
            }
          : undefined,
      tooltip: {
        trigger: 'axis',
        axisPointer: { type: 'line', lineStyle: { color: INK.muted, width: 1 } },
        // Values lead, labels follow; names are escaped (they can come from data).
        formatter: (ps: { axisValueLabel: string; seriesName: string; value: unknown; color: string }[]) =>
          `<div class="chart-tip"><div class="chart-tip-date">${escapeHtml(ps[0]?.axisValueLabel ?? '')}</div>${ps
            .map(
              (p) =>
                `<div><span class="chart-tip-key" style="background:${p.color}"></span><b>${escapeHtml(fmtNumber(p.value))}</b> ${escapeHtml(p.seriesName)}</div>`,
            )
            .join('')}</div>`,
      },
      xAxis: {
        type: 'category',
        data: data.dates,
        boundaryGap: kind === 'bar',
        ...axisStyle,
        splitLine: { show: false },
      },
      yAxis: {
        type: log ? 'log' : 'value',
        scale: !log && kind === 'line',
        ...axisStyle,
        axisLabel: { ...axisStyle.axisLabel, formatter: (v: number) => fmtNumber(v) },
      },
      dataZoom: [
        { type: 'inside', startValue: presetStart(data.dates, preset), endValue: data.dates.length - 1 },
        {
          type: 'slider',
          height: 18,
          bottom: 8,
          borderColor: INK.axis,
          brushSelect: false,
          showDetail: false,
        },
      ],
      series: names.map((n) => ({
        name: n,
        type: kind,
        data: data.series[n].map((v) => (log && v !== null && v <= 0 ? null : v)),
        showSymbol: false,
        symbolSize: 8,
        connectNulls: false,
        lineStyle: { width: 2 },
        barMaxWidth: 18,
        itemStyle: kind === 'bar' ? { borderRadius: [4, 4, 0, 0] } : undefined,
      })),
    }),
    [data, names.join('\u0000'), kind, log, preset],
  );
  return (
    <ChartFrame
      title={title}
      subtitle={
        <>
          {subtitle}
          {data.downsampled
            ? ` · ${data.dates.length.toLocaleString()} of ${data.downsampled.toLocaleString()} points`
            : ''}
        </>
      }
      tools={
        <>
          {presets && (
            <span className="chart-presets" role="group" aria-label="Range">
              {PRESETS.map((p) => (
                <button
                  key={p}
                  className={`chart-tool${preset === p ? ' active' : ''}`}
                  aria-pressed={preset === p}
                  onClick={() => setPreset(p)}
                >
                  {p}
                </button>
              ))}
            </span>
          )}
          {logToggle && (
            <label className="chart-tool">
              <input type="checkbox" checked={log} onChange={(e) => setLog(e.target.checked)} /> Log
            </label>
          )}
          <button
            className="chart-tool"
            title="Download PNG"
            onClick={() => handle.current && download(handle.current.png(), fileName(title, 'png'))}
          >
            <Image size={14} />
          </button>
          <button
            className="chart-tool"
            title="Download CSV"
            onClick={() => {
              const url = URL.createObjectURL(new Blob([seriesCsv(data)], { type: 'text/csv' }));
              download(url, fileName(title, 'csv'));
              URL.revokeObjectURL(url);
            }}
          >
            <Download size={14} />
          </button>
        </>
      }
      table={<SeriesTable data={data} unit={unit} />}
    >
      <EChart
        option={option}
        height={height}
        group={group}
        ariaLabel={`${title}: ${names.join(', ')}`}
        onReady={(h) => (handle.current = h)}
      />
    </ChartFrame>
  );
}

export function BarChart({
  categories,
  series,
  title,
  subtitle,
  height = 240,
  horizontal = false,
}: {
  categories: string[];
  series: Record<string, number[]>;
  title: string;
  subtitle?: React.ReactNode;
  height?: number;
  horizontal?: boolean;
}) {
  const names = Object.keys(series);
  const cat = { type: 'category', data: categories, ...axisStyle, splitLine: { show: false } };
  const val = {
    type: 'value',
    ...axisStyle,
    axisLabel: { ...axisStyle.axisLabel, formatter: (v: number) => fmtNumber(v) },
  };
  const option = useMemo(
    () => ({
      animation: false,
      color: SERIES_COLORS,
      grid: { left: horizontal ? 120 : 56, right: 18, top: names.length > 1 ? 34 : 14, bottom: 30 },
      legend: names.length > 1 ? { top: 0, left: 0, icon: 'rect', itemWidth: 10, itemHeight: 10 } : undefined,
      tooltip: {
        trigger: 'item',
        formatter: (p: { name: string; seriesName: string; value: unknown }) =>
          `<div class="chart-tip"><b>${escapeHtml(fmtNumber(p.value))}</b> ${escapeHtml(p.name)}${names.length > 1 ? ` · ${escapeHtml(p.seriesName)}` : ''}</div>`,
      },
      xAxis: horizontal ? val : cat,
      yAxis: horizontal ? cat : val,
      series: names.map((n) => ({
        name: n,
        type: 'bar',
        data: series[n],
        barMaxWidth: 22,
        barGap: '8%',
        itemStyle: {
          borderRadius: horizontal ? [0, 4, 4, 0] : [4, 4, 0, 0],
          borderColor: '#fff',
          borderWidth: 1,
        },
        emphasis: { itemStyle: { opacity: 0.85 } },
      })),
    }),
    [categories, series, horizontal, names.join('\u0000')],
  );
  return (
    <ChartFrame
      title={title}
      subtitle={subtitle}
      table={
        <table>
          <thead>
            <tr>
              <th />
              {names.map((n) => (
                <th key={n}>{n}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {categories.map((c, i) => (
              <tr key={c}>
                <td>{c}</td>
                {names.map((n) => (
                  <td key={n}>{fmtNumber(series[n][i])}</td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      }
    >
      <EChart option={option} height={height} ariaLabel={title} />
    </ChartFrame>
  );
}

export function Histogram({
  values,
  title,
  bins = 20,
  height = 220,
}: {
  values: number[];
  title: string;
  bins?: number;
  height?: number;
}) {
  const b = useMemo(() => histogramBins(values, bins), [values, bins]);
  return (
    <BarChart
      title={title}
      subtitle={`${values.length.toLocaleString()} values`}
      categories={b.map((x) => `${fmtNumber(x.from)}–${fmtNumber(x.to)}`)}
      series={{ count: b.map((x) => x.count) }}
      height={height}
    />
  );
}

/** A heatmap of [x, y, value] cells on a sequential (one-hue) ramp, e.g. year × day-of-year coverage. */
export function HeatmapChart({
  x,
  y,
  cells,
  title,
  subtitle,
  valueLabel = 'value',
  height = 260,
}: {
  x: string[];
  y: string[];
  cells: [number, number, number][];
  title: string;
  subtitle?: React.ReactNode;
  valueLabel?: string;
  height?: number;
}) {
  const max = Math.max(1, ...cells.map((c) => c[2]));
  const option = useMemo(
    () => ({
      animation: false,
      grid: { left: 56, right: 18, top: 10, bottom: 52 },
      tooltip: {
        formatter: (p: { value: [number, number, number] }) =>
          `<div class="chart-tip"><b>${escapeHtml(fmtNumber(p.value[2]))}</b> ${escapeHtml(valueLabel)}<div class="chart-tip-date">${escapeHtml(y[p.value[1]])} · ${escapeHtml(x[p.value[0]])}</div></div>`,
      },
      xAxis: {
        type: 'category',
        data: x,
        ...axisStyle,
        splitLine: { show: false },
        axisLabel: { ...axisStyle.axisLabel, interval: Math.ceil(x.length / 12) - 1 },
      },
      yAxis: { type: 'category', data: y, ...axisStyle, splitLine: { show: false } },
      visualMap: {
        min: 0,
        max,
        orient: 'horizontal',
        left: 'center',
        bottom: 0,
        itemHeight: 120,
        itemWidth: 10,
        inRange: { color: SEQUENTIAL },
        textStyle: { color: INK.secondary, fontSize: 11 },
        calculable: false,
      },
      series: [
        {
          type: 'heatmap',
          data: cells,
          itemStyle: { borderColor: '#fff', borderWidth: 1 },
          emphasis: { itemStyle: { borderColor: INK.primary } },
        },
      ],
    }),
    [x, y, cells, max, valueLabel],
  );
  return (
    <ChartFrame
      title={title}
      subtitle={subtitle}
      table={
        <table>
          <thead>
            <tr>
              <th />
              <th />
              <th>{valueLabel}</th>
            </tr>
          </thead>
          <tbody>
            {cells.map(([cx, cy, v]) => (
              <tr key={`${cx}-${cy}`}>
                <td>{y[cy]}</td>
                <td>{x[cx]}</td>
                <td>{fmtNumber(v)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      }
    >
      <EChart option={option} height={height} ariaLabel={title} />
    </ChartFrame>
  );
}
