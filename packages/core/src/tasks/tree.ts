import type { Location } from '../types.js';
import type { AudienceProfile, PageSignals, TaskSuccess, UserTask } from '../audience/types.js';
import type { NavigationMetrics } from '../export/sections.js';
import { normalisePath } from '../export/analytics.js';

// The navigation test: for each task, the shortest route from the home page to where it's done,
// through the links Prego recorded on the pages it audited. It needs no AI: it shows whether the
// structure gets people there and how many clicks it takes. Real people don't always take the
// shortest route, so it's a best case.

export type TaskOutcome = 'success' | 'partial' | 'failed' | 'unchecked';

export interface TreeResult {
  taskId: string;
  outcome: TaskOutcome;
  /** Clicks on the shortest route, or null when there's none. */
  clicks: number | null;
  /** The route as link labels, from the home page: ["What's on", "Book"]. */
  route: { label: string; path: string }[];
  /** Why the outcome is what it is, in a sentence. */
  note: string;
}

/** Up to this many clicks counts as easy to reach. */
export const EASY_CLICKS = 3;

interface Page {
  path: string;
  title: string;
  signals?: PageSignals;
}

/** Pages where the task counts as done. Exported for the walkthrough's checks. */
export function meetsSuccess(success: TaskSuccess, path: string, signals: PageSignals | undefined): boolean {
  if (success.kind === 'page') return normalisePath(success.path) === path;
  if (success.kind === 'contact') return !!signals && (signals.tel > 0 || signals.mailto > 0 || signals.phoneText || signals.forms.includes('contact'));
  if (success.kind === 'form') return !!signals?.forms.includes(success.form);
  return false;
}

/** Words of four letters or more, for comparing link labels with what a task is after. */
const words = (text: string) => new Set((text.toLowerCase().match(/[a-z][a-z'’]{3,}/g) ?? []).map((w) => w.replace(/['’]s$/, '').slice(0, 6)));
const IGNORED = new Set(['find', 'their', 'there', 'about', 'what', 'where', 'which', 'when', 'your', 'with', 'from', 'that', 'this', 'they', 'want', 'need', 'some', 'have']);

/** Whether a link label shares a meaningful word with the task: the "scent" that tells people they're on the right track. */
export function labelMatches(label: string, task: Pick<UserTask, 'goal' | 'doneWhen'>): boolean {
  const goal = [...words(`${task.goal} ${task.doneWhen}`)].filter((w) => !IGNORED.has(w));
  const link = words(label);
  return goal.some((w) => link.has(w));
}

export function treeTest(profile: AudienceProfile, locations: Location[]): TreeResult[] {
  const pages = new Map<string, Page>();
  const links = new Map<string, { label: string; path: string }[]>();
  let start: string | null = null;
  for (const l of [...locations].sort((a, b) => a.depth - b.depth || a.id - b.id)) {
    if (l.kind !== 'page' || (l.statusCode ?? 200) >= 400) continue;
    const path = normalisePath(l.url);
    if (!path || pages.has(path)) continue;
    const signals = l.metrics.signals as PageSignals | undefined;
    pages.set(path, { path, title: l.title ?? '', signals });
    start ??= path;
    const nav = (l.metrics.navigation as NavigationMetrics | undefined)?.items ?? [];
    const out = [
      ...nav.filter((n) => n.href).map((n) => ({ label: n.label, path: normalisePath(n.href!) })),
      ...(signals?.links ?? []).map((link) => ({ label: link.label, path: normalisePath(link.path) })),
    ].filter((x): x is { label: string; path: string } => !!x.path && x.path !== path);
    links.set(path, out.filter((x, i) => out.findIndex((y) => y.path === x.path) === i));
  }
  const recorded = [...links.values()].some((l) => l.length);

  // Breadth-first from the home page: the first time a page is reached is its shortest route.
  const routes = new Map<string, { label: string; path: string }[]>();
  if (start) {
    routes.set(start, []);
    const queue = [start];
    while (queue.length) {
      const at = queue.shift()!;
      for (const link of links.get(at) ?? []) {
        if (routes.has(link.path)) continue;
        routes.set(link.path, [...routes.get(at)!, link]);
        queue.push(link.path);
      }
    }
  }

  return profile.tasks.map((task): TreeResult => {
    const base = { taskId: task.id, route: [] as TreeResult['route'] };
    if (task.success.kind === 'described') return { ...base, outcome: 'unchecked', clicks: null, note: 'Described only, so Prego can’t tell where it’s done. Pick a page, contact details or a form to test it.' };
    if (!recorded) return { ...base, outcome: 'unchecked', clicks: null, note: 'The audit didn’t record links. Run it with the “Content and structure (for reports)” check.' };
    const targets = [...pages.values()].filter((p) => meetsSuccess(task.success, p.path, p.signals)).map((p) => p.path);
    // A target page Prego knows of but didn't audit (blocked by robots.txt, or not sampled).
    if (task.success.kind === 'page') {
      const path = normalisePath(task.success.path);
      if (path && !targets.includes(path) && routes.has(path)) targets.push(path);
    }
    const best = targets
      .filter((t) => routes.has(t))
      .map((t) => routes.get(t)!)
      .sort((a, b) => a.length - b.length)[0];
    if (!best) {
      return {
        ...base,
        outcome: 'failed',
        clicks: null,
        note: targets.length ? 'The page where it’s done isn’t linked from any page Prego checked, so people can’t click their way there.' : 'Prego didn’t find anywhere on the site where this is done.',
      };
    }
    const scent = best.length === 0 || labelMatches(best[0].label, task);
    const outcome: TaskOutcome = best.length <= EASY_CLICKS ? 'success' : 'partial';
    const note =
      best.length === 0
        ? 'It can be done on the home page.'
        : `${best.length} ${best.length === 1 ? 'click' : 'clicks'} from the home page${best.length > EASY_CLICKS ? ', deeper than people tend to go' : ''}.${
            scent ? '' : ` The first link, “${best[0].label}”, doesn’t obviously relate to the task, so people may not think to choose it.`
          }`;
    return { ...base, outcome: scent || outcome !== 'success' ? outcome : 'partial', clicks: best.length, route: best, note };
  });
}
