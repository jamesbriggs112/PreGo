import type { PregoDb } from '../db/database.js';
import { CATEGORIES, CATEGORY_NAMES, type Category, type Location, type Occurrence, type Project, type Run, type StateEdge, type Ticket } from '../types.js';
import type { ImageState } from './state-map-image.js';
import { DEFAULT_REPORT_OPTIONS, type OptionalSection, type ReportOptions } from './report-options.js';
import { normalisePath, trafficByPath } from './analytics.js';
import { impactText, ticketImpacts, type TicketImpact } from './cross.js';

/** Tickets on pages that get at least this share of visits move up one priority level. */
export const TRAFFIC_RAISE_SHARE = 0.25;
const RAISED: Record<Ticket['priority'], Ticket['priority']> = { P1: 'P1', P2: 'P1', P3: 'P2', P4: 'P3' };

/** Statuses left out of exports: dismissed false positives, and AI suggestions nobody has approved. */
const NOT_EXPORTED = new Set<Ticket['status']>(['Dismissed', 'Needs review']);

export interface PlannedOccurrence extends Occurrence {
  location: Location;
  /** Name for the occurrence's outlined crop, e.g. `PRG-A11Y-014_02.png`, or null if no crop. */
  screenshotFile: string | null;
}

export interface PlannedTicket extends Ticket {
  /** Word report section the ticket appears in, e.g. `4.2`. */
  reportSection: string;
  /** First outlined crop, shown in the report. */
  screenshotFile: string | null;
  occurrenceList: PlannedOccurrence[];
  /** Share of visits (0 to 1) to the pages the ticket affects, from imported analytics; null without page figures. */
  traffic: number | null;
  /** The priority was raised a level because the pages get a large share of visits. `priority` is the raised one. */
  priorityRaised: boolean;
  /** The purposes, personas and tasks it gets in the way of, and its focus score. */
  impact: TicketImpact;
  /** The purposes and personas it affects, by name: "Help people get in touch; On their phone (barrier)". */
  affects: string;
}

export interface ReportSectionPlan {
  number: string;
  category: Category;
  title: string;
  tickets: PlannedTicket[];
}

/**
 * Everything both exporters need, decided once: which tickets are exported, which report section each
 * one sits in, and the file name of every screenshot. The CSV and Word exporters both read this, so
 * their cross-references always agree.
 */
/** A numbered top-level section of report.docx. */
export type ReportSectionId = 'summary' | 'method' | OptionalSection | 'findings' | 'map' | 'conclusion' | 'limitations';
export interface OutlineEntry {
  id: ReportSectionId;
  number: number;
  title: string;
}

export interface ExportPlan {
  project: Project;
  run: Run;
  options: ReportOptions;
  /** The report's numbered sections, in order. */
  outline: OutlineEntry[];
  /** Optional sections with something to show. A section that's switched on but has nothing is left out. */
  available: Record<OptionalSection, boolean>;
  locations: Location[];
  /** For interactive audits: what each action did. */
  edges: StateEdge[];
  sections: ReportSectionPlan[];
  /** Exported tickets, in report order. */
  tickets: PlannedTicket[];
}

/** The explored screens, with their exported issues, for drawing the state map. */
export function stateMapStates(plan: ExportPlan): ImageState[] {
  const byLocation = new Map<number, PlannedTicket[]>();
  for (const ticket of plan.tickets) {
    for (const id of new Set(ticket.occurrenceList.map((o) => o.locationId))) byLocation.set(id, [...(byLocation.get(id) ?? []), ticket]);
  }
  return plan.locations
    .filter((l) => l.kind === 'state')
    .map((l) => ({
      id: l.id,
      title: l.title ?? '',
      depth: l.depth,
      stepKeys: (l.steps ?? []).map((s) => s.key),
      issues: byLocation.get(l.id)?.length ?? 0,
      flagged: (byLocation.get(l.id) ?? []).some((t) => t.category === 'UX'),
    }));
}

/** Which optional sections have data for this audit. */
export function availableSections(project: Project, run: Run, locations: Location[]): Record<OptionalSection, boolean> {
  return {
    analytics: !!project.settings.analytics,
    content: locations.some((l) => l.metrics.content),
    ia: run.mode === 'crawl' && locations.length > 1,
    competitors: ((run.summary.competitors as unknown[] | undefined) ?? []).length > 0,
  };
}

/** The report's sections, numbered in order. Findings come after the scene-setting sections. */
export function reportOutline(run: Pick<Run, 'mode'>, options: ReportOptions, available: Record<OptionalSection, boolean>): OutlineEntry[] {
  const on = (id: OptionalSection) => options.include[id] && available[id];
  const ids: (ReportSectionId | false)[] = [
    'summary',
    'method',
    on('analytics') && 'analytics',
    'findings',
    on('content') && 'content',
    on('ia') && 'ia',
    'map',
    on('competitors') && 'competitors',
    options.clientFacing && !!options.text.conclusion && 'conclusion',
    'limitations',
  ];
  const titles: Record<ReportSectionId, string> = {
    summary: 'Executive summary',
    method: options.clientFacing ? 'Methodology' : 'Scope and method',
    analytics: 'Analytics',
    findings: 'Findings by category',
    content: 'Content and tone',
    ia: 'Information architecture',
    map: run.mode === 'explore' ? 'State map summary' : run.mode === 'journey' ? 'Journey steps' : 'Site map summary',
    competitors: 'Competitor analysis',
    conclusion: 'Conclusion',
    limitations: 'Limitations and manual testing',
  };
  // The technical report counts its cover as section 1 (the spec's numbering); a client-facing report
  // starts at 1 after its contents page.
  const first = options.clientFacing ? 1 : 2;
  return ids.filter((id): id is ReportSectionId => !!id).map((id, i) => ({ id, number: i + first, title: titles[id] }));
}

export function buildExportPlan(db: PregoDb, runId: number, options: ReportOptions = db.getReportOptions(runId) ?? DEFAULT_REPORT_OPTIONS): ExportPlan {
  const run = db.getRun(runId);
  if (!run) throw new Error(`Run ${runId} not found`);
  const project = db.getProject(run.projectId)!;
  const locations = db.getLocations(runId);
  const available = availableSections(project, run, locations);
  const outline = reportOutline(run, options, available);
  const findingsNumber = outline.find((o) => o.id === 'findings')!.number;
  const locationById = new Map(locations.map((l) => [l.id, l]));
  const traffic = trafficByPath(project.settings.analytics);

  const exported = db
    .getTickets(runId)
    .filter((t) => !NOT_EXPORTED.has(t.status))
    .sort((a, b) => a.ticketId.localeCompare(b.ticketId, 'en', { numeric: true }));

  const sections: ReportSectionPlan[] = [];
  for (const category of CATEGORIES) {
    const inCategory = exported.filter((t) => t.category === category);
    if (inCategory.length === 0) continue;
    const number = `${findingsNumber}.${sections.length + 1}`;
    const planned = inCategory.map((ticket): PlannedTicket => {
      let n = 0;
      const occurrenceList = db.getOccurrences(runId, ticket.ticketId).map((occurrence): PlannedOccurrence => {
        let screenshotFile: string | null = null;
        if (occurrence.crop) screenshotFile = `${ticket.ticketId}_${String(++n).padStart(2, '0')}.png`;
        return { ...occurrence, location: locationById.get(occurrence.locationId)!, screenshotFile };
      });
      // Each page counts once, however many times the problem appears on it.
      const paths = new Set(occurrenceList.filter((o) => o.location?.kind === 'page').map((o) => normalisePath(o.location.url)));
      const share = traffic ? Math.min(1, [...paths].reduce((sum, path) => sum + (path ? (traffic.get(path) ?? 0) : 0), 0)) : null;
      const raise = share !== null && share >= TRAFFIC_RAISE_SHARE && RAISED[ticket.priority] !== ticket.priority;
      return {
        ...ticket,
        priority: raise ? RAISED[ticket.priority] : ticket.priority,
        reportSection: number,
        screenshotFile: occurrenceList.find((o) => o.screenshotFile)?.screenshotFile ?? null,
        occurrenceList,
        traffic: share === null ? null : Math.round(share * 1000) / 1000,
        priorityRaised: raise,
        impact: { purposeIds: [], personaIds: [], taskIds: [], barrierFor: [], blocksTaskIds: [], score: 0 },
        affects: '',
      };
    });
    sections.push({ number, category, title: CATEGORY_NAMES[category], tickets: planned });
  }

  const tickets = sections.flatMap((s) => s.tickets);
  const impacts = ticketImpacts(project.settings.audience, locations, run, tickets);
  for (const t of tickets) {
    t.impact = impacts.get(t.ticketId)!;
    t.affects = impactText(t.impact, project.settings.audience);
  }

  return {
    project,
    run,
    options,
    outline,
    available,
    locations,
    edges: db.getEdges(runId),
    sections,
    tickets,
  };
}
