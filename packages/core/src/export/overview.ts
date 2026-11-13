import { HeadingLevel, Packer, Paragraph, Table, TextRun } from 'docx';
import { writeFileSync } from 'node:fs';
import type { Category } from '../types.js';
import { auditedCount, brandedDocument, categoryScores, issuesText, cover, heading, para, plural, resolveBranding, scopeSentence, table, writtenText, type ReportBranding } from './docx.js';
import type { ExportPlan } from './plan.js';
import { listItems } from './report-options.js';
import { suggestReportText } from './suggest.js';
import { assessReadiness } from './readiness.js';
import { connections, focusThemes, hasCrossData } from './focus.js';
import { taskResults } from './audience-report.js';

/** What each category's score covers, in plain English for the scorecard. */
const COVERS: Record<Category, string> = {
  A11Y: 'Whether disabled people, and anyone using a keyboard, screen reader or zoom, can use the site',
  UX: 'Whether people can find their way around and get things done',
  UI: 'Whether colours, type and spacing are used consistently',
  CONT: 'Page titles, descriptions, link previews and readable content, for people and search engines',
  PERF: 'How quickly pages load and respond (Lighthouse)',
  SEC: 'HTTPS, security settings and cookies that protect visitors and the organisation',
  TECH: 'Valid code, working links and other technical health',
  FUT: 'Whether search engines, AI assistants and voice search can read and understand the site',
};

/** A plain-English reading of a score. */
export function scoreRating(score: number): string {
  if (score >= 90) return 'In good shape';
  if (score >= 70) return 'A few things to fix';
  if (score >= 50) return 'Needs attention';
  return 'Needs significant work';
}

/**
 * The Overview: a short report for client leadership, read first. Scores at a glance, why a healthy
 * website matters, the key findings and top recommendations, and a guide to the rest of the pack.
 * `whyItMatters` is the standard wording from Settings, used unless the audit has its own.
 */
export async function overviewDocx(plan: ExportPlan, whyItMatters: string, branding: ReportBranding = {}): Promise<Buffer> {
  const brand = resolveBranding(branding);
  const { text } = plan.options;
  const suggested = suggestReportText(plan);
  const scores = categoryScores(plan).filter((c) => c.score !== null);
  const readiness = assessReadiness(plan.locations);
  const serious = plan.tickets.filter((t) => t.severity === 'Critical' || t.severity === 'High').length;
  const audited = auditedCount(plan);
  const unit = plan.run.mode === 'explore' ? 'screen' : plan.run.mode === 'journey' ? 'journey step' : 'page';
  const pack: string[][] = [
    ['overview.docx', 'This summary', 'Leadership and anyone new to the audit'],
    ...(plan.options.clientFacing ? [['client-report.docx', 'The full findings for the client team: every issue, grouped by category and theme, with why each matters and what to do', 'Client team and project leads']] : []),
    ['report.docx', 'Every issue found, with ticket IDs, examples, why each matters and what to do', 'Project and development teams'],
    ['tickets.csv', 'One row per issue, ready to import into a ticketing tool. Ticket IDs match report.docx', 'Development team'],
    ['occurrences.csv', 'Every place each issue was found', 'Development team'],
  ];
  if (plan.options.reports.audience && plan.project.settings.audience?.personas.length) {
    pack.splice(1, 0, ['audience.docx', 'What the site is for, who it serves, and whether each of them can do what they came to do', 'Leadership, marketing and content']);
  }
  if (plan.options.reports.future && readiness) pack.splice(1, 0, ['future.docx', 'How the site looks in search and when shared, and how ready it is for AI assistants and voice search', 'Marketing, digital and leadership']);
  if (plan.run.mode === 'explore') pack.push(['state-map.png', 'A diagram of every screen reached', 'Project and development teams']);

  let n = 0;
  const section = (title: string) => heading(`${++n}. ${title}`, HeadingLevel.HEADING_1);
  const children: (Paragraph | Table)[] = [
    ...cover(plan, brand, 'Website health overview'),

    section('At a glance'),
    para(
      `${scopeSentence(plan)}. Automated checks found ${plan.tickets.length} distinct ${plural(plan.tickets.length, 'issue')} across ${audited} ${plural(audited, unit)}` +
        (plan.tickets.length ? `, ${serious} of them critical or high severity.` : '.'),
    ),
    ...(scores.length
      ? [
          table(
            ['Area', 'Score', 'Rating', 'Issues', 'What it covers'],
            [
              ...scores.map((c) => [c.name, `${c.score} / 100`, scoreRating(c.score!), issuesText(c), COVERS[c.category]]),
              // Future readiness is already in the scores when its checks ran.
              ...(readiness && !scores.some((c) => c.category === 'FUT')
                ? [['Future readiness', `${readiness.score} / 100`, scoreRating(readiness.score), '–', 'How the site appears in search and when shared, and how ready it is for AI assistants and voice search']]
                : []),
            ],
            { boldFirstColumn: true },
          ),
          para('Scores count each distinct problem once, weighted by severity and how much of the site it affects. They show where to focus, not compliance. Performance is Lighthouse’s own score.'),
        ]
      : [para('No scored checks were run in this audit.')]),

    ...focusSection(plan, section),

    ...purposeSection(plan, section),

    section('Why a healthy website matters'),
    ...writtenText(text.whyItMatters ?? whyItMatters),

    section('Key findings'),
    ...listItems(text.keyFindings ?? suggested.keyFindings).map((item) => new Paragraph({ bullet: { level: 0 }, children: [new TextRun(item)] })),

    section('Top recommendations'),
    ...listItems(text.recommendations ?? suggested.recommendations).map(
      (item, i) => new Paragraph({ spacing: { after: 80 }, indent: { left: 360, hanging: 360 }, children: [new TextRun({ text: `${i + 1}.\t`, bold: true }), new TextRun(item)] }),
    ),

    section('What’s in this pack'),
    table(['File', 'What it is', 'For'], pack, { boldFirstColumn: true }),

    section('About these results'),
    ...[
      'Automated checks find only some problems. Many need human judgement, so these results should be read alongside manual testing, not instead of it.',
      'This overview reports what the checks found. It does not show that the site meets any standard, such as WCAG.',
      'report.docx lists what wasn’t covered and the manual tests we recommend.',
    ].map((item) => new Paragraph({ bullet: { level: 0 }, children: [new TextRun(item)] })),
  ];
  return Packer.toBuffer(brandedDocument(brand, `${plan.project.name}: Website health overview`, `${plan.project.name} overview`, children));
}

/** Where to start, and why: themes ranked by severity, traffic and what they get in the way of, and the connections between the reports. */
function focusSection(plan: ExportPlan, section: (title: string) => Paragraph): (Paragraph | Table)[] {
  if (!hasCrossData(plan)) return [];
  const links = connections(plan);
  const focus = focusThemes(plan);
  if (!links.length && !focus.length) return [];
  const out: (Paragraph | Table)[] = [
    section('Where to focus'),
    para('What the findings mean together: the problems that matter most for this site, weighed by how serious they are, how many visitors they reach, and what they stop people doing.'),
  ];
  for (const link of links) out.push(new Paragraph({ bullet: { level: 0 }, children: [new TextRun(link)] }));
  if (focus.length) {
    out.push(
      heading('Fix these first', HeadingLevel.HEADING_2),
      table(
        ['', 'Problem', 'Why it matters here', 'What to do'],
        focus.map((f, i) => [String(i + 1), f.name, f.why, f.recommendation]),
        { fontSize: 18 },
      ),
    );
  }
  return out;
}

/** What the site is for and who it serves, when the project has purposes. Gaps are what the client wants but the site doesn't do yet. */
export function purposeSection(plan: ExportPlan, section: (title: string) => Paragraph, withPersonas = true): (Paragraph | Table)[] {
  const audience = plan.project.settings.audience;
  if (!audience?.purposes.length) return [];
  const yes = (b: boolean) => (b ? 'Yes' : 'No');
  // With task results and findings, each purpose shows how its tasks went and the issues in their way.
  const results = taskResults(plan);
  const tested = (purposeId: string) => {
    const ids = audience.tasks.filter((t) => (t.purposeId ? t.purposeId === purposeId : audience.personas.find((p) => p.id === t.personaId)?.purposeIds.includes(purposeId))).map((t) => t.id);
    const checked = (results?.tree ?? []).filter((r) => ids.includes(r.taskId) && r.outcome !== 'unchecked');
    return checked.length ? `${checked.filter((r) => r.outcome === 'success').length} of ${checked.length}` : '–';
  };
  const issues = (purposeId: string) => String(plan.tickets.filter((t) => t.impact.purposeIds.includes(purposeId)).length);
  const health = audience.tasks.length > 0;
  const gaps = audience.purposes.filter((p) => p.intended && !p.current);
  const out: (Paragraph | Table)[] = [
    section('What the site is for'),
    para('Every website is there to serve a purpose. These are the purposes we found on the site and the ones agreed for it, which the rest of this audit is weighed against.'),
    table(
      ['Purpose', 'Importance', 'Does it now', 'Wanted', ...(health ? ['Tasks done', 'Issues in the way'] : [])],
      [...audience.purposes]
        .sort((a, b) => (a.priority === b.priority ? 0 : a.priority === 'primary' ? -1 : 1))
        .map((p) => [p.title, p.priority === 'primary' ? 'Main' : 'Secondary', yes(p.current), yes(p.intended), ...(health ? [tested(p.id), issues(p.id)] : [])]),
      { boldFirstColumn: true },
    ),
  ];
  if (gaps.length) {
    out.push(
      new Paragraph({
        spacing: { before: 120, after: 120 },
        children: [new TextRun({ text: 'Gaps: ', bold: true }), new TextRun(`the site doesn’t yet ${gaps.map((g) => lowerFirst(g.title)).join('; ')}.`)],
      }),
    );
  }
  if (withPersonas && audience.personas.length) {
    out.push(heading('Who it’s for', HeadingLevel.HEADING_2));
    for (const p of audience.personas) {
      const tasks = audience.tasks.filter((t) => t.personaId === p.id).map((t) => t.goal);
      out.push(
        new Paragraph({
          bullet: { level: 0 },
          children: [new TextRun({ text: `${p.name}${p.internal ? ' (internal)' : ''}: `, bold: true }), new TextRun([p.summary, tasks.length ? `Comes to ${tasks.map(lowerFirst).join('; ')}.` : ''].filter(Boolean).join(' '))],
        }),
      );
    }
  }
  return out;
}

const lowerFirst = (text: string) => text.charAt(0).toLowerCase() + text.slice(1);

export async function writeOverviewDocx(plan: ExportPlan, path: string, whyItMatters: string, branding: ReportBranding = {}) {
  writeFileSync(path, await overviewDocx(plan, whyItMatters, branding));
}
