import { svgToPng } from './state-map-image.js';
import type { ExportPlan } from './plan.js';
import type { CompetitorResult } from './sections.js';

// Bar charts for the report's optional sections, drawn as SVG and turned into PNGs for Word. Every
// bar carries its value as text, and the legend names each series, so nothing relies on colour alone.

export interface BarSeries {
  name: string;
  colour: string;
  values: (number | null)[];
}

const escape = (s: string) => s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!);

/** Horizontal grouped bars: one row per label, one bar per series. */
export function barChartSvg(title: string, labels: string[], series: BarSeries[], max?: number): string {
  const width = 760;
  const labelWidth = 200;
  const barHeight = 18;
  const gap = 4;
  const rowHeight = series.length * (barHeight + gap) + 14;
  const top = 64;
  const height = top + labels.length * rowHeight + 16;
  const top100 = max ?? Math.max(1, ...series.flatMap((s) => s.values.map((v) => v ?? 0)));
  const plotWidth = width - labelWidth - 70;
  const legend = series
    .map((s, i) => `<rect x="${labelWidth + i * 150}" y="34" width="12" height="12" rx="2" fill="${s.colour}"/><text x="${labelWidth + i * 150 + 18}" y="45" font-size="13" fill="#333">${escape(s.name)}</text>`)
    .join('');
  const rows = labels
    .map((label, row) => {
      const y = top + row * rowHeight;
      const bars = series
        .map((s, i) => {
          const value = s.values[row];
          const by = y + i * (barHeight + gap);
          if (value === null || value === undefined) return `<text x="${labelWidth + 4}" y="${by + 13}" font-size="12" fill="#666">no score</text>`;
          const w = Math.max(2, (value / top100) * plotWidth);
          // A 2px white gap keeps neighbouring bars apart.
          return `<rect x="${labelWidth}" y="${by}" width="${w}" height="${barHeight}" rx="3" fill="${s.colour}" stroke="#fff" stroke-width="2"/><text x="${labelWidth + w + 6}" y="${by + 13}" font-size="12" fill="#222">${value.toLocaleString('en-GB')}</text>`;
        })
        .join('');
      return `<text x="${labelWidth - 10}" y="${y + (series.length * (barHeight + gap)) / 2 + 4}" font-size="13" text-anchor="end" fill="#222">${escape(label.length > 28 ? `${label.slice(0, 27)}…` : label)}</text>${bars}`;
    })
    .join('');
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" font-family="Arial, sans-serif"><rect width="100%" height="100%" fill="#fff"/><text x="0" y="20" font-size="16" font-weight="bold" fill="#222">${escape(title)}</text>${legend}${rows}</svg>`;
}

/** The charts the report's switched-on optional sections need. */
export async function reportCharts(plan: ExportPlan): Promise<Partial<Record<'analytics' | 'competitors', Buffer>>> {
  const on = new Set(plan.outline.map((o) => o.id));
  const charts: Partial<Record<'analytics' | 'competitors', Buffer>> = {};
  if (on.has('competitors')) {
    const results = ((plan.run.summary.competitors as CompetitorResult[] | undefined) ?? []).filter((r) => !r.error);
    if (results.length) {
      const name = (r: CompetitorResult) => `${new URL(r.url).hostname.replace(/^www\./, '')}${r.own ? ' (this site)' : ''}`;
      charts.competitors = await svgToPng(
        barChartSvg('Lighthouse performance score (out of 100)', results.map(name), [
          { name: 'Desktop', colour: '#1F3A5F', values: results.map((r) => r.desktop?.performance ?? null) },
          { name: 'Mobile', colour: '#6C8EBF', values: results.map((r) => r.mobile?.performance ?? null) },
        ], 100),
      );
    }
  }
  const channels = plan.project.settings.analytics?.tables.find((t) => t.id === 'channels');
  if (on.has('analytics') && channels?.rows.length) {
    const rows = channels.rows.slice(0, 8);
    charts.analytics = await svgToPng(barChartSvg(`${channels.measure} by traffic source`, rows.map((r) => r.label), [{ name: channels.measure, colour: '#1F3A5F', values: rows.map((r) => r.value) }]));
  }
  return charts;
}
