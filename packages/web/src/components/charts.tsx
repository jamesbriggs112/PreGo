import { useState } from 'react';
import { cn } from '@/lib/utils';

// Small, dependency-free charts for the dashboard. Each has a text summary for assistive technology
// (role="img" + aria-label) and hover tooltips; colours come from the brand tokens in index.css.

/** A single-series trend line. The card's title names the series, so there's no legend. */
export function Sparkline({ values, label, className }: { values: number[]; label: string; className?: string }) {
  // Drawn in a 200 × 40 box and stretched to its container's width.
  const width = 200;
  const height = 40;
  if (values.length < 2) return <span className="text-xs text-muted-foreground">Not enough audits for a trend yet</span>;
  const min = Math.min(...values);
  const max = Math.max(...values);
  const span = max - min || 1;
  const points = values.map((v, i) => [(i / (values.length - 1)) * (width - 4) + 2, height - 3 - ((v - min) / span) * (height - 6)] as const);
  const path = points.map(([x, y], i) => `${i ? 'L' : 'M'}${x.toFixed(1)},${y.toFixed(1)}`).join(' ');
  const [lx, ly] = points.at(-1)!;
  return (
    <svg viewBox={`0 0 ${width} ${height}`} preserveAspectRatio="none" role="img" aria-label={label} className={cn('h-10 w-full overflow-visible text-primary', className)}>
      <path d={`${path} L${width - 2},${height} L2,${height} Z`} fill="currentColor" opacity={0.08} />
      <path d={path} fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" vectorEffect="non-scaling-stroke" />
      <circle cx={lx} cy={ly} r={3} fill="currentColor" stroke="var(--card)" strokeWidth={2} vectorEffect="non-scaling-stroke" />
    </svg>
  );
}

/** A score out of 100 as a ring, with the number in the middle. */
export function ScoreRing({ score, label, size = 112 }: { score: number | null; label: string; size?: number }) {
  const stroke = 10;
  const r = (size - stroke) / 2;
  const circumference = 2 * Math.PI * r;
  const value = score ?? 0;
  return (
    <div className="relative" style={{ width: size, height: size }} role="img" aria-label={score === null ? `${label}: not checked` : `${label}: ${score} out of 100`}>
      <svg width={size} height={size} className="-rotate-90" aria-hidden="true">
        <circle cx={size / 2} cy={size / 2} r={r} fill="none" stroke="var(--brand-100)" strokeWidth={stroke} />
        <circle
          cx={size / 2}
          cy={size / 2}
          r={r}
          fill="none"
          stroke="url(#score-gradient)"
          strokeWidth={stroke}
          strokeLinecap="round"
          strokeDasharray={`${(value / 100) * circumference} ${circumference}`}
        />
        <defs>
          <linearGradient id="score-gradient" x1="0" y1="0" x2="1" y2="1">
            <stop offset="0" stopColor="var(--brand-500)" />
            <stop offset="1" stopColor="var(--violet-500)" />
          </linearGradient>
        </defs>
      </svg>
      <div className="absolute inset-0 flex flex-col items-center justify-center" aria-hidden="true">
        <span className="text-3xl font-bold tracking-tight">{score ?? '–'}</span>
        <span className="text-xs text-muted-foreground">/ 100</span>
      </div>
    </div>
  );
}

export interface HeatmapCell {
  row: string;
  column: string;
  value: number;
}

/**
 * Counts on a grid (e.g. category × severity), shaded with one hue from light to dark. Every cell
 * shows its number, so the shading is never the only way to read it.
 */
export function Heatmap({ rows, columns, cells, label }: { rows: string[]; columns: string[]; cells: HeatmapCell[]; label: string }) {
  const max = Math.max(1, ...cells.map((c) => c.value));
  const value = (row: string, column: string) => cells.find((c) => c.row === row && c.column === column)?.value ?? 0;
  // Five steps of the brand ramp: empty, then light to dark.
  const STEPS = ['var(--brand-50)', 'var(--brand-100)', 'var(--brand-300)', 'var(--brand-500)', 'var(--brand-700)'];
  const step = (v: number) => (v === 0 ? 0 : Math.min(4, 1 + Math.floor((v / max) * 3.999)));
  return (
    <table className="w-full table-fixed border-separate border-spacing-1 text-xs" aria-label={label}>
      <thead>
        <tr>
          <th scope="col" className="w-28">
            <span className="sr-only">Category</span>
          </th>
          {columns.map((c) => (
            <th key={c} scope="col" className="pb-1 text-center font-medium text-muted-foreground">
              {c}
            </th>
          ))}
        </tr>
      </thead>
      <tbody>
        {rows.map((row) => (
          <tr key={row}>
            <th scope="row" className="truncate pr-2 text-left font-medium text-muted-foreground">
              {row}
            </th>
            {columns.map((column) => {
              const v = value(row, column);
              const s = step(v);
              return (
                <td
                  key={column}
                  title={`${row}, ${column}: ${v} ${v === 1 ? 'ticket' : 'tickets'}`}
                  className={cn('h-9 rounded-md text-center font-semibold', s >= 3 ? 'text-white' : 'text-foreground', v === 0 && 'text-muted-foreground')}
                  style={{ background: STEPS[s] }}
                >
                  {v}
                </td>
              );
            })}
          </tr>
        ))}
      </tbody>
    </table>
  );
}

export interface HistoryBar {
  key: string | number;
  label: string;
  value: number;
  /** Shown in the tooltip, e.g. the project and date. */
  detail: string;
}

/** One bar per audit, oldest to newest. Hovering or focusing a bar shows its details. */
export function HistoryBars({ bars, label, unit }: { bars: HistoryBar[]; label: string; unit: string }) {
  const [active, setActive] = useState<number | null>(null);
  const max = Math.max(1, ...bars.map((b) => b.value));
  const height = 120;
  return (
    <div className="relative">
      <div className="flex h-[150px] items-end gap-3 overflow-x-auto" role="list" aria-label={label}>
        {bars.map((bar, i) => (
          <div
            key={bar.key}
            role="listitem"
            tabIndex={0}
            aria-label={`${bar.detail}: ${bar.value} ${unit}`}
            onMouseEnter={() => setActive(i)}
            onMouseLeave={() => setActive(null)}
            onFocus={() => setActive(i)}
            onBlur={() => setActive(null)}
            className="group flex w-14 shrink-0 flex-col items-center justify-end gap-1 rounded-md outline-offset-2"
          >
            <div
              className={cn('w-8 rounded-t-[4px] transition-colors', active === i ? 'bg-primary' : 'bg-[var(--brand-300)]')}
              style={{ height: Math.max(3, (bar.value / max) * height) }}
            />
            <span className="w-full truncate text-center text-[11px] text-muted-foreground">{bar.label}</span>
          </div>
        ))}
      </div>
      {active !== null && (
        <div
          role="status"
          className="pointer-events-none absolute -top-2 rounded-md bg-foreground px-2.5 py-1.5 text-xs text-background shadow-md"
          style={{ left: active * 68 }}
        >
          <span className="font-semibold">
            {bars[active].value} {unit}
          </span>
          <span className="block opacity-80">{bars[active].detail}</span>
        </div>
      )}
    </div>
  );
}
