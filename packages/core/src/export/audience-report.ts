import { HeadingLevel, Packer, Paragraph, Table, TextRun } from 'docx';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { brandedDocument, cover, heading, para, resolveBranding, table, writtenText, type ReportBranding } from './docx.js';
import { purposeSection } from './overview.js';
import { jpegImage } from './sections.js';
import type { ExportPlan } from './plan.js';
import { EASY_CLICKS, treeTest, type TaskOutcome, type TreeResult } from '../tasks/tree.js';
import type { WalkResult } from '../tasks/walkthrough.js';

export const OUTCOME_LABELS: Record<TaskOutcome, string> = { success: 'Done', partial: 'Partly', failed: 'Not done', unchecked: 'Not tested' };

/** Task results for an audit: the navigation test from the crawl, and the AI walkthrough if it ran. */
export function taskResults(plan: Pick<ExportPlan, 'project' | 'run' | 'locations'>): { tree: TreeResult[]; walk: WalkResult[] } | null {
  const profile = plan.project.settings.audience;
  if (!profile?.personas.length) return null;
  return { tree: treeTest(profile, plan.locations), walk: (plan.run.summary.walkthrough as WalkResult[] | undefined) ?? [] };
}

/** Whether the export can include this report: the project has personas. */
export function hasAudience(plan: Pick<ExportPlan, 'project'>): boolean {
  return !!plan.project.settings.audience?.personas.length;
}

/**
 * Audience and tasks: what the site is for, who it serves, and whether each persona can do what they
 * came to do. Written for the client, so no ticket IDs.
 */
export async function audienceDocx(plan: ExportPlan, runDir: string, branding: ReportBranding = {}): Promise<Buffer> {
  const brand = resolveBranding(branding);
  const profile = plan.project.settings.audience;
  const results = taskResults(plan);
  let n = 0;
  const section = (title: string) => heading(`${++n}. ${title}`, HeadingLevel.HEADING_1);
  const children: (Paragraph | Table)[] = [...cover(plan, brand, 'Audience and tasks')];
  if (!profile || !results) {
    children.push(para('This project has no personas yet. Set them up on its Purposes and audience page, then export again.'));
    return Packer.toBuffer(brandedDocument(brand, `${plan.project.name}: Audience and tasks`, `${plan.project.name} audience`, children));
  }
  const tree = new Map(results.tree.map((r) => [r.taskId, r]));
  const walk = new Map(results.walk.map((r) => [r.taskId, r]));
  const walked = results.walk.length > 0;
  const tested = results.tree.filter((r) => r.outcome !== 'unchecked');
  const done = tested.filter((r) => r.outcome === 'success').length;

  // 1. At a glance
  children.push(
    section('At a glance'),
    para(
      `A website is there to serve a purpose, for particular people. We set out who the site is for and what each of them comes to do, then tested whether they can do it.` +
        (tested.length ? ` By the shortest route through the site’s links, ${done} of ${tested.length} tasks can be done within ${EASY_CLICKS} clicks of the home page.` : ''),
    ),
    table(
      ['Person', 'Task', 'Navigation test', ...(walked ? ['AI walkthrough'] : [])],
      profile.tasks.map((t) => {
        const persona = profile.personas.find((p) => p.id === t.personaId)!;
        const tr = tree.get(t.id);
        const w = walk.get(t.id);
        return [
          persona.name,
          t.goal,
          tr ? `${OUTCOME_LABELS[tr.outcome]}${tr.clicks !== null ? ` (${tr.clicks} ${tr.clicks === 1 ? 'click' : 'clicks'})` : ''}` : '–',
          ...(walked ? [w ? `${OUTCOME_LABELS[w.outcome]}${w.steps.length ? ` (${w.steps.length} steps)` : ''}` : 'Not tried'] : []),
        ];
      }),
      { fontSize: 18 },
    ),
  );

  // 2. Purposes, as in the Overview
  children.push(...purposeSection(plan, section, false));

  // 3. Each persona and their tasks
  children.push(section('People and their tasks'));
  for (const persona of profile.personas) {
    const cares = profile.purposes.filter((p) => persona.purposeIds.includes(p.id)).map((p) => p.title);
    children.push(
      heading(`${persona.name}${persona.internal ? ' (internal)' : ''}`, HeadingLevel.HEADING_2),
      ...writtenText(persona.summary),
      ...[
        persona.context && ['Situation', persona.context],
        ['Device', { mobile: 'Phone', desktop: 'Desktop or laptop', tablet: 'Tablet', any: 'Any' }[persona.device]],
        persona.accessNeeds && ['Access needs', persona.accessNeeds],
        cares.length && ['Cares about', cares.join('; ')],
      ]
        .filter((x): x is [string, string] => Array.isArray(x))
        .map(([label, value]) => new Paragraph({ spacing: { after: 60 }, children: [new TextRun({ text: `${label}: `, bold: true }), new TextRun(value)] })),
    );
    for (const task of profile.tasks.filter((t) => t.personaId === persona.id)) {
      const tr = tree.get(task.id);
      const w = walk.get(task.id);
      children.push(
        heading(task.goal, HeadingLevel.HEADING_3),
        ...(task.doneWhen ? [new Paragraph({ spacing: { after: 80 }, children: [new TextRun({ text: 'Done when: ', bold: true }), new TextRun(task.doneWhen)] })] : []),
      );
      if (tr) {
        const route = tr.route.length ? ` Shortest route: Home › ${tr.route.map((r) => r.label).join(' › ')}.` : '';
        children.push(new Paragraph({ spacing: { after: 80 }, children: [new TextRun({ text: `Navigation test: ${OUTCOME_LABELS[tr.outcome]}. `, bold: true }), new TextRun(`${tr.note}${route}`)] }));
      }
      if (w) {
        children.push(new Paragraph({ spacing: { after: 60 }, children: [new TextRun({ text: `AI walkthrough: ${OUTCOME_LABELS[w.outcome]}. `, bold: true }), new TextRun(w.note)] }));
        w.steps.forEach((s, i) =>
          children.push(
            new Paragraph({
              spacing: { after: 40 },
              indent: { left: 360, hanging: 360 },
              children: [new TextRun({ text: `${i + 1}.\t`, bold: true }), new TextRun({ text: `${s.action}`, bold: true }), new TextRun(` on “${s.title}”${s.reason ? `: “${s.reason}”` : ''}`)],
            }),
          ),
        );
        const path = w.screenshot ? join(runDir, w.screenshot) : '';
        const image = path && existsSync(path) ? jpegImage(readFileSync(path), 420, 420, `Where the walkthrough of “${task.goal}” stopped`) : null;
        if (image) children.push(new Paragraph({ spacing: { before: 80, after: 160 }, children: [image] }), new Paragraph({ spacing: { after: 160 }, children: [new TextRun({ text: 'Where it stopped.', italics: true, size: 18 })] }));
      }
    }
  }

  // 4. How this was tested
  children.push(
    section('How this was tested'),
    ...[
      `Navigation test: Prego found the shortest route from the home page to where each task is done, through the links on the pages it audited. Up to ${EASY_CLICKS} clicks counts as done; deeper, or a first link whose label doesn’t match the task, counts as partly. It’s a best case: people don’t always take the shortest route.`,
      walked
        ? 'AI walkthrough: an AI model running on this computer played each person and tried their task, choosing from the links and menus visible on screen at their device’s size. Prego, not the model, checked whether each task was done. It never typed, submitted a form, or visited pages robots.txt rules out.'
        : 'An AI walkthrough, where a model plays each person and tries their tasks, wasn’t part of this audit.',
      'The people here are personas: realistic sketches, not real users. These tests point to likely problems; testing with real people, including disabled people and staff, is the way to confirm them.',
    ].map((text) => new Paragraph({ bullet: { level: 0 }, children: [new TextRun(text)] })),
  );
  if (plan.options.text.audience) children.push(heading('Our observations', HeadingLevel.HEADING_2), ...writtenText(plan.options.text.audience));
  return Packer.toBuffer(brandedDocument(brand, `${plan.project.name}: Audience and tasks`, `${plan.project.name} audience`, children));
}

export async function writeAudienceDocx(plan: ExportPlan, runDir: string, path: string, branding: ReportBranding = {}) {
  writeFileSync(path, await audienceDocx(plan, runDir, branding));
}
