import type { AudienceProfile } from '../audience/types.js';
import type { Location, Run, Severity } from '../types.js';
import { normalisePath } from './analytics.js';
import { treeTest, type TaskOutcome, type TreeResult } from '../tasks/tree.js';
import type { WalkResult } from '../tasks/walkthrough.js';

// The cross-analysis: which purposes, personas and tasks each finding gets in the way of, and a focus
// score from severity, traffic and purpose together. It joins what the separate reports found, so
// the Overview can say where to start and why.

/** What a ticket gets in the way of. IDs from the project's audience profile. */
export interface TicketImpact {
  purposeIds: string[];
  personaIds: string[];
  taskIds: string[];
  /** Personas for whom it's a barrier, not just an annoyance: accessibility and assistive technology, or phones. */
  barrierFor: string[];
  /** Tasks it sits on the route of that didn't succeed. */
  blocksTaskIds: string[];
  /** Severity weighted by traffic and by the purposes and tasks it affects. Higher first. */
  score: number;
}

const SEVERITY_WEIGHT: Record<Severity, number> = { Critical: 8, High: 4, Medium: 2, Low: 1 };

/** The minimal ticket shape the analysis needs, so it can run before or after the export plan is built. */
export interface ImpactTicket {
  ticketId: string;
  category: string;
  severity: Severity;
  traffic: number | null;
  occurrenceList: { viewport: string; location: Location }[];
}

/** Pages on each task's way: the home page, the shortest route, where it's done, and where the walkthrough went. */
export function taskJourneys(profile: AudienceProfile, tree: TreeResult[], walk: WalkResult[]): Map<string, Set<string>> {
  const journeys = new Map<string, Set<string>>();
  for (const task of profile.tasks) {
    const pages = new Set<string>(['/']);
    for (const step of tree.find((r) => r.taskId === task.id)?.route ?? []) pages.add(step.path);
    if (task.success.kind === 'page') {
      const path = normalisePath(task.success.path);
      if (path) pages.add(path);
    }
    for (const step of walk.find((r) => r.taskId === task.id)?.steps ?? []) {
      const path = normalisePath(step.url);
      if (path) pages.add(path);
    }
    journeys.set(task.id, pages);
  }
  return journeys;
}

/** Purposes a task serves: its own, or its persona's. */
export function taskPurposes(profile: AudienceProfile, taskId: string): string[] {
  const task = profile.tasks.find((t) => t.id === taskId);
  if (!task) return [];
  if (task.purposeId) return [task.purposeId];
  return profile.personas.find((p) => p.id === task.personaId)?.purposeIds ?? [];
}

/** Each ticket's impact on the site's purposes and people. Without an audience profile, only traffic weighs in. */
export function ticketImpacts(
  profile: AudienceProfile | undefined,
  locations: Location[],
  run: Pick<Run, 'summary'>,
  tickets: ImpactTicket[],
): Map<string, TicketImpact> {
  const tree = profile ? treeTest(profile, locations) : [];
  const walk = (run.summary.walkthrough as WalkResult[] | undefined) ?? [];
  const journeys = profile ? taskJourneys(profile, tree, walk) : new Map<string, Set<string>>();
  const unfinished = new Set(
    profile?.tasks
      .filter((t) => {
        const outcomes: TaskOutcome[] = [tree.find((r) => r.taskId === t.id)?.outcome, walk.find((r) => r.taskId === t.id)?.outcome].filter((o): o is TaskOutcome => !!o);
        return outcomes.some((o) => o === 'failed' || o === 'partial');
      })
      .map((t) => t.id) ?? [],
  );
  const impacts = new Map<string, TicketImpact>();
  for (const ticket of tickets) {
    const pages = new Set(ticket.occurrenceList.filter((o) => o.location?.kind === 'page').map((o) => normalisePath(o.location.url) ?? ''));
    const taskIds = profile ? profile.tasks.filter((t) => [...(journeys.get(t.id) ?? [])].some((p) => pages.has(p))).map((t) => t.id) : [];
    const personaIds = [...new Set(taskIds.map((id) => profile!.tasks.find((t) => t.id === id)!.personaId))];
    const purposeIds = [...new Set(taskIds.flatMap((id) => taskPurposes(profile!, id)))];
    const mobileOnly = ticket.occurrenceList.length > 0 && ticket.occurrenceList.every((o) => /mobile|tablet/.test(o.viewport));
    const barrierFor = personaIds.filter((id) => {
      const persona = profile!.personas.find((p) => p.id === id)!;
      return (ticket.category === 'A11Y' && !!persona.accessNeeds) || (persona.device === 'mobile' && (mobileOnly || ticket.category === 'PERF'));
    });
    const blocksTaskIds = taskIds.filter((id) => unfinished.has(id));
    const primary = purposeIds.filter((id) => profile!.purposes.find((p) => p.id === id)?.priority === 'primary').length;
    const score =
      SEVERITY_WEIGHT[ticket.severity] *
      (1 + 2 * (ticket.traffic ?? 0)) *
      (1 + 0.5 * primary + 0.25 * (purposeIds.length - primary)) *
      (1 + 0.5 * barrierFor.length) *
      (blocksTaskIds.length ? 1.5 : 1);
    impacts.set(ticket.ticketId, { purposeIds, personaIds, taskIds, barrierFor, blocksTaskIds, score: Math.round(score * 100) / 100 });
  }
  return impacts;
}

/** The "Affects" line for tickets.csv and the report: purposes, then people, by name. */
export function impactText(impact: TicketImpact | undefined, profile: AudienceProfile | undefined): string {
  if (!impact || !profile) return '';
  const purposes = impact.purposeIds.map((id) => profile.purposes.find((p) => p.id === id)?.title).filter(Boolean);
  const people = impact.personaIds.map((id) => {
    const persona = profile.personas.find((p) => p.id === id);
    return persona ? `${persona.name}${impact.barrierFor.includes(id) ? ' (barrier)' : ''}` : null;
  });
  return [...purposes, ...people].filter(Boolean).join('; ');
}
