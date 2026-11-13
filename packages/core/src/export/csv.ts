import { stringify } from 'csv-stringify/sync';
import { writeFileSync } from 'node:fs';
import type { ExportPlan, PlannedTicket } from './plan.js';
import { SEVERITIES, type Priority } from '../types.js';
import { isAdvisory } from '../tickets/advisory.js';

/**
 * tickets.csv columns, in the order the spec sets (section 7.3), without the status and history
 * columns: tickets are managed in the team's own tool once exported. Screenshots are in the report.
 * Traffic share (from imported analytics) and Affects (the purposes and personas it gets in the way of) come last.
 */
export const TICKET_COLUMNS = [
  'Ticket ID', 'Title', 'Category', 'Severity', 'Priority', 'WCAG criterion', 'WCAG level', 'Rule ID',
  'Engine', 'Occurrences', 'Locations affected', 'Example location', 'Example selector', 'Description',
  'Why it matters', 'Steps to reproduce', 'Expected', 'Actual', 'Recommendation', 'Effort', 'Report section',
  'Auditor notes', 'Labels', 'Traffic share', 'Affects',
] as const;
export type TicketColumn = (typeof TICKET_COLUMNS)[number];

export const OCCURRENCE_COLUMNS = ['Ticket ID', 'Location (URL or state ID)', 'Viewport', 'Selector', 'HTML snippet'];

type Row = Record<TicketColumn, string>;

/**
 * A column preset adapts tickets.csv for a ticketing tool's importer: it renames columns, can rewrite
 * values (e.g. P1 → Highest) and can add columns the tool expects.
 */
export interface CsvPreset {
  id: string;
  name: string;
  rename?: Partial<Record<TicketColumn, string>>;
  values?: Partial<Record<TicketColumn, (value: string, ticket: PlannedTicket) => string>>;
  /** Extra columns appended after the standard ones. */
  extra?: { header: string; value: (ticket: PlannedTicket) => string }[];
  /** Split Labels into one column per label (Jira imports multiple labels this way). */
  splitLabels?: boolean;
  /** Write exactly these columns instead of the standard ones, for importers that reject anything else. */
  only?: { header: string; value: (ticket: PlannedTicket) => string }[];
  /** Leave out the byte-order mark, for importers that would read it as part of the first header. */
  noBom?: boolean;
}

const JIRA_PRIORITY: Record<Priority, string> = { P1: 'Highest', P2: 'High', P3: 'Medium', P4: 'Low' };
const LINEAR_PRIORITY: Record<Priority, string> = { P1: 'Urgent', P2: 'High', P3: 'Medium', P4: 'Low' };

/** Description with the developer detail inlined, for tools that import only a few fields. */
function fullDescription(t: PlannedTicket): string {
  return [
    t.description,
    `Why it matters: ${t.whyItMatters}`,
    `Where: ${t.exampleLocation ?? ''} (${t.occurrences} occurrence(s) on ${t.locationsAffected} location(s))`,
    `Selector: ${t.exampleSelector ?? ''}`,
    `Steps to reproduce:\n${t.stepsToReproduce}`,
    `Expected: ${t.expected}`,
    `Actual: ${t.actual}`,
    `Recommendation: ${t.recommendation}`,
    t.wcagCriterion ? `WCAG: ${t.wcagCriterion} (level ${t.wcagLevel ?? '-'})` : '',
    t.traffic !== null ? `Traffic: pages with ${trafficText(t)}` : '',
    t.affects ? `Affects: ${t.affects}` : '',
    `Prego ticket: ${t.ticketId}, report section ${t.reportSection}`,
  ]
    .filter(Boolean)
    .join('\n\n');
}

export const CSV_PRESETS: Record<string, CsvPreset> = {
  prego: { id: 'prego', name: 'Prego (standard columns)' },
  jira: {
    id: 'jira',
    name: 'Jira',
    rename: { Title: 'Summary' },
    values: {
      Priority: (v) => JIRA_PRIORITY[v as Priority] ?? v,
      Description: (_v, t) => fullDescription(t),
    },
    extra: [{ header: 'Issue Type', value: () => 'Bug' }],
    splitLabels: true,
  },
  linear: {
    id: 'linear',
    name: 'Linear',
    values: {
      Priority: (v) => LINEAR_PRIORITY[v as Priority] ?? v,
      Description: (_v, t) => fullDescription(t),
      Labels: (_v, t) => t.labels.join(','),
    },
  },
  productive: {
    id: 'productive',
    name: 'Productive',
    // Productive's task template: these seven columns, in this order, none removed. Assignee, dates and
    // estimate are left for the team to fill in Productive; everything else goes in the description.
    only: [
      { header: 'Title', value: (t) => `${t.ticketId}: ${t.title}` },
      { header: 'Assignee', value: () => '' },
      { header: 'Description', value: (t) => `Severity: ${t.severity} · Priority: ${t.priority} · Category: ${t.category} · Effort: ${t.effort}\n\n${fullDescription(t)}` },
      { header: 'Start Date', value: () => '' },
      { header: 'Due Date', value: () => '' },
      { header: 'Initial Estimate', value: () => '' },
      { header: 'Workflow Status', value: () => 'Open' },
    ],
    noBom: true,
  },
  trello: {
    id: 'trello',
    name: 'Trello',
    rename: { Title: 'Card Name', Description: 'Card Description' },
    values: { Description: (_v, t) => fullDescription(t), Labels: (_v, t) => t.labels.join(',') },
  },
};

function ticketRow(t: PlannedTicket): Row {
  return {
    'Ticket ID': t.ticketId,
    Title: t.title,
    Category: t.category,
    Severity: t.severity,
    Priority: t.priority,
    'WCAG criterion': t.wcagCriterion ?? '',
    'WCAG level': t.wcagLevel ?? '',
    'Rule ID': t.ruleId,
    Engine: t.engine,
    Occurrences: String(t.occurrences),
    'Locations affected': String(t.locationsAffected),
    'Example location': t.exampleLocation ?? '',
    'Example selector': t.exampleSelector ?? '',
    Description: t.description,
    'Why it matters': t.whyItMatters,
    'Steps to reproduce': t.stepsToReproduce,
    Expected: t.expected,
    Actual: t.actual,
    Recommendation: t.recommendation,
    Effort: t.effort,
    'Report section': t.reportSection,
    'Auditor notes': t.auditorNotes,
    Labels: t.labels.join(' '),
    'Traffic share': trafficText(t),
    Affects: t.affects,
  };
}

/** "34% of visits", with "(priority raised)" when that moved it up a level; empty without analytics. */
export function trafficText(t: Pick<PlannedTicket, 'traffic' | 'priorityRaised'>): string {
  if (t.traffic === null) return '';
  const pct = t.traffic > 0 && t.traffic < 0.01 ? 'under 1%' : `${Math.round(t.traffic * 100)}%`;
  return `${pct} of visits${t.priorityRaised ? ' (priority raised)' : ''}`;
}

/** UTF-8 with BOM (so Excel and Numbers read accents correctly), comma-separated, every field quoted. */
function toCsv(rows: string[][], bom = true): string {
  return stringify(rows, { bom, quoted: true, quoted_empty: true, record_delimiter: 'windows' });
}

export function ticketsCsv(plan: ExportPlan, presetId = 'prego'): string {
  const preset = CSV_PRESETS[presetId];
  if (!preset) throw new Error(`Unknown CSV preset "${presetId}". Choose from: ${Object.keys(CSV_PRESETS).join(', ')}`);
  const tickets = plan.tickets;
  if (preset.only) return toCsv([preset.only.map((c) => c.header), ...tickets.map((t) => preset.only!.map((c) => c.value(t)))], !preset.noBom);
  const columns = TICKET_COLUMNS.filter((c) => !(preset.splitLabels && c === 'Labels'));
  const maxLabels = preset.splitLabels ? Math.max(1, ...tickets.map((t) => t.labels.length)) : 0;
  const header = [
    ...columns.map((c) => preset.rename?.[c] ?? c),
    ...Array.from({ length: maxLabels }, () => 'Labels'),
    ...(preset.extra ?? []).map((e) => e.header),
  ];
  const rows = tickets.map((t) => {
    const row = ticketRow(t);
    return [
      ...columns.map((c) => preset.values?.[c]?.(row[c], t) ?? row[c]),
      ...Array.from({ length: maxLabels }, (_, i) => t.labels[i] ?? ''),
      ...(preset.extra ?? []).map((e) => e.value(t)),
    ];
  });
  return toCsv([header, ...rows]);
}

export function occurrencesCsv(plan: ExportPlan): string {
  const rows = plan.tickets.flatMap((t) =>
    t.occurrenceList.map((o) => [t.ticketId, o.location.stateId ?? o.location.url, o.viewport, o.selector, o.html]),
  );
  return toCsv([OCCURRENCE_COLUMNS, ...rows]);
}

export function writeCsvFiles(plan: ExportPlan, paths: { tickets: string; occurrences: string; checklist: string }, presetId = 'prego') {
  writeFileSync(paths.tickets, ticketsCsv(plan, presetId));
  writeFileSync(paths.occurrences, occurrencesCsv(plan));
  writeFileSync(paths.checklist, checklistCsv(plan));
}

/** How many of the most serious tickets the spot-check sheet lists. */
export const CHECKLIST_SIZE = 10;

/**
 * A sheet for checking the most serious findings by hand before a report goes to the client: the ten
 * highest-severity tickets (advice left out), each with a page and element to look at, where its
 * screenshot is in report.docx, and empty columns to record the check. About 15 minutes' work.
 */
export function checklistCsv(plan: ExportPlan): string {
  const top = plan.tickets
    .filter((t) => !isAdvisory(t))
    .sort((a, b) => SEVERITIES.indexOf(a.severity) - SEVERITIES.indexOf(b.severity) || a.priority.localeCompare(b.priority) || b.locationsAffected - a.locationsAffected)
    .slice(0, CHECKLIST_SIZE);
  return toCsv([
    ['Ticket ID', 'Severity', 'Issue', 'Page to check', 'Element', 'Screenshot', 'Pages affected', 'Confirmed? (Yes / No / Partly)', 'Notes'],
    ...top.map((t) => [
      t.ticketId,
      t.severity,
      t.title,
      t.exampleLocation ?? '',
      t.exampleSelector ?? '',
      t.screenshotFile ? `report.docx, section ${t.reportSection}` : '',
      String(t.locationsAffected),
      '',
      '',
    ]),
  ]);
}
