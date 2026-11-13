import { HeadingLevel, Paragraph, Table } from 'docx';
import { stringify } from 'csv-stringify/sync';
import type { ExportPlan, PlannedOccurrence, PlannedTicket } from './plan.js';
import { auditedCount, heading, para, table } from './docx.js';
import { fixMetaFor } from './fix-meta.js';
import { shortRef } from './action-plan.js';

// Everything a content editor can fix in the CMS, page by page: alt text, titles and descriptions,
// spelling, link text, the accessibility statement. In the client report and as content-fixes.csv.

export interface ContentFix {
  page: string;
  change: string;
  current: string;
  suggested: string;
  ref: string;
}

/** Most rows in the report; the CSV has them all. */
const MAX_REPORT_ROWS = 40;
const TITLE_LIMIT = 60;

function current(t: PlannedTicket, o: PlannedOccurrence): string {
  const word = /“([^”]+)”/.exec(t.title)?.[1];
  if (t.ruleId === 'spelling' && word) return word;
  if (/title/.test(t.ruleId)) return o.location.title ?? '';
  if (/meta-description/.test(t.ruleId)) return String((o.location.metrics.sharing as { description?: string } | undefined)?.description ?? '');
  if (/image-alt|alt-text/.test(t.ruleId)) return /src="([^"]+)"/.exec(o.html)?.[1]?.split('/').pop() ?? o.html.slice(0, 80);
  if (/link/.test(t.ruleId)) return (/>([^<]+)</.exec(o.html)?.[1] ?? /href="([^"]+)"/.exec(o.html)?.[1] ?? '').trim();
  return '';
}

function suggested(t: PlannedTicket, now: string): string {
  if (t.ruleId === 'spelling') return /Did you mean “([^”]+)”/.exec(t.actual)?.[1] ?? '';
  // Show where a long title gets cut off in search results.
  if (t.ruleId === 'title-length' && now.length > TITLE_LIMIT) return `${now.slice(0, TITLE_LIMIT).trimEnd()}… (cut off here: keep the key words before it)`;
  if (t.ruleId === 'meta-description-missing') return 'Write a description of about 150 characters saying what the page offers.';
  if (/image-alt/.test(t.ruleId)) return 'Describe what the image shows, or mark it as decoration.';
  return '';
}

export function contentFixes(plan: Pick<ExportPlan, 'tickets' | 'locations'>): ContentFix[] {
  const audited = auditedCount(plan as ExportPlan) || 1;
  const out: ContentFix[] = [];
  for (const t of plan.tickets) {
    const meta = fixMetaFor(t, audited);
    if (meta.owner !== 'Content editor') continue;
    const seen = new Set<string>();
    for (const o of t.occurrenceList) {
      if (!o.location || o.location.kind !== 'page') continue;
      const now = current(t, o);
      const key = `${o.location.url}|${now}`;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push({ page: o.location.url, change: meta.action, current: now, suggested: suggested(t, now), ref: shortRef(t.ticketId) });
    }
  }
  return out.sort((a, b) => a.page.localeCompare(b.page) || a.change.localeCompare(b.change));
}

export function contentFixesCsv(plan: Pick<ExportPlan, 'tickets' | 'locations'>): string {
  const rows = contentFixes(plan);
  return stringify([['Page', 'What to change', 'Now', 'Suggested', 'Ref', 'Done?'], ...rows.map((r) => [r.page, r.change, r.current, r.suggested, r.ref, ''])], {
    bom: true,
    quoted: true,
    quoted_empty: true,
    record_delimiter: 'windows',
  });
}

export function contentEditorsSection(plan: ExportPlan, title: Paragraph): (Paragraph | Table)[] {
  const rows = contentFixes(plan);
  if (!rows.length) return [title, para('Nothing in this audit needs changing in the content itself.')];
  const shown = rows.slice(0, MAX_REPORT_ROWS);
  return [
    title,
    para('Everything here can be fixed in the content management system, without a developer. The full list is in content-fixes.csv, with a column to tick off.'),
    table(
      ['Page', 'What to change', 'Now', 'Suggested'],
      shown.map((r) => [new URL(r.page).pathname || '/', r.change, r.current || '–', r.suggested || '–']),
      { fontSize: 17 },
    ),
    ...(rows.length > shown.length ? [para(`And ${rows.length - shown.length} more in content-fixes.csv.`)] : []),
    heading('Tips', HeadingLevel.HEADING_3),
    para(
      'Alt text says what an image shows in a sentence; leave it empty for decoration. Page titles work best under 60 characters, with the key words first. Link text should say where the link goes, never just “click here”.',
    ),
  ];
}
