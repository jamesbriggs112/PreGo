import { HeadingLevel, Paragraph, ShadingType, Table, TextRun } from 'docx';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { CATEGORY_NAMES } from '../types.js';
import { guidanceWithFallback } from '../checks/guidance.js';
import type { ExportPlan, PlannedTicket } from './plan.js';
import { CHIP_COLOURS, heading, para, pngImage, table } from './docx.js';
import { AREAS, EFFORT_TEXT, type Area } from './fix-meta.js';
import type { PlanRow } from './action-plan.js';
import type { GlanceData } from './glance.js';

// Fix cards: one per distinct issue, grouped by where the fix happens (the header, the forms, the page
// templates), laid out the same way every time. Critical and High issues get a full card, Medium a
// compact one, and Low issues and advice a table at the end of their area.

const MAX_IMAGE_WIDTH = 560;
const MAX_IMAGE_HEIGHT = 360;
/** How many issues get a full card, and how many a compact one; the rest are table rows. */
const MAX_FULL_CARDS = 8;
const MAX_COMPACT_CARDS = 10;
const MAX_TABLE_ROWS = 8;
const PUBLIC_SECTOR = /public|council|government|police|nhs|health service|university|school|charity regulator|local authority/i;

const firstSentences = (text: string, n: number) =>
  (
    text
      .match(/[^.!?]+[.!?]+(\s|$)/g)
      ?.slice(0, n)
      .join('')
      .trim() || text
  ).trim();
const lowerFirst = (text: string) => text.charAt(0).toLowerCase() + text.slice(1);

/** Adds an attribute to an element's opening tag. */
const withAttribute = (html: string, attribute: string) => html.replace(/^<([a-z][a-z0-9-]*)/i, `<$1 ${attribute}`);

/** How to write the fixed element, for rules where the fix is certain. No template, no "after": never guess. */
const AFTER: Record<string, (html: string) => string> = {
  'button-name': (h) => withAttribute(h, 'aria-label="Say what it does, e.g. Menu"'),
  'link-name': (h) => withAttribute(h.replace(/\saria-label="[^"]*"/, ''), 'aria-label="Say where it goes, e.g. LinkedIn"'),
  'image-alt': (h) => withAttribute(h.replace(/\salt="[^"]*"/, ''), 'alt="Describe the image (or alt=&quot;&quot; if it’s decoration)"'),
  'html-has-lang': (h) => h.replace(/^<html\b/i, '<html lang="en-GB"'),
  'frame-title': (h) => withAttribute(h, 'title="Say what it shows, e.g. Contact form"'),
  'select-name': (h) => withAttribute(h, 'aria-label="Say what to choose"'),
  label: (h) => withAttribute(h, 'aria-label="The field’s name"'),
};

/** The captured element, trimmed to three short lines. */
function before(html: string): string {
  return html
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean)
    .slice(0, 3)
    .map((l) => (l.length > 110 ? `${l.slice(0, 107)}…` : l))
    .join('\n');
}

function code(text: string): Paragraph[] {
  return text.split('\n').map((line) => new Paragraph({ spacing: { after: 0 }, indent: { left: 240 }, children: [new TextRun({ text: line, font: 'Courier New', size: 17 })] }));
}

function labelled(label: string, text: string): Paragraph {
  return new Paragraph({ spacing: { after: 80 }, children: [new TextRun({ text: `${label}: `, bold: true }), new TextRun(text)] });
}

/** A generic check for issues without one of their own. */
function checkFor(row: PlanRow): string {
  if (row.check) return row.check;
  return row.tickets[0].category === 'A11Y'
    ? 'Try it with the keyboard and a screen reader (VoiceOver or NVDA), then run the audit again: it should no longer be listed.'
    : 'Run the audit again once the change is live: it should no longer be listed.';
}

/** The first screenshot crop among the row's tickets, when the run still has it. */
function crop(row: PlanRow, runDir: string): Paragraph[] {
  const ticket = row.tickets.find((t) => t.screenshotFile);
  const occurrence = ticket?.occurrenceList.find((o) => o.screenshotFile === ticket.screenshotFile);
  const path = occurrence?.crop ? join(runDir, occurrence.crop) : '';
  const image =
    path && existsSync(path) ? pngImage(readFileSync(path), MAX_IMAGE_WIDTH, MAX_IMAGE_HEIGHT, `Screenshot of ${lowerFirst(row.where)} with the problem outlined`) : null;
  if (!image) return [];
  return [
    new Paragraph({ spacing: { before: 120 }, children: [image] }),
    new Paragraph({
      spacing: { after: 160 },
      children: [new TextRun({ text: `Example from ${ticket!.exampleLocation ?? 'the site'}, problem outlined in pink.`, italics: true, size: 18 })],
    }),
  ];
}

function header(row: PlanRow): Paragraph {
  const category = CATEGORY_NAMES[row.tickets[0].category];
  const chip = CHIP_COLOURS[row.severity];
  return new Paragraph({
    spacing: { after: 80 },
    children: [
      // The severity as a chip: its word on a coloured background, never colour alone.
      new TextRun({ text: ` ${row.severity} `, bold: true, size: 18, color: chip.text, shading: { type: ShadingType.CLEAR, color: 'auto', fill: chip.fill } }),
      new TextRun({
        text: `  ·  ${category}  ·  Effort: ${lowerFirst(EFFORT_TEXT[row.effort])}  ·  Who: ${row.who}  ·  Ref ${row.refs.slice(0, 3).join(', ')}${row.refs.length > 3 ? ` +${row.refs.length - 3}` : ''}`,
        size: 18,
      }),
    ],
  });
}

function why(t: PlannedTicket): string {
  const reason = firstSentences(
    guidanceWithFallback(t.engine, t.ruleId, { title: t.title, description: t.description, helpUrl: null, wcagCriteria: t.wcagCriterion?.split(/,\s*/) }).whyItMatters,
    1,
  );
  const standard = t.wcagCriterion && (t.wcagLevel === 'A' || t.wcagLevel === 'AA') ? ` (WCAG 2.2 level ${t.wcagLevel}, ${t.wcagCriterion})` : '';
  return `${reason}${standard}`;
}

/** A full card, for Critical and High issues. */
function fullCard(row: PlanRow, runDir: string): Paragraph[] {
  const t = row.tickets[0];
  const sample = row.tickets.flatMap((x) => x.occurrenceList).find((o) => o.html)?.html ?? '';
  const after = AFTER[row.tickets[0].ruleId];
  const out: Paragraph[] = [heading(row.fix, HeadingLevel.HEADING_3), header(row), labelled('What’s wrong', row.meta.what ?? firstSentences(t.description, 2))];
  if (row.affects.length) out.push(labelled('Who it affects', row.affects.join(' · ')));
  out.push(labelled('Where', row.where), ...crop(row, runDir), labelled('How to fix', row.meta.how ?? t.recommendation));
  if (after && /^</.test(sample)) {
    const was = before(sample);
    out.push(new Paragraph({ spacing: { before: 60 }, children: [new TextRun({ text: 'Now:', italics: true, size: 18 })] }), ...code(was));
    out.push(new Paragraph({ spacing: { before: 60 }, children: [new TextRun({ text: 'Change to:', italics: true, size: 18 })] }), ...code(before(after(sample))));
  }
  out.push(labelled('How to check it’s fixed', checkFor(row)), labelled('Why it matters', why(t)));
  return out;
}

/** A compact card, for Medium issues: no code, no screenshot. */
function compactCard(row: PlanRow): Paragraph[] {
  const t = row.tickets[0];
  return [
    heading(row.fix, HeadingLevel.HEADING_3),
    header(row),
    labelled('What’s wrong', row.meta.what ?? firstSentences(t.description, 1)),
    labelled('Where', row.where),
    labelled('How to fix', row.meta.how ?? firstSentences(t.recommendation, 2)),
  ];
}

export function fixCardsSection(plan: ExportPlan, data: GlanceData, runDir: string, title: Paragraph): (Paragraph | Table)[] {
  const out: (Paragraph | Table)[] = [title];
  if (!data.rows.length) return [...out, para('Automated checks raised no issues in the areas checked.')];
  out.push(
    para(
      'Grouped by the part of the site where the fix happens. The most serious issues have a full card, others a short one, and smaller issues and advice are listed at the end of each part.',
    ),
  );
  const sector = plan.project.settings.client?.sector ?? '';
  if (PUBLIC_SECTOR.test(sector) && data.rows.some((r) => r.tickets[0].category === 'A11Y')) {
    out.push(para('As a public sector body, the site must also meet the Public Sector Bodies Accessibility Regulations 2018, which use WCAG 2.2 level AA.'));
  }
  // The most important issues get full cards, the next ones compact cards, and the rest a table row,
  // ranked across the whole site so the report stays short.
  const ranked = data.rows.filter((r) => !r.advisory && r.severity !== 'Low').sort((a, b) => b.score - a.score);
  const full = new Set(ranked.filter((r) => r.severity === 'Critical' || r.severity === 'High').slice(0, MAX_FULL_CARDS));
  const compact = new Set(ranked.filter((r) => !full.has(r)).slice(0, MAX_COMPACT_CARDS));
  for (const area of AREAS as Area[]) {
    const rows = data.rows.filter((r) => r.area === area);
    if (!rows.length) continue;
    out.push(heading(`${area} (${rows.length})`, HeadingLevel.HEADING_2));
    for (const r of rows.filter((r) => full.has(r)).sort((a, b) => b.score - a.score)) out.push(...fullCard(r, runDir));
    for (const r of rows.filter((r) => compact.has(r)).sort((a, b) => b.score - a.score)) out.push(...compactCard(r));
    const rest = rows.filter((r) => !full.has(r) && !compact.has(r));
    if (rest.length) {
      const shown = rest.slice(0, MAX_TABLE_ROWS);
      out.push(
        heading('Smaller issues and advice', HeadingLevel.HEADING_3),
        table(
          ['Fix', 'Where', 'Who', 'Effort', 'Ref'],
          shown.map((r) => [
            r.fix + (r.advisory ? ' (advice)' : ''),
            r.where.length > 70 ? `${r.where.slice(0, 69)}…` : r.where,
            r.who,
            r.effort,
            r.refs.slice(0, 2).join(', ') + (r.refs.length > 2 ? ` +${r.refs.length - 2}` : ''),
          ]),
          { fontSize: 17 },
        ),
        ...(rest.length > shown.length ? [para(`And ${rest.length - shown.length} more in the developer report.`)] : []),
      );
    }
  }
  return out;
}
