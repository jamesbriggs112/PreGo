import { HeadingLevel, Paragraph, Table, TextRun } from 'docx';
import type { ExportPlan } from './plan.js';
import { categoryScores, heading, issuesText, para, plural, scopeSentence, table, writtenText } from './docx.js';
import { actionPlan, PLAN_GROUPS, type PlanGroup, type PlanRow } from './action-plan.js';
import { EFFORT_TEXT, type Area } from './fix-meta.js';
import { strengths, type Strength } from './strengths.js';
import { connections, hasCrossData } from './focus.js';
import { buildSiteProfile } from '../profile/profile.js';
import type { CarbonRating } from '../profile/carbon.js';

// The pages a reader sees first: "At a glance" (a verdict, a status per area and the three things to
// fix first), the action plan, and what's working well. Shared by the client report and the overview.

/** A status per area, from its score. Always shown with the score and its issue count. */
export function areaStatus(score: number): 'Good' | 'Needs attention' | 'Needs significant work' {
  return score >= 85 ? 'Good' : score >= 50 ? 'Needs attention' : 'Needs significant work';
}

const AREA_PHRASE: Record<Area, string> = {
  'Site header and navigation': 'the site header and menus',
  'Site footer': 'the site footer',
  Forms: 'the forms',
  'Media and embeds': 'videos and embedded content',
  'Page templates': 'the page layouts',
  Content: 'the page content',
  'Site-wide technical': 'server and site-wide settings',
};

const GROUP_INTRO: Record<PlanGroup, string> = {
  'Quick wins': 'High impact and a small job: do these first.',
  'Plan next': 'Bigger jobs, or less pressing ones: plan them in.',
  'When you can': 'Smaller improvements and advice.',
};

/** Most rows shown in "When you can"; the rest are in report.docx and tickets.csv. */
const MAX_LATER_ROWS = 8;
/** Most rows shown in "Plan next"; every issue still has a fix card or a row in the developer report. */
const MAX_NEXT_ROWS = 15;
/** "Where" text in the plan table is cut at this length; the fix cards have it in full. */
const MAX_WHERE = 48;
const short = (text: string) => (text.length > MAX_WHERE ? `${text.slice(0, MAX_WHERE - 1).trimEnd()}…` : text);

const lowerFirst = (text: string) => text.charAt(0).toLowerCase() + text.slice(1);
const upperFirst = (text: string) => text.charAt(0).toUpperCase() + text.slice(1);
const joinAnd = (items: string[]) => (items.length <= 1 ? items.join('') : `${items.slice(0, -1).join(', ')} and ${items.at(-1)}`);

/** A rating from A+ to F as a status: the Sustainable Web Design model's A+ to B is good. */
export function carbonStatus(rating: CarbonRating): 'Good' | 'Needs attention' | 'Needs significant work' {
  return ['A+', 'A', 'B'].includes(rating) ? 'Good' : ['C', 'D'].includes(rating) ? 'Needs attention' : 'Needs significant work';
}

/** The carbon row for the scores table: a rating per page view rather than a score out of 100. */
function carbonRow(plan: ExportPlan): string[] | null {
  const carbon = buildSiteProfile(plan.locations, { greenHosting: plan.project.settings.client?.greenHosting === 'yes' })?.carbon;
  if (!carbon) return null;
  return [
    'Carbon per page view',
    carbonStatus(carbon.rating),
    `Rating ${carbon.rating}`,
    `${carbon.averageGrams.toFixed(2)} g CO₂e on average, ${(carbon.averageBytes / 1_000_000).toFixed(1)} MB per page${carbon.greenHosting ? ', green hosting' : ''}`,
  ];
}

/** One sentence on the site as a whole, from what's good and where the serious problems are. */
export function verdict(rows: PlanRow[], good: Strength[]): string {
  const serious = rows.filter((r) => r.impact === 'High' && !r.advisory);
  const goods = good.slice(0, 2).map((s) => lowerFirst(s.text));
  const opening = goods.length ? `${upperFirst(joinAnd(goods))}. ` : '';
  if (!serious.length) return `${opening}No serious problems were found: the plan lists smaller improvements.`;
  const byArea = new Map<Area, number>();
  // Weighed by how much each problem matters, not how many there are.
  for (const r of serious) byArea.set(r.area, (byArea.get(r.area) ?? 0) + r.score);
  const areas = [...byArea.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 2)
    .map(([a]) => AREA_PHRASE[a]);
  const reasons = [...new Set(serious.flatMap((r) => (r.affects.length ? r.affects : [r.reason])))].slice(0, 2).map(lowerFirst);
  const first = `${goods.length ? 'But ' : ''}${serious.length} ${plural(serious.length, 'issue')} need${serious.length === 1 ? 's' : ''} fixing first, mostly in ${joinAnd(areas)}.`;
  return `${opening}${first}${reasons.length ? ` They affect ${joinAnd(reasons)} most.` : ''}`;
}

/** The first things to fix: quick wins first, then the next most important. */
export function firstFixes(rows: PlanRow[], count = 3): PlanRow[] {
  // Different fixes: the same fix in a second place adds less than the next problem.
  const chosen: PlanRow[] = [];
  for (const r of rows.filter((r) => r.group !== 'When you can')) {
    if (chosen.length < count && !chosen.some((c) => c.fix === r.fix)) chosen.push(r);
  }
  return chosen;
}

export interface GlanceData {
  rows: PlanRow[];
  good: Strength[];
}

export function glanceData(plan: ExportPlan): GlanceData {
  return { rows: actionPlan(plan), good: strengths(plan) };
}

/** "At a glance": the verdict, a status per area, the three things to fix first, and the scope. */
export function glanceSection(plan: ExportPlan, data: GlanceData, title: Paragraph): (Paragraph | Table)[] {
  const scores = categoryScores(plan).filter((c) => c.score !== null);
  const first = firstFixes(data.rows);
  const out: (Paragraph | Table)[] = [title, new Paragraph({ spacing: { after: 160 }, children: [new TextRun({ text: verdict(data.rows, data.good), bold: true, size: 26 })] })];
  if (plan.options.text.summary) out.push(...writtenText(plan.options.text.summary));
  const carbon = carbonRow(plan);
  if (scores.length || carbon) {
    out.push(
      table(['Area', 'Status', 'Score', 'Issues'], [...scores.map((c) => [c.name, areaStatus(c.score!), `${c.score} / 100`, issuesText(c)]), ...(carbon ? [carbon] : [])], {
        boldFirstColumn: true,
        chips: [1],
      }),
      para('Scores count each distinct problem once, weighted by severity and how much of the site it affects. They show where to focus, not compliance.'),
    );
  }
  if (first.length) {
    out.push(heading(`Fix ${first.length === 3 ? 'these three' : 'these'} first`, HeadingLevel.HEADING_2));
    first.forEach((r, i) =>
      out.push(
        new Paragraph({
          spacing: { after: 100 },
          indent: { left: 360, hanging: 360 },
          children: [
            new TextRun({ text: `${i + 1}.\t${r.fix}. `, bold: true }),
            new TextRun(`Where: ${lowerFirst(r.where)}. ${r.impact} impact, for ${lowerFirst(r.reason)}. Who: ${lowerFirst(r.who)}. Effort: ${lowerFirst(EFFORT_TEXT[r.effort])}.`),
          ],
        }),
      ),
    );
  }
  // What the findings mean together, when the project has visitor figures or personas.
  const links = hasCrossData(plan) ? connections(plan).slice(0, 4) : [];
  if (links.length)
    out.push(heading('What it means for your visitors', HeadingLevel.HEADING_2), ...links.map((l) => new Paragraph({ bullet: { level: 0 }, children: [new TextRun(l)] })));
  out.push(new Paragraph({ spacing: { before: 160 }, children: [new TextRun({ text: 'Scope: ', bold: true }), new TextRun(`${scopeSentence(plan)}.`)] }));
  return out;
}

/** The action plan: every distinct issue, in order, with who fixes it and how big a job it is. */
export function actionPlanSection(data: GlanceData, title: Paragraph, options: { groups?: PlanGroup[]; maxRows?: number; skip?: PlanRow[] } = {}): (Paragraph | Table)[] {
  const out: (Paragraph | Table)[] = [title];
  if (!data.rows.length) return [...out, para('Automated checks raised no issues in the areas checked.')];
  out.push(
    para(
      'Each row is one problem, wherever it appears. Effort: Quick is under an hour, Small under a day, Medium one to three days, Large more. Refs match the fix cards and the developer report.',
    ),
  );
  let n = 0;
  for (const group of options.groups ?? PLAN_GROUPS) {
    const rows = data.rows.filter((r) => r.group === group && !options.skip?.includes(r));
    if (!rows.length) continue;
    const limit = options.maxRows ?? (group === 'When you can' ? MAX_LATER_ROWS : group === 'Plan next' ? MAX_NEXT_ROWS : rows.length);
    const shown = rows.slice(0, limit);
    out.push(
      heading(`${group} (${rows.length})`, HeadingLevel.HEADING_2),
      para(GROUP_INTRO[group]),
      table(
        ['#', 'Fix', 'Where', 'Who and effort', 'Impact', 'Ref'],
        shown.map((r) => [
          String(++n),
          r.fix,
          short(r.where),
          `${r.who}, ${lowerFirst(r.effort)}`,
          `${r.impact}: ${lowerFirst(r.reason)}`,
          r.refs.slice(0, 2).join(', ') + (r.refs.length > 2 ? ` +${r.refs.length - 2}` : ''),
        ]),
        { fontSize: 17, chips: [4] },
      ),
    );
    n += rows.length - shown.length;
    if (rows.length > shown.length) out.push(para(`And ${rows.length - shown.length} more, in the fix cards, the developer report and tickets.csv.`));
  }
  return out;
}

/** What's working well, each with its evidence. */
export function strengthsSection(data: GlanceData, title: Paragraph): Paragraph[] {
  if (!data.good.length)
    return [title, para('The checks in this audit didn’t single out particular strengths. That doesn’t mean there aren’t any: see the scores on the At a glance page.')];
  return [
    title,
    ...data.good.map((s) => new Paragraph({ bullet: { level: 0 }, spacing: { after: 80 }, children: [new TextRun({ text: `${s.text}. `, bold: true }), new TextRun(s.evidence)] })),
  ];
}
