// #74 The ECharts canvas, loaded lazily (charts.tsx): only the chart types and components we use are bundled.
import React, { useEffect, useRef } from 'react';
import * as echarts from 'echarts/core';
import { BarChart, HeatmapChart, LineChart } from 'echarts/charts';
import {
  DataZoomComponent,
  GridComponent,
  LegendComponent,
  TooltipComponent,
  VisualMapComponent,
  AxisPointerComponent,
} from 'echarts/components';
import { CanvasRenderer } from 'echarts/renderers';

echarts.use([
  LineChart,
  BarChart,
  HeatmapChart,
  GridComponent,
  TooltipComponent,
  LegendComponent,
  DataZoomComponent,
  VisualMapComponent,
  AxisPointerComponent,
  CanvasRenderer,
]);

export type EChartHandle = {
  png: () => string;
  zoom: (startIndex: number, endIndex: number) => void;
};
export type EChartProps = {
  option: echarts.EChartsCoreOption;
  height: number;
  /** Charts with the same group share their crosshair (stacked charts). */
  group?: string;
  onReady?: (h: EChartHandle) => void;
  ariaLabel: string;
};

export default function EChart({ option, height, group, onReady, ariaLabel }: EChartProps) {
  const el = useRef<HTMLDivElement>(null);
  const chart = useRef<echarts.ECharts | null>(null);
  useEffect(() => {
    const c = echarts.init(el.current!, undefined, { renderer: 'canvas' });
    chart.current = c;
    const ro = new ResizeObserver(() => c.resize());
    ro.observe(el.current!);
    onReady?.({
      png: () => c.getDataURL({ type: 'png', pixelRatio: 2, backgroundColor: '#ffffff' }),
      zoom: (startValue, endValue) => c.dispatchAction({ type: 'dataZoom', startValue, endValue }),
    });
    return () => {
      ro.disconnect();
      c.dispose();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  useEffect(() => {
    chart.current?.setOption(option, { notMerge: true });
  }, [option]);
  useEffect(() => {
    if (!chart.current || !group) return;
    chart.current.group = group;
    echarts.connect(group);
  }, [group]);
  return <div ref={el} className="echart" style={{ height }} role="img" aria-label={ariaLabel} />;
}
