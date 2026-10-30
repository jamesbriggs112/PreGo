import { createHash } from 'node:crypto';
import type { PregoDb } from '../db/database.js';
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
  const groups = new Map<string, RawFinding[]>();
  for (const finding of findings) {
    const fp = fingerprint(finding, locations.get(finding.locationId)?.templateKey ?? null);
    groups.set(fp, [...(groups.get(fp) ?? []), finding]);
  }
  const ordered = [...groups.entries()];

  const tickets: Ticket[] = [];
  db.transaction(() => {
    db.clearTickets(runId);
    for (const [fp, findings] of ordered) {
      const first = findings[0];
      const { ticketId } = db.ticketIdFor(run.projectId, fp, first.category, runId);
      const firstSeenRunId = db.ticketFirstSeenRun(run.projectId, ticketId) ?? runId;
      const firstSeen = firstSeenRunId === runId ? runDate : (db.getRun(firstSeenRunId)?.startedAt.slice(0, 10) ?? runDate);
      const location = locations.get(first.locationId)!;
      const affected = new Set(findings.map((f) => f.locationId));
      const severity = SEVERITIES.find((s) => findings.some((f) => f.severity === s))!;
      const onKeyJourney = [...affected].some((id) => keyJourney.has(locations.get(id)!.url));
      const guidance = guidanceWithFallback(first.engine, first.ruleId, first);
      const where = componentLabel(first.component ?? '', first.componentShared, location.templateKey);
      const criterion = first.wcagCriteria.join(', ') || null;

      const ticket: Ticket = {
        runId,
        ticketId,
        fingerprint: fp,
        category: first.category,
        title: `${guidance.title} (${where})`,
        severity,
        priority: calculatePriority(severity, affected.size / auditedCount, onKeyJourney),
        status: firstSeenRunId === runId ? 'New' : 'Recurring',
        wcagCriterion: criterion,
        wcagLevel: first.wcagLevel,
        ruleId: first.ruleId,
        engine: first.engine,
        templateKey: first.componentShared ? null : location.templateKey,
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
      db.saveTicket(ticket);
      tickets.push(ticket);
      for (const finding of findings) {
        db.setRawFindingTicket(finding.id, fp, ticketId);
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
  });
  return tickets.sort((a, b) => a.ticketId.localeCompare(b.ticketId, 'en', { numeric: true }));
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
  const lines = [
    `Open ${location.url} at the ${finding.viewport} viewport.`,
    finding.selector === 'html' ? 'Inspect the page as a whole.' : `Find the element matching the CSS selector: ${finding.selector}`,
    `Run ${finding.engine} (or a browser extension using it) and look for the "${finding.ruleId}" rule.`,
  ];
  return lines.map((line, i) => `${i + 1}. ${line}`).join('\n');
}

function labelsFor(finding: RawFinding): string[] {
  const labels = ['prego', CATEGORY_NAMES[finding.category].toLowerCase().replace(/\s+/g, '-')];
  for (const criterion of finding.wcagCriteria) labels.push(`wcag-${criterion}`);
  return labels;
}
