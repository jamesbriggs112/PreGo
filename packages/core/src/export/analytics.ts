import { parse } from 'csv-parse/sync';
import type { AnalyticsSummary } from '../types.js';

// Reads the CSV files Google Analytics 4 exports (Reports → Share → Download file → CSV) for the
// report's Analytics section. Only the figures are kept: GA's comment lines (account, property) are
// dropped, and nothing about individual visitors is in these reports anyway.

type TableId = AnalyticsSummary['tables'][number]['id'];

const DIMENSIONS: { id: TableId; title: string; header: RegExp }[] = [
  { id: 'channels', title: 'How people find the site', header: /channel group|source \/ medium|^(session |first user )?source$/i },
  { id: 'devices', title: 'Devices', header: /^device category$/i },
  { id: 'pages', title: 'Most visited pages', header: /page path|page title|landing page/i },
  { id: 'countries', title: 'Countries', header: /^country$/i },
];

/** The measure to show, in order of preference. */
const MEASURES = [/^active users$/i, /^total users$/i, /^users$/i, /^new users$/i, /^sessions$/i, /^views$/i];
const ENGAGEMENT = /^average engagement time( per active user)?$/i;

export class AnalyticsImportError extends Error {}

export function parseAnalyticsCsv(files: { name: string; text: string }[]): AnalyticsSummary {
  const tables: AnalyticsSummary['tables'] = [];
  let start: string | null = null;
  let end: string | null = null;
  let engagementTotal = 0;
  let engagementUsers = 0;

  for (const file of files) {
    const lines = file.text.replace(/^\uFEFF/, '').split(/\r?\n/);
    for (const line of lines) {
      start ??= /^#\s*Start date:\s*(\d{8})/i.exec(line)?.[1] ?? null;
      end ??= /^#\s*End date:\s*(\d{8})/i.exec(line)?.[1] ?? null;
    }
    // A file can hold several tables, separated by blank or comment lines.
    const blocks = lines
      .map((l) => (l.startsWith('#') ? '' : l))
      .join('\n')
      .split(/\n\s*\n/)
      .map((b) => b.trim())
      .filter(Boolean);
    for (const block of blocks) {
      let rows: string[][];
      try {
        rows = parse(block, { relax_column_count: true, skip_empty_lines: true }) as string[][];
      } catch {
        continue;
      }
      const [header, ...body] = rows;
      if (!header || header.length < 2) continue;
      const dimension = DIMENSIONS.find((d) => d.header.test(header[0].trim()));
      const measureIndex = MEASURES.map((m) => header.findIndex((h) => m.test(h.trim()))).find((i) => i > 0);
      if (!dimension || measureIndex === undefined || tables.some((t) => t.id === dimension.id)) continue;
      const engagementIndex = header.findIndex((h) => ENGAGEMENT.test(h.trim()));
      const data = body
        .filter((r) => r[0]?.trim() && !/^(grand )?total$/i.test(r[0].trim()))
        .map((r) => ({ label: r[0].trim(), value: number(r[measureIndex]), engagementSeconds: engagementIndex > 0 ? number(r[engagementIndex]) : undefined }))
        .filter((r) => Number.isFinite(r.value))
        .sort((a, b) => b.value - a.value);
      if (!data.length) continue;
      if (engagementIndex > 0 && /active users/i.test(header[measureIndex])) {
        for (const r of data) if (r.engagementSeconds !== undefined && Number.isFinite(r.engagementSeconds)) {
          engagementTotal += r.engagementSeconds * r.value;
          engagementUsers += r.value;
        }
      }
      tables.push({ id: dimension.id, title: dimension.title, measure: header[measureIndex].trim(), rows: data.slice(0, 25) });
    }
  }
  if (!tables.length) {
    throw new AnalyticsImportError(
      'None of these files look like a Google Analytics report. Export Traffic acquisition, Pages and screens, Tech details (device category) or Demographic details (country) as CSV.',
    );
  }
  const order: TableId[] = ['channels', 'devices', 'pages', 'countries'];
  tables.sort((a, b) => order.indexOf(a.id) - order.indexOf(b.id));
  return {
    importedAt: new Date().toISOString(),
    files: files.map((f) => f.name.replace(/[^\w .()-]/g, '').slice(0, 80)),
    period: start && end ? `${gaDate(start)} to ${gaDate(end)}` : null,
    tables,
    engagementSeconds: engagementUsers ? Math.round(engagementTotal / engagementUsers) : null,
  };
}

function number(value: string | undefined): number {
  return Number((value ?? '').replace(/[,\s%]/g, ''));
}

function gaDate(yyyymmdd: string): string {
  const date = new Date(Date.UTC(Number(yyyymmdd.slice(0, 4)), Number(yyyymmdd.slice(4, 6)) - 1, Number(yyyymmdd.slice(6, 8))));
  return date.toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric', timeZone: 'UTC' });
}
