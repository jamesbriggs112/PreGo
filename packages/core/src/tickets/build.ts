import { createHash } from 'node:crypto';
import type { PregoDb, TicketOverride } from '../db/database.js';
import { guidanceWithFallback } from '../checks/guidance.js';
import { componentLabel } from './component.js';
import { isAdvisory } from './advisory.js';
import { AI_ENGINE } from '../checks/ai/ai.js';
import { CATEGORY_NAMES, SEVERITIES, type Location, type Priority, type RawFinding, type Severity, type Ticket } from '../types.js';

/**
 * A problem's fingerprint in Prego's first grouping: rule + component + where it lives (the template,
 * or `site` for components shared by every page). Still worked out so that projects audited before
 * the current grouping keep their ticket IDs (see `buildTickets`).
 */
export function fingerprint(finding: Pick<RawFinding, 'engine' | 'ruleId' | 'component' | 'componentShared' | 'selector'>, templateKey: string | null): string {
  const scope = finding.componentShared ? 'site' : `template:${templateKey ?? ''}`;
  const component = finding.component ?? `selector:${finding.selector}`;
  return createHash('sha1').update([finding.engine, finding.ruleId, scope, component].join('\n')).digest('hex').slice(0, 16);
}

/**
 * A problem's fingerprint: rule + component, wherever it appears. The same component with the same
 * problem on several page templates is one problem, so one ticket listing where it is. Interactive
 * apps still group by screen address (see `groupingScope`).
 */
export function problemFingerprint(finding: Pick<RawFinding, 'engine' | 'ruleId' | 'component' | 'selector'>, location: Location | undefined): string {
  const scope = location?.kind === 'state' ? groupingScope(location) : 'any';
  const component = normaliseComponent(finding.component ?? `selector:${finding.selector}`);
  // The same check in IBM's engine counts as axe's, so the two engines make one ticket.
  const same = finding.engine === 'ibm' ? AXE_EQUIVALENT[finding.ruleId] : undefined;
  const [engine, ruleId] = same ? ['axe-core', same] : [finding.engine, finding.ruleId];
  return createHash('sha1').update(['v2', engine, ruleId, scope, component].join('\n')).digest('hex').slice(0, 16);
}

/** IBM Equal Access rules that test the same thing as an axe rule. */
export const AXE_EQUIVALENT: Record<string, string> = {
  html_lang_exists: 'html-has-lang',
  text_contrast_sufficient: 'color-contrast',
  a_text_purpose: 'link-name',
  frame_title_exists: 'frame-title',
  img_alt_valid: 'image-alt',
  input_label_exists: 'label',
  aria_widget_labelled: 'aria-input-field-name',
  svg_graphics_labelled: 'svg-img-alt',
  page_title_exists: 'document-title',
};

/**
 * A component's path without the classes on <body>, which many sites set per page type or address
 * (`page-node-type-article`, `path-frontpage`) and which would make one header look like several.
 */
export function normaliseComponent(component: string): string {
  return component.replace(/^body(\.[^>]*)?(?=>|$)/, 'body');
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
  const templateCount = new Set([...locations.values()].filter((l) => l.audited && l.kind === 'page').map((l) => l.templateKey)).size || 1;
  const keyJourney = new Set(options.keyJourneyUrls ?? []);

  // Group findings by fingerprint, in a fixed order so new IDs are allocated the same way every time.
  // Findings are stored in whatever order pages finished auditing, so sort them first.
  const findings = db
    .getRawFindings(runId)
    .map((finding) => ({ finding, key: orderKey(finding, locations) }))
    .sort((a, b) => compare(a.key, b.key))
    .map(({ finding }) => finding);
  const tickets: Ticket[] = [];
  db.transaction(() => {
    db.clearTickets(runId);
    // One problem per fingerprint. A problem keeps the ticket ID it had under the first grouping
    // (the lowest, when it was split across templates), so dismissals and notes carry over.
    const problems = new Map<string, RawFinding[]>();
    for (const finding of findings) {
      const fp = problemFingerprint(finding, locations.get(finding.locationId));
      problems.set(fp, [...(problems.get(fp) ?? []), finding]);
    }
    const ownIds = new Map<string, string>();
    for (const [fp, group] of problems) {
      const legacy = [...new Set(group.map((f) => fingerprint(f, groupingScope(locations.get(f.locationId)))))]
        .map((old) => db.existingTicketId(run.projectId, old))
        .filter((id): id is string => !!id)
        .sort((a, b) => a.localeCompare(b, 'en', { numeric: true }));
      ownIds.set(fp, legacy[0] ?? db.ticketIdFor(run.projectId, fp, group[0].category, runId).ticketId);
    }
    // Group by ticket ID rather than fingerprint, so tickets the auditor merged stay merged.
    // `primary` is a finding that belongs to the ticket itself rather than one merged into it, so a
    // merged ticket keeps its own title and details.
    const groups = new Map<string, { fp: string; findings: RawFinding[]; primary?: RawFinding }>();
    const fingerprints = new Map<number, string>();
    for (const finding of findings) {
      const fp = problemFingerprint(finding, locations.get(finding.locationId));
      fingerprints.set(finding.id, fp);
      const own = ownIds.get(fp)!;
      const ticketId = db.resolveMerge(run.projectId, own);
      if (!groups.has(ticketId)) groups.set(ticketId, { fp, findings: [] });
      const group = groups.get(ticketId)!;
      group.findings.push(finding);
      // The ticket's wording comes from axe when both engines found it, as axe's is plainer.
      if (own === ticketId && (!group.primary || (group.primary.engine === 'ibm' && finding.engine !== 'ibm' && AXE_EQUIVALENT[group.primary.ruleId] === finding.ruleId))) {
        group.primary = finding;
        group.fp = fp;
      }
    }
    for (const [ticketId, { fp, findings, primary }] of groups) {
      const first = primary ?? findings[0];
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
          : pagesLabel(first, affectedTemplates(affected, locations), templateCount);
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
        // AI suggestions wait for an auditor to approve them before they count or are exported.
        status: first.engine === AI_ENGINE && !override?.approved ? 'Needs review' : 'Open',
        wcagCriterion: criterion,
        wcagLevel: first.wcagLevel,
        ruleId: first.ruleId,
        engine: first.engine,
        templateKey: first.componentShared ? null : location.kind === 'state' ? groupingScope(location) : (onlyTemplate(affected, locations) ?? null),
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
        labels: [...labelsFor(first), ...(new Set(findings.map((f) => f.engine)).size > 1 ? ['found-by-two-engines'] : [])],
        auditorNotes: '',
      };
      if (isAdvisory(ticket)) ticket.labels.push('advisory');
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
  });
  return tickets.sort((a, b) => a.ticketId.localeCompare(b.ticketId, 'en', { numeric: true }));
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

/** The page templates a problem appears on. */
function affectedTemplates(affected: Set<number>, locations: Map<number, Location>): string[] {
  return [...new Set([...affected].map((id) => locations.get(id)?.templateKey ?? null).filter((t): t is string => !!t))].sort();
}

function onlyTemplate(affected: Set<number>, locations: Map<number, Location>): string | undefined {
  const templates = affectedTemplates(affected, locations);
  return templates.length === 1 ? templates[0] : undefined;
}

/**
 * Where a problem is, for its title: the shared component (site header, footer), "most pages" when
 * it's on at least half the page templates, or the templates themselves, three at most.
 */
function pagesLabel(first: RawFinding, templates: string[], templateCount: number): string {
  const component = first.component ?? '';
  if (component.startsWith('site:') || first.componentShared || templates.length <= 1) return componentLabel(component, first.componentShared, templates[0] ?? null);
  const form = component.split('>').pop()?.split('.')[0] === 'form' ? 'form on ' : '';
  if (templates.length / templateCount >= 0.5) return `${form}most pages`;
  const shown = templates.slice(0, 3).join(', ');
  return `${form}${shown}${templates.length > 3 ? ` and ${templates.length - 3} more` : ''}`;
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
