import { CATEGORIES, CATEGORY_NAMES, SEVERITIES } from '../types.js';
import { averagePerformance } from '../checks/lighthouse/lighthouse.js';
import type { ExportPlan, PlannedTicket } from './plan.js';
import { isAdvisory } from '../tickets/advisory.js';

/**
 * Starting text for a client-facing report's written sections, worked out from the findings. Used
 * when the auditor leaves a section blank, and offered on the Export page to edit. It says what the
 * checks found; it never claims the site meets (or fails) a standard.
 */
export function suggestReportText(plan: Pick<ExportPlan, 'tickets' | 'locations' | 'run'>): { keyFindings: string; recommendations: string; methodology: string } {
  return { keyFindings: keyFindings(plan), recommendations: recommendations(plan.tickets), methodology: methodology(plan) };
}

function keyFindings({ tickets, locations }: Pick<ExportPlan, 'tickets' | 'locations'>): string {
  const lines: string[] = [];
  const byCategory = CATEGORIES.map((c) => ({ c, tickets: tickets.filter((t) => t.category === c) }))
    .filter((x) => x.tickets.length)
    .sort((a, b) => serious(b.tickets) - serious(a.tickets) || b.tickets.length - a.tickets.length);
  for (const { c, tickets: inCategory } of byCategory.slice(0, 5)) {
    const n = serious(inCategory);
    const theme = themes(inCategory)[0];
    lines.push(
      `${CATEGORY_NAMES[c]}: ${inCategory.length} ${inCategory.length === 1 ? 'issue' : 'issues'}${n ? `, ${n} of them critical or high severity` : ''}. The most serious is “${theme.name.toLowerCase()}”.`,
    );
  }
  const performance = averagePerformance(locations);
  if (performance !== null) lines.push(`The average Lighthouse performance score is ${performance} out of 100${performance < 50 ? ', so pages load slowly' : performance < 90 ? ', with room to load faster' : ''}.`);
  const busy = tickets.filter((t) => t.priorityRaised).length;
  if (busy) lines.push(`${busy} ${busy === 1 ? 'issue is' : 'issues are'} on pages that get a quarter or more of all visits, so ${busy === 1 ? 'it has' : 'they have'} been moved up a priority level.`);
  const broken = locations.filter((l) => (l.statusCode ?? 0) >= 400).length;
  if (broken) lines.push(`${broken} ${broken === 1 ? 'link leads' : 'links lead'} to a page that doesn’t load.`);
  if (!lines.length) lines.push('Automated checks raised no issues in the areas checked.');
  return lines.map((l) => `- ${l}`).join('\n');
}

function recommendations(tickets: PlannedTicket[]): string {
  return themes(tickets)
    .slice(0, 6)
    .map((t) => `${t.name}: ${t.recommendation}`)
    .join('\n');
}

function methodology({ run, locations }: Pick<ExportPlan, 'run' | 'locations'>): string {
  const s = run.settings as { viewports?: string[]; modules?: { name: string }[] };
  const viewports = s.viewports?.join(', ') ?? 'desktop';
  const checks = s.modules?.map((m) => m.name) ?? [];
  const audited = locations.filter((l) => l.audited).length;
  const how =
    run.mode === 'explore'
      ? `We explored the interactive by pressing every control on every screen, and checked the ${audited} screens we reached`
      : run.mode === 'journey'
        ? `We recorded a journey through the site and replayed it, checking the page after each of its ${audited} steps`
        : `We crawled the site through its links and sitemap, and checked ${audited} pages, a sample of each page template`;
  return [
    `${how}, at ${viewports} screen sizes.`,
    `Automated checks covered: ${checks.join('; ') || 'the default checks'}. Similar problems were grouped into tickets, each with a severity and priority, so they can be planned and tracked.`,
    'Automated checks find only some problems, so this report should be read alongside manual testing (see Limitations and manual testing).',
  ].join('\n\n');
}

function serious(tickets: PlannedTicket[]): number {
  return tickets.filter((t) => t.severity === 'Critical' || t.severity === 'High').length;
}

/** Tickets grouped by rule, worst first, with the theme's shared recommendation. */
function themes(all: PlannedTicket[]): { name: string; recommendation: string }[] {
  // Advice (AAA, best practice, spelling) only leads when there's nothing else.
  const failures = all.filter((t) => !isAdvisory(t));
  const tickets = failures.length ? failures : all;
  const groups = new Map<string, PlannedTicket[]>();
  for (const t of tickets) groups.set(`${t.engine}:${t.ruleId}`, [...(groups.get(`${t.engine}:${t.ruleId}`) ?? []), t]);
  const worst = (g: PlannedTicket[]) => Math.min(...g.map((t) => SEVERITIES.indexOf(t.severity)));
  return [...groups.values()]
    .sort((a, b) => worst(a) - worst(b) || b.length - a.length)
    .map((g) => ({ name: g[0].title.replace(/ \([^)]*\)$/, ''), recommendation: g[0].recommendation }));
}
