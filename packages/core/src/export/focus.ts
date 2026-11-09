import { averagePerformance } from '../checks/lighthouse/lighthouse.js';
import { themesOf } from './docx.js';
import type { ExportPlan, PlannedTicket } from './plan.js';
import { busiestPages } from './sections.js';
import { assessReadiness } from './readiness.js';
import { taskResults } from './audience-report.js';
import { taskPurposes } from './cross.js';

// Where to focus: the joined-up view for the Overview. It ranks themes by severity, traffic and the
// purposes, people and tasks they affect, and spells out the connections between the reports.

export interface FocusItem {
  name: string;
  /** Why it matters most here, in a sentence. */
  why: string;
  recommendation: string;
  score: number;
}

const lowerFirst = (text: string) => text.charAt(0).toLowerCase() + text.slice(1);
const quoteList = (items: string[]) => items.map((i) => `“${i}”`).join(' and ');

/** Whether there's anything to join up: an audience profile or traffic figures. */
export function hasCrossData(plan: Pick<ExportPlan, 'project' | 'tickets'>): boolean {
  return !!plan.project.settings.audience?.purposes.length || plan.tickets.some((t) => t.traffic !== null);
}

/** Themes ranked by their highest focus score, with the reason each matters. */
export function focusThemes(plan: ExportPlan, limit = 5): FocusItem[] {
  const profile = plan.project.settings.audience;
  return themesOf(plan.tickets)
    .map((theme) => {
      const top = [...theme.tickets].sort((a, b) => b.impact.score - a.impact.score)[0];
      const all = <T>(pick: (t: PlannedTicket) => T[]) => [...new Set(theme.tickets.flatMap(pick))];
      const traffic = Math.max(0, ...theme.tickets.map((t) => t.traffic ?? 0));
      const purposes = all((t) => t.impact.purposeIds)
        .map((id) => profile?.purposes.find((p) => p.id === id))
        .filter((p) => !!p)
        .sort((a, b) => (a.priority === b.priority ? 0 : a.priority === 'primary' ? -1 : 1));
      const blocked = all((t) => t.impact.blocksTaskIds).map((id) => profile?.tasks.find((t) => t.id === id)?.goal).filter((g): g is string => !!g);
      const barriers = all((t) => t.impact.barrierFor).map((id) => profile?.personas.find((p) => p.id === id)?.name).filter((n): n is string => !!n);
      const reasons = [
        traffic >= 0.01 && `on pages with ${Math.round(traffic * 100)}% of visits`,
        purposes.length && `gets in the way of ${quoteList(purposes.slice(0, 2).map((p) => p.title))}${purposes[0].priority === 'primary' ? ', a main purpose' : ''}`,
        blocked.length && `sits on the route of ${quoteList(blocked.slice(0, 2).map(lowerFirst))}, which people may not complete`,
        barriers.length && `a barrier for ${barriers.slice(0, 2).join(' and ')}`,
      ].filter((r): r is string => typeof r === 'string');
      const why = reasons.length ? `${top.severity} severity, ${reasons.join('; ')}.` : `${top.severity} severity, on ${theme.tickets.reduce((n, t) => n + t.locationsAffected, 0)} pages.`;
      return { name: theme.name, why: why.charAt(0).toUpperCase() + why.slice(1), recommendation: top.recommendation, score: Math.max(...theme.tickets.map((t) => t.impact.score)) };
    })
    .sort((a, b) => b.score - a.score)
    .slice(0, limit);
}

/** Connections between the reports, as plain sentences: what the figures mean together. */
export function connections(plan: ExportPlan): string[] {
  const out: string[] = [];
  const profile = plan.project.settings.audience;
  const analytics = plan.project.settings.analytics;
  const results = taskResults(plan);
  const unfinished = (taskId: string) => {
    const outcomes = [results?.tree.find((r) => r.taskId === taskId)?.outcome, results?.walk.find((r) => r.taskId === taskId)?.outcome];
    return outcomes.some((o) => o === 'failed' || o === 'partial');
  };

  // Phones: who uses them, how fast pages are, and whether phone users get things done.
  const devices = analytics?.tables.find((t) => t.id === 'devices');
  const total = devices?.rows.reduce((sum, r) => sum + r.value, 0) ?? 0;
  const mobile = total ? Math.round(((devices!.rows.find((r) => /mobile/i.test(r.label))?.value ?? 0) / total) * 100) : null;
  if (mobile !== null && mobile >= 40) {
    const performance = averagePerformance(plan.locations);
    const phoneTasks = profile ? profile.tasks.filter((t) => profile.personas.find((p) => p.id === t.personaId)?.device === 'mobile' && unfinished(t.id)) : [];
    const parts = [
      performance !== null && performance < 70 && `pages score ${performance} out of 100 for performance`,
      phoneTasks.length && `the phone user may not manage to ${lowerFirst(phoneTasks[0].goal)}`,
    ].filter((p): p is string => typeof p === 'string');
    out.push(`${mobile}% of visitors use a phone${parts.length ? `, yet ${parts.join(', and ')}` : ''}. Fixing problems on small screens first reaches the most people.`);
  }

  // The busiest page and how many serious problems it has.
  const busiest = busiestPages(plan)[0];
  if (busiest && busiest.serious > 0) {
    out.push(`The busiest page, ${busiest.path}, gets ${Math.round(busiest.share * 100)}% of visits and has ${busiest.serious} critical or high ${busiest.serious === 1 ? 'issue' : 'issues'}, so fixing it helps the most visitors at once.`);
  }

  // Main purposes whose tasks may not get done, and gaps between what the site does and should do.
  if (profile) {
    for (const purpose of profile.purposes.filter((p) => p.priority === 'primary')) {
      const tasks = profile.tasks.filter((t) => taskPurposes(profile, t.id).includes(purpose.id) && unfinished(t.id));
      if (tasks.length) out.push(`“${purpose.title}” is a main purpose, but people may not manage to ${lowerFirst(tasks[0].goal)}${tasks.length > 1 ? ` (and ${tasks.length - 1} more)` : ''}.`);
    }
    const gaps = profile.purposes.filter((p) => p.intended && !p.current);
    if (gaps.length) out.push(`The site doesn’t yet ${gaps.map((g) => lowerFirst(g.title)).join(' or ')}, which the brief asks for.`);
  }

  // Searches people see the site for but don't click.
  const missed = (analytics?.search?.queries ?? []).filter((q) => q.impressions >= 100 && q.ctr < 2 && q.position <= 10);
  if (missed.length) out.push(`People searching for “${missed[0].label}” see the site on the first page of results but rarely click, so its title and description aren’t answering that search.`);

  // Readiness for AI and voice.
  const readiness = assessReadiness(plan.locations);
  if (readiness && readiness.score < 50) {
    const weakest = readiness.items.filter((i) => i.status === 'poor').map((i) => lowerFirst(i.area));
    out.push(`Future readiness is ${readiness.score} out of 100${weakest.length ? `, weakest on ${weakest.slice(0, 2).join(' and ')}` : ''}, so AI assistants and voice search may pass the site over.`);
  }
  return out.slice(0, 6);
}
