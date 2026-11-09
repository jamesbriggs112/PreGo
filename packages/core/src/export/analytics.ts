import { parse } from 'csv-parse/sync';
import type { AnalyticsSummary, SearchRow, SearchSummary } from '../types.js';

// Reads the CSV files Google Analytics 4 exports (Reports → Share → Download file → CSV) and Search
// Console's Performance export (Export → Download CSV, unzipped), for the report's Analytics section
// and for weighting tickets by traffic. Only the figures are kept: GA's comment lines (account,
// property) are dropped, and nothing about individual visitors is in these reports anyway.

type TableId = AnalyticsSummary['tables'][number]['id'];

const DIMENSIONS: { id: TableId; title: string; header: RegExp }[] = [
  { id: 'channels', title: 'How people find the site', header: /channel group|source \/ medium|^(session |first user )?source$/i },
  { id: 'devices', title: 'Devices', header: /^device category$/i },
  // Landing pages first: "Landing page" would otherwise count as a page report.
  { id: 'landing', title: 'Where visits start (landing pages)', header: /^landing page/i },
  { id: 'pages', title: 'Most visited pages', header: /page path|page title/i },
  { id: 'events', title: 'Key events', header: /^event name$/i },
  { id: 'countries', title: 'Countries', header: /^country$/i },
];

/** The measure to show, in order of preference. Event reports use event or key event counts. */
const MEASURES = [/^active users$/i, /^total users$/i, /^users$/i, /^new users$/i, /^sessions$/i, /^views$/i, /^key events$/i, /^conversions$/i, /^event count$/i];
const ENGAGEMENT = /^average engagement time( per active user| per session)?$/i;

/** Search Console's export: one CSV per tab, each with Clicks, Impressions, CTR and Position. */
const SEARCH: { id: keyof SearchSummary; header: RegExp }[] = [
  { id: 'queries', header: /^(top )?quer(y|ies)$/i },
  { id: 'pages', header: /^(top )?pages?$/i },
  { id: 'devices', header: /^devices?$/i },
  { id: 'countries', header: /^countr(y|ies)$/i },
];

export class AnalyticsImportError extends Error {}

export function parseAnalyticsCsv(files: { name: string; text: string }[]): AnalyticsSummary {
  const tables: AnalyticsSummary['tables'] = [];
  const search: Partial<SearchSummary> = {};
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
      const column = (pattern: RegExp) => header.findIndex((h) => pattern.test(h.trim()));

      // Search Console, recognised by its columns, before GA (both have a Country report).
      const clicks = column(/^clicks$/i);
      const impressions = column(/^impressions$/i);
      if (clicks > 0 && impressions > 0) {
        const kind = SEARCH.find((s) => s.header.test(header[0].trim()));
        if (!kind || search[kind.id]) continue;
        const ctr = column(/^ctr$/i);
        const position = column(/^position$/i);
        search[kind.id] = body
          .filter((r) => r[0]?.trim())
          .map((r): SearchRow => ({ label: r[0].trim(), clicks: number(r[clicks]), impressions: number(r[impressions]), ctr: ctr > 0 ? number(r[ctr]) : 0, position: position > 0 ? number(r[position]) : 0 }))
          .filter((r) => Number.isFinite(r.clicks) && Number.isFinite(r.impressions))
          .sort((a, b) => b.clicks - a.clicks || b.impressions - a.impressions)
          .slice(0, 50);
        continue;
      }

      const dimension = DIMENSIONS.find((d) => d.header.test(header[0].trim()));
      const measureIndex = MEASURES.map((m) => column(m)).find((i) => i > 0);
      if (!dimension || measureIndex === undefined || tables.some((t) => t.id === dimension.id)) continue;
      const engagementIndex = column(ENGAGEMENT);
      const data = body
        .filter((r) => r[0]?.trim() && !/^(grand )?total$/i.test(r[0].trim()))
        .map((r) => ({ label: r[0].trim(), value: number(r[measureIndex]), engagementSeconds: engagementIndex > 0 ? number(r[engagementIndex]) : undefined }))
        .filter((r) => Number.isFinite(r.value))
        .sort((a, b) => b.value - a.value);
      if (!data.length) continue;
      if (engagementIndex > 0 && /active users/i.test(header[measureIndex]) && dimension.id !== 'events') {
        for (const r of data) if (r.engagementSeconds !== undefined && Number.isFinite(r.engagementSeconds)) {
          engagementTotal += r.engagementSeconds * r.value;
          engagementUsers += r.value;
        }
      }
      // Pages and landing pages keep more rows, for weighting tickets by traffic.
      tables.push({ id: dimension.id, title: dimension.title, measure: header[measureIndex].trim(), rows: data.slice(0, dimension.id === 'pages' || dimension.id === 'landing' ? 200 : 25) });
    }
  }
  const hasSearch = Object.keys(search).length > 0;
  if (!tables.length && !hasSearch) {
    throw new AnalyticsImportError(
      'None of these files look like a Google Analytics or Search Console report. From Google Analytics, export Traffic acquisition, Pages and screens, Landing page, Events, Tech details or Demographic details as CSV. From Search Console, export Performance and unzip it.',
    );
  }
  const order: TableId[] = ['channels', 'devices', 'landing', 'pages', 'events', 'countries'];
  tables.sort((a, b) => order.indexOf(a.id) - order.indexOf(b.id));
  return {
    importedAt: new Date().toISOString(),
    files: files.map((f) => f.name.replace(/[^\w .()-]/g, '').slice(0, 80)),
    period: start && end ? `${gaDate(start)} to ${gaDate(end)}` : null,
    tables,
    engagementSeconds: engagementUsers ? Math.round(engagementTotal / engagementUsers) : null,
    ...(hasSearch && { search: { queries: [], pages: [], devices: [], countries: [], ...search } }),
  };
}

/**
 * Add a new import to what's already there: its reports replace the same reports from before, so GA
 * and Search Console can be imported separately, and a newer export of one report updates it.
 */
export function mergeAnalytics(before: AnalyticsSummary | undefined, added: AnalyticsSummary): AnalyticsSummary {
  if (!before) return added;
  const tables = [...before.tables.filter((t) => !added.tables.some((a) => a.id === t.id)), ...added.tables];
  const order: TableId[] = ['channels', 'devices', 'landing', 'pages', 'events', 'countries'];
  tables.sort((a, b) => order.indexOf(a.id) - order.indexOf(b.id));
  const search = before.search || added.search ? { queries: [], pages: [], devices: [], countries: [], ...before.search, ...Object.fromEntries(Object.entries(added.search ?? {}).filter(([, rows]) => rows.length)) } : undefined;
  return {
    importedAt: added.importedAt,
    files: [...new Set([...before.files, ...added.files])].slice(-20),
    period: added.period ?? before.period,
    tables,
    engagementSeconds: added.engagementSeconds ?? before.engagementSeconds,
    ...(search && { search }),
  };
}

/** A page's address as a path for matching analytics to audited pages: no query, fragment, trailing slash or index.html. */
export function normalisePath(value: string): string | null {
  let path = value.trim();
  if (!path) return null;
  if (/^https?:\/\//i.test(path)) {
    try {
      path = new URL(path).pathname;
    } catch {
      return null;
    }
  }
  if (!path.startsWith('/')) return null;
  path = path.replace(/[?#].*$/, '').replace(/\/index\.html?$/i, '/');
  return path.length > 1 ? path.replace(/\/+$/, '') : '/';
}

/**
 * Each page's share of traffic, 0 to 1, by path: GA page views or landing pages, or Search Console
 * clicks if that's all there is. Null when the import has nothing by page.
 */
export function trafficByPath(analytics: AnalyticsSummary | undefined): Map<string, number> | null {
  if (!analytics) return null;
  const table = analytics.tables.find((t) => t.id === 'pages' && t.rows.some((r) => normalisePath(r.label))) ?? analytics.tables.find((t) => t.id === 'landing');
  const rows = table ? table.rows.map((r) => ({ path: normalisePath(r.label), value: r.value })) : (analytics.search?.pages ?? []).map((r) => ({ path: normalisePath(r.label), value: r.clicks }));
  const total = rows.reduce((sum, r) => sum + r.value, 0);
  if (!total) return null;
  const shares = new Map<string, number>();
  for (const r of rows) if (r.path) shares.set(r.path, (shares.get(r.path) ?? 0) + r.value / total);
  return shares.size ? shares : null;
}

function number(value: string | undefined): number {
  return Number((value ?? '').replace(/[,\s%]/g, ''));
}

function gaDate(yyyymmdd: string): string {
  const date = new Date(Date.UTC(Number(yyyymmdd.slice(0, 4)), Number(yyyymmdd.slice(4, 6)) - 1, Number(yyyymmdd.slice(6, 8))));
  return date.toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric', timeZone: 'UTC' });
}
