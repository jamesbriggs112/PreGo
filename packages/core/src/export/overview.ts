import { HeadingLevel, Packer, Paragraph, Table, TextRun } from 'docx';
import { writeFileSync } from 'node:fs';
import { brandedDocument, cover, glanceWords, heading, para, resolveBranding, table, writtenText, type ReportBranding } from './docx.js';
import { actionPlanSection, glanceData, glanceSection } from './glance.js';
import type { ExportPlan } from './plan.js';
import { assessReadiness } from './readiness.js';
import { taskResults } from './audience-report.js';

/** A plain-English reading of a score. */
export function scoreRating(score: number): string {
  if (score >= 90) return 'In good shape';
  if (score >= 70) return 'A few things to fix';
  if (score >= 50) return 'Needs attention';
  return 'Needs significant work';
}

/**
 * The Overview: two pages for client leadership, read first. The verdict, a status per area and the
 * three things to fix first; the quick wins; why it matters (the audit's own wording, or the standard
 * wording from Settings); and a guide to the rest of the pack.
 */
export async function overviewDocx(plan: ExportPlan, whyItMatters: string, branding: ReportBranding = {}): Promise<Buffer> {
  const brand = resolveBranding(branding);
  const { text } = plan.options;
  const readiness = assessReadiness(plan.locations);
  const pack: string[][] = [
    ['overview.docx', 'This summary', 'Leadership and anyone new to the audit'],
    ...(plan.options.clientFacing ? [['client-report.docx', 'The action plan and a card for each fix, grouped by where the fix happens', 'Client team and project leads']] : []),
    ['report.docx', 'Every issue found, with ticket IDs, examples, why each matters and what to do', 'Project and development teams'],
    ['tickets.csv', 'One row per issue, ready to import into a ticketing tool. Ticket IDs match report.docx', 'Development team'],
    ['occurrences.csv', 'Every place each issue was found', 'Development team'],
    ['qa-checklist.csv', 'The ten most serious issues, to check by hand before the report goes out', 'Whoever reviews the audit'],
  ];
  if (plan.options.reports.audience && plan.project.settings.audience?.personas.length) {
    pack.splice(1, 0, ['audience.docx', 'What the site is for, who it serves, and whether each of them can do what they came to do', 'Leadership, marketing and content']);
  }
  if (plan.options.reports.future && readiness) pack.splice(1, 0, ['future.docx', 'How the site looks in search and when shared, and how ready it is for AI assistants and voice search', 'Marketing, digital and leadership']);
  if (plan.run.mode === 'explore') pack.push(['state-map.png', 'A diagram of every screen reached', 'Project and development teams']);

  // Two pages at most: the verdict and status per area, the quick wins, and what's in the pack.
  const data = glanceData(plan);
  let n = 0;
  const section = (title: string) => heading(`${++n}. ${title}`, HeadingLevel.HEADING_1);
  const children: (Paragraph | Table)[] = [
    ...cover(plan, brand, 'Website health overview'),
    ...glanceSection(plan, data, section('At a glance')),
    ...glanceWords(plan),
    ...(data.rows.some((r) => r.group === 'Quick wins') ? actionPlanSection(data, section('Quick wins'), { groups: ['Quick wins'], maxRows: 8 }) : []),
    // Why it matters: the audit's own wording, or the standard wording from Settings.
    section('Why a healthy website matters'),
    ...writtenText(text.whyItMatters ?? whyItMatters),
    section('What’s in this pack'),
    table(['File', 'What it is', 'For'], pack, { boldFirstColumn: true, fontSize: 18 }),
    para('Automated checks find only some problems, so read these results alongside manual testing. They report what the checks found, not whether the site meets a standard such as WCAG.'),
  ];
  return Packer.toBuffer(brandedDocument(brand, `${plan.project.name}: Website health overview`, `${plan.project.name} overview`, children));
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
