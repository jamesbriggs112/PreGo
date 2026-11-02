import { createHash } from 'node:crypto';
import type { PregoDb, TicketOverride } from '../db/database.js';
import { guidanceWithFallback } from '../checks/guidance.js';
import { componentLabel } from './component.js';
import { CATEGORY_NAMES, SEVERITIES, type Location, type Priority, type RawFinding, type Severity, type Ticket } from '../types.js';

/**
 * A problem's fingerprint: rule + component + where it lives (the template, or `site` for components
 * shared by every page). The same problem gets the same fingerprint, and so the same ticket ID, on
 * every run.
 */
export function fingerprint(finding: Pick<RawFinding, 'engine' | 'ruleId' | 'component' | 'componentShared' | 'selector'>, templateKey: string | null): string {
  const scope = finding.componentShared ? 'site' : `template:${templateKey ?? ''}`;
  const component = finding.component ?? `selector:${finding.selector}`;
  return createHash('sha1').update([finding.engine, finding.ruleId, scope, component].join('\n')).digest('hex').slice(0, 16);
}

const SEVERITY_RANK: Record<Severity, number> = { Critical: 1, High: 2, Medium: 3, Low: 4 };

/**
 * Priority from severity, reach and key journeys. Severity sets the base (Critical → P1 … Low → P4).
 * It moves up one level when the problem affects at least half the audited locations, or sits on a key
 * journey. Low-severity problems never rise above P3.
 */
export function calculatePriority(severity: Severity, reach: number, onKeyJourney: boolean): Priority {
  let level = SEVERITY_RANK[severity];
  if (reach >= 0.5 || onKeyJourney) level -= 1;
  if (severity === 'Low') level = Math.max(level, 3);
  return `P${Math.min(Math.max(level, 1), 4)}` as Priority;
}

export interface BuildTicketsOptions {
  /** URLs on a key user journey (e.g. checkout). Problems there get a higher priority. */
  keyJourneyUrls?: string[];
}

/**
 * Group a run's raw findings into tickets: one per fingerprint, numbered with the project's stable
 * ticket IDs, plus one occurrence per finding. Safe to re-run; it rebuilds the run's tickets.
 */
export function buildTickets(db: PregoDb, runId: number, options: BuildTicketsOptions = {}): Ticket[] {
  const run = db.getRun(runId);
  if (!run) throw new Error(`Run ${runId} not found`);
  const locations = new Map(db.getLocations(runId).map((l) => [l.id, l]));
  const auditedCount = [...locations.values()].filter((l) => l.audited).length || 1;
  const keyJourney = new Set(options.keyJourneyUrls ?? []);
  const runDate = run.startedAt.slice(0, 10);

  // Group findings by fingerprint, in a fixed order so new IDs are allocated the same way every time.
  // Findings are stored in whatever order pages finished auditing, so sort them first.
  const findings = db
    .getRawFindings(runId)
    .map((finding) => ({ finding, key: orderKey(finding, locations) }))
    .sort((a, b) => compare(a.key, b.key))
    .map(({ finding }) => finding);
  const comparison = compareWithPrevious(db, run, [...locations.values()]);
  const tickets: Ticket[] = [];
  db.transaction(() => {
    db.clearTickets(runId);
    // Group by ticket ID rather than fingerprint, so tickets the auditor merged stay merged.
    // `primary` is a finding that belongs to the ticket itself rather than one merged into it, so a
    // merged ticket keeps its own title and details.
    const groups = new Map<string, { fp: string; findings: RawFinding[]; primary?: RawFinding }>();
    const fingerprints = new Map<number, string>();
    for (const finding of findings) {
      const fp = fingerprint(finding, groupingScope(locations.get(finding.locationId)));
      fingerprints.set(finding.id, fp);
      const own = db.ticketIdFor(run.projectId, fp, finding.category, runId).ticketId;
      const ticketId = db.resolveMerge(run.projectId, own);
      if (!groups.has(ticketId)) groups.set(ticketId, { fp, findings: [] });
      const group = groups.get(ticketId)!;
      group.findings.push(finding);
      if (own === ticketId && !group.primary) {
        group.primary = finding;
        group.fp = fp;
      }
    }
    for (const [ticketId, { fp, findings, primary }] of groups) {
      const first = primary ?? findings[0];
      const firstSeenRunId = db.ticketFirstSeenRun(run.projectId, ticketId) ?? runId;
      const firstSeen = firstSeenRunId === runId ? runDate : (db.getRun(firstSeenRunId)?.startedAt.slice(0, 10) ?? runDate);
      const location = locations.get(first.locationId)!;
      const affected = new Set(findings.map((f) => f.locationId));
      const severity = SEVERITIES.find((s) => findings.some((f) => f.severity === s))!;
      const onKeyJourney = [...affected].some((id) => keyJourney.has(locations.get(id)!.url));
      const guidance = guidanceWithFallback(first.engine, first.ruleId, first);
      const where =
        location.kind === 'state' && !first.component?.startsWith('site:')
          ? first.componentShared
            ? 'shared header, every screen'
            : affected.size === 1
              ? `“${location.title}” screen`
              : `${affected.size} screens`
          : componentLabel(first.component ?? '', first.componentShared, location.templateKey);
      const criterion = first.wcagCriteria.join(', ') || null;

      const override = db.getOverride(run.projectId, ticketId);
      const reach = affected.size / auditedCount;
      const ticket: Ticket = {
        runId,
        ticketId,
        fingerprint: fp,
        category: first.category,
        title: `${guidance.title} (${where})`,
        severity,
        priority: calculatePriority(severity, reach, onKeyJourney),
        status: firstSeenRunId === runId ? 'New' : comparison.statusOf(ticketId, first.module),
        wcagCriterion: criterion,
        wcagLevel: first.wcagLevel,
        ruleId: first.ruleId,
        engine: first.engine,
        templateKey: first.componentShared ? null : location.kind === 'state' ? groupingScope(location) : location.templateKey,
        occurrences: findings.length,
        locationsAffected: affected.size,
        exampleLocation: location.url,
        exampleSelector: first.selector,
        description: guidance.description,
        whyItMatters: guidance.whyItMatters,
        stepsToReproduce: stepsToReproduce(first, location),
        expected: criterion
          ? `The element passes the "${first.ruleId}" check, meeting WCAG ${criterion}${first.wcagLevel ? ` (level ${first.wcagLevel})` : ''}.`
          : `The element passes the "${first.ruleId}" check.`,
        actual: first.failureSummary?.trim() || first.title,
        recommendation: guidance.recommendation,
        effort: guidance.effort,
        labels: labelsFor(first),
        auditorNotes: '',
        firstSeen,
        lastSeen: runDate,
      };
      if (override) applyOverride(ticket, override, reach, onKeyJourney);
      db.saveTicket(ticket);
      tickets.push(ticket);
      for (const finding of findings) {
        db.setRawFindingTicket(finding.id, fingerprints.get(finding.id)!, ticketId);
        db.addOccurrence({
          runId,
          ticketId,
          locationId: finding.locationId,
          rawFindingId: finding.id,
          viewport: finding.viewport,
          selector: finding.selector,
          html: finding.html,
          crop: finding.crop,
        });
      }
    }
    // Problems from the previous audit that this audit checked for, in the same places, and didn't find.
    for (const ticket of comparison.fixed(new Set(groups.keys()))) {
      db.saveTicket(ticket);
      tickets.push(ticket);
    }
  });
  return tickets.sort((a, b) => a.ticketId.localeCompare(b.ticketId, 'en', { numeric: true }));
}

/** Where a location is, for matching it across audits: its path, and the screen title for explored screens. */
export function locationKey(location: Pick<Location, 'url' | 'kind' | 'title'>): string {
  const url = new URL(location.url);
  return `${url.pathname}${url.search}${location.kind === 'state' ? `#${location.title ?? ''}` : ''}`;
}

/**
 * Status against the project's previous complete audit. A ticket is Recurring if that audit had it,
 * Regressed if it was seen before but that audit checked for it and didn't find it (or marked it
 * Fixed), and Fixed if that audit had it, this audit ran the same check on at least one of the same
 * locations, and nothing was found. Anything this audit didn't check stays out, so running a smaller
 * test group doesn't make problems look fixed.
 */
function compareWithPrevious(db: PregoDb, run: { id: number; settings: Record<string, unknown> }, locations: Location[]) {
  const previous = db.previousRun(run.id);
  const modulesOf = (settings: Record<string, unknown>) => new Set(((settings.modules as { id: string }[] | undefined) ?? []).map((m) => m.id));
  const ranNow = modulesOf(run.settings);
  const ranBefore = previous ? modulesOf(previous.settings) : new Set<string>();
  const previousTickets = new Map((previous ? db.getTickets(previous.id) : []).map((t) => [t.ticketId, t]));
  const checkedNow = new Set(locations.filter((l) => l.audited).map(locationKey));

  return {
    statusOf(ticketId: string, module: string): Ticket['status'] {
      const before = previousTickets.get(ticketId);
      if (before && before.status !== 'Fixed') return 'Recurring';
      return previous && ranBefore.has(module) ? 'Regressed' : 'Recurring';
    },
    fixed(present: Set<string>): Ticket[] {
      if (!previous) return [];
      const previousLocations = new Map(db.getLocations(previous.id).map((l) => [l.id, l]));
      const findings = new Map<string, RawFinding[]>();
      for (const f of db.getRawFindings(previous.id)) if (f.ticketId) findings.set(f.ticketId, [...(findings.get(f.ticketId) ?? []), f]);
      const out: Ticket[] = [];
      for (const ticket of previousTickets.values()) {
        if (present.has(ticket.ticketId) || ticket.status === 'Fixed' || ticket.status === 'Dismissed' || ticket.status === 'Needs review') continue;
        const own = findings.get(ticket.ticketId) ?? [];
        if (!own.length || !own.every((f) => ranNow.has(f.module))) continue;
        const rechecked = own.some((f) => {
          const location = previousLocations.get(f.locationId);
          return location && checkedNow.has(locationKey(location));
        });
        if (!rechecked) continue;
        out.push({ ...ticket, runId: run.id, status: 'Fixed', occurrences: 0, locationsAffected: 0 });
      }
      return out;
    },
  };
}

/** Apply the auditor's saved triage to a freshly built ticket. */
export function applyOverride(ticket: Ticket, override: TicketOverride, reach: number, onKeyJourney: boolean) {
  if (override.title) ticket.title = override.title;
  if (override.severity) ticket.severity = override.severity;
  // A changed severity moves the computed priority too, unless priority itself was set.
  ticket.priority = override.priority ?? calculatePriority(ticket.severity, reach, onKeyJourney);
  if (override.auditorNotes !== null) ticket.auditorNotes = override.auditorNotes;
  if (override.dismissed) ticket.status = 'Dismissed';
}

/**
 * What a problem is grouped within. Pages group by template. Screens of an interactive all share one
 * app shell, so they group across the whole app (by address path): the same problem in the same
 * component is one ticket, with each screen as an occurrence.
 */
function groupingScope(location: Location | undefined): string | null {
  if (!location) return null;
  if (location.kind === 'state') return `app:${new URL(location.url).pathname}`;
  return location.templateKey;
}

function orderKey(finding: RawFinding, locations: Map<number, Location>): string[] {
  const location = locations.get(finding.locationId);
  return [
    finding.category,
    String(location?.depth ?? 0).padStart(4, '0'),
    location?.url ?? '',
    finding.ruleId,
    finding.component ?? '',
    finding.selector,
    finding.viewport,
  ];
}

/** Plain code-point comparison, field by field (localeCompare ignores some characters). */
function compare(a: string[], b: string[]): number {
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return a[i] < b[i] ? -1 : 1;
  return 0;
}

function stepsToReproduce(finding: RawFinding, location: Location): string {
  const journey = location.steps?.[0]?.role === 'journey';
  const taps = location.steps?.map((s) => (journey ? `${s.label}.` : `Press “${s.label}”.`)) ?? [];
  const lines = [
    // A journey's first step opens the start page itself.
    ...(journey ? [`At the ${finding.viewport} viewport:`] : [`Open ${location.url} at the ${finding.viewport} viewport.`]),
    ...taps,
    ...(location.kind === 'state' && !journey ? [`You should now see the “${location.title}” screen.`] : []),
    finding.selector === 'html' ? 'Look at the screen as a whole.' : `Find the element matching the CSS selector: ${finding.selector}`,
    finding.engine === 'prego'
      ? (finding.failureSummary ?? '')
      : `Run ${finding.engine} (or a browser extension using it) and look for the "${finding.ruleId}" rule.`,
  ].filter(Boolean);
  return lines.map((line, i) => `${i + 1}. ${line}`).join('\n');
}

function labelsFor(finding: RawFinding): string[] {
  const labels = ['prego', CATEGORY_NAMES[finding.category].toLowerCase().replace(/\s+/g, '-')];
  for (const criterion of finding.wcagCriteria) labels.push(`wcag-${criterion}`);
  if (finding.ruleId === 'canvas-content') labels.push('manual-review');
  return labels;
}
