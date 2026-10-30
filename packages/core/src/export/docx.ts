import {
  AlignmentType,
  BorderStyle,
  Document,
  Footer,
  HeadingLevel,
  ImageRun,
  PageBreak,
  PageNumber,
  Packer,
  Paragraph,
  ShadingType,
  Table,
  TableCell,
  TableRow,
  TextRun,
  WidthType,
} from 'docx';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { CATEGORIES, CATEGORY_NAMES, SEVERITIES, type Severity } from '../types.js';
import { checkedCategories } from '../checks/categories.js';
import { averagePerformance, type LighthouseScores } from '../checks/lighthouse/lighthouse.js';
import { stateMapStates, type ExportPlan, type PlannedTicket, type ReportSectionPlan } from './plan.js';

export interface ReportBranding {
  /** Company shown on the cover and in the footer. */
  companyName?: string;
  /** Accent colour for headings and table headers, hex without #. */
  accentColour?: string;
  /** PNG logo for the cover page. */
  logoPath?: string;
}

const DEFAULT_BRANDING: Required<Omit<ReportBranding, 'logoPath'>> = { companyName: 'Four', accentColour: '1F3A5F' };

/** Score penalty per ticket. The score is an indicator for comparing runs, not a compliance measure. */
const SEVERITY_PENALTY: Record<Severity, number> = { Critical: 12, High: 6, Medium: 3, Low: 1 };

/** 100 with no issues, falling with diminishing steps so large sites don't all sit at 0. One critical issue ≈ 81. */
export function categoryScore(severities: Severity[]): number {
  const penalty = severities.reduce((sum, s) => sum + SEVERITY_PENALTY[s], 0);
  return Math.round(100 / (1 + penalty / 50));
}

const MAX_IMAGE_WIDTH = 600;
const MAX_IMAGE_HEIGHT = 420;

export interface ReportExtras {
  /** State map diagram (PNG) for interactive audits. */
  stateMap?: Buffer;
}

export async function reportDocx(plan: ExportPlan, runDir: string, branding: ReportBranding = {}, extras: ReportExtras = {}): Promise<Buffer> {
  const brand = { ...DEFAULT_BRANDING, ...branding };
  const children = [
    ...cover(plan, brand),
    ...executiveSummary(plan),
    ...scopeAndMethod(plan),
    ...findings(plan, runDir),
    ...(plan.run.mode === 'explore' ? stateMapSection(plan, extras.stateMap) : plan.run.mode === 'journey' ? journeySection(plan) : siteMap(plan)),
    ...comparison(plan),
    ...limitations(plan),
    ...appendix(plan),
  ];
  const doc = new Document({
    creator: brand.companyName,
    title: `${plan.project.name}: UX, UI and accessibility audit`,
    description: 'Automated audit report produced by Prego',
    styles: {
      default: { document: { run: { font: 'Arial', size: 22 } } },
      paragraphStyles: [
        { id: 'Heading1', name: 'Heading 1', basedOn: 'Normal', next: 'Normal', run: { size: 36, bold: true, color: brand.accentColour }, paragraph: { spacing: { before: 360, after: 160 } } },
        { id: 'Heading2', name: 'Heading 2', basedOn: 'Normal', next: 'Normal', run: { size: 28, bold: true, color: brand.accentColour }, paragraph: { spacing: { before: 280, after: 120 } } },
        { id: 'Heading3', name: 'Heading 3', basedOn: 'Normal', next: 'Normal', run: { size: 24, bold: true }, paragraph: { spacing: { before: 200, after: 80 } } },
      ],
    },
    sections: [
      {
        properties: { page: { margin: { top: 1134, bottom: 1134, left: 1134, right: 1134 } } },
        footers: {
          default: new Footer({
            children: [
              new Paragraph({
                alignment: AlignmentType.RIGHT,
                children: [new TextRun({ text: `${brand.companyName} · ${plan.project.name} audit · Page `, size: 18 }), new TextRun({ children: [PageNumber.CURRENT], size: 18 })],
              }),
            ],
          }),
        },
        children,
      },
    ],
  });
  return Packer.toBuffer(doc);
}

export async function writeReportDocx(plan: ExportPlan, runDir: string, path: string, branding: ReportBranding = {}, extras: ReportExtras = {}) {
  writeFileSync(path, await reportDocx(plan, runDir, branding, extras));
}

// Sections

function cover(plan: ExportPlan, brand: typeof DEFAULT_BRANDING & ReportBranding): Paragraph[] {
  const out: Paragraph[] = [];
  if (brand.logoPath && existsSync(brand.logoPath)) {
    const image = pngImage(readFileSync(brand.logoPath), 200, 80, `${brand.companyName} logo`);
    if (image) out.push(new Paragraph({ children: [image], spacing: { after: 600 } }));
  }
  out.push(
    new Paragraph({ spacing: { before: 1600, after: 200 }, children: [new TextRun({ text: plan.project.name, size: 56, bold: true, color: brand.accentColour })] }),
    new Paragraph({ spacing: { after: 600 }, children: [new TextRun({ text: 'UX, UI and accessibility audit', size: 36 })] }),
    labelled('Product', productName(plan)),
    labelled('Date', formatDate(plan.run.startedAt)),
    labelled('Audit scope', scopeSentence(plan)),
    labelled('Prepared by', `${brand.companyName}, using Prego automated checks`),
    new Paragraph({ children: [new PageBreak()] }),
  );
  return out;
}

function executiveSummary(plan: ExportPlan): (Paragraph | Table)[] {
  const checked = checkedCategories(plan.run.settings);
  const top = [...plan.tickets].sort((a, b) => a.priority.localeCompare(b.priority) || SEVERITIES.indexOf(a.severity) - SEVERITIES.indexOf(b.severity) || b.locationsAffected - a.locationsAffected).slice(0, 5);
  const out: (Paragraph | Table)[] = [
    heading('2. Executive summary', HeadingLevel.HEADING_1),
    para(
      `Automated checks found ${plan.tickets.length} distinct ${plural(plan.tickets.length, 'issue')} across ${auditedCount(plan)} audited ${plural(auditedCount(plan), plan.run.mode === 'explore' ? 'screen' : plan.run.mode === 'journey' ? 'journey step' : 'page')}. ` +
        'Each issue has a ticket ID (for example PRG-A11Y-001) that matches a row in tickets.csv, so the development team can pick it up directly.',
    ),
    heading('Scores by category', HeadingLevel.HEADING_2),
    para('Scores start at 100 and drop for each issue found, weighted by severity. They are a way to compare audits over time, not a measure of compliance.'),
    table(
      ['Category', 'Score', 'Issues', 'Critical', 'High', 'Medium', 'Low'],
      CATEGORIES.map((category) => {
        const tickets = plan.tickets.filter((t) => t.category === category);
        if (!checked.has(category)) return [CATEGORY_NAMES[category], 'Not checked', '–', '–', '–', '–', '–'];
        // Performance uses Lighthouse's own score when it ran; everything else counts issues.
        const score = (category === 'PERF' ? averagePerformance(plan.locations) : null) ?? categoryScore(tickets.map((t) => t.severity));
        return [CATEGORY_NAMES[category], String(score), String(tickets.length), ...SEVERITIES.map((s) => String(tickets.filter((t) => t.severity === s).length))];
      }),
    ),
    heading('Top issues', HeadingLevel.HEADING_2),
  ];
  if (top.length === 0) out.push(para('Automated checks raised no issues in the areas checked. Manual testing is still needed (see section 7).'));
  for (const t of top) {
    out.push(
      new Paragraph({
        bullet: { level: 0 },
        children: [new TextRun({ text: t.ticketId, bold: true }), new TextRun(`: ${t.title}. ${t.severity} severity, ${t.priority}. See section ${t.reportSection}.`)],
      }),
    );
  }
  const themes = themesOf(plan.tickets).slice(0, 4);
  if (themes.length) {
    out.push(heading('Headline themes', HeadingLevel.HEADING_2));
    for (const theme of themes) {
      out.push(new Paragraph({ bullet: { level: 0 }, children: [new TextRun({ text: theme.name, bold: true }), new TextRun(`: ${theme.tickets[0].whyItMatters}`)] }));
    }
  }
  out.push(new Paragraph({ children: [new PageBreak()] }));
  return out;
}

/** Lighthouse scores per page, when Lighthouse ran. */
function lighthouseTable(plan: ExportPlan): (Paragraph | Table)[] {
  const rows = plan.locations
    .map((l) => ({ l, s: l.metrics.lighthouse as LighthouseScores | undefined }))
    .filter((r): r is { l: (typeof plan.locations)[number]; s: LighthouseScores } => !!r.s);
  if (!rows.length) return [];
  const show = (n: number | null) => (n === null ? '–' : String(n));
  return [
    heading('Lighthouse scores', HeadingLevel.HEADING_2),
    para(`Lighthouse ran on one page per template (${rows[0].s.formFactor} settings). Scores are out of 100 and vary a little between runs.`),
    table(
      ['Page', 'Performance', 'Best practices', 'SEO'],
      rows.map(({ l, s }) => [l.kind === 'state' ? (l.title ?? l.url) : new URL(l.url).pathname, show(s.performance), show(s.bestPractices), show(s.seo)]),
      { fontSize: 18 },
    ),
  ];
}

function scopeAndMethod(plan: ExportPlan): (Paragraph | Table)[] {
  return [...scopeAndMethodTable(plan), ...lighthouseTable(plan)];
}

function scopeAndMethodTable(plan: ExportPlan): (Paragraph | Table)[] {
  const s = plan.run.settings as Record<string, unknown>;
  const pages = plan.locations.filter((l) => l.statusCode !== null && l.statusCode < 400);
  const templates = new Set(pages.map((l) => l.templateKey));
  const notAudited = pages.filter((l) => !l.audited);
  const modules = (s.modules as { name: string }[] | undefined)?.map((m) => m.name) ?? [];
  if (plan.run.mode === 'journey') {
    const summary = plan.run.summary as Record<string, unknown>;
    return [
      heading('3. Scope and method', HeadingLevel.HEADING_1),
      para(scopeSentence(plan) + '.'),
      para('The journey was recorded once by an auditor clicking through it, then replayed by Prego with checks after every step, at each viewport.'),
      table(
        ['', ''],
        [
          ['Journey', String(summary.journey ?? '')],
          ['Exploration mode', 'Scripted journey (recorded, then replayed with checks at every step)'],
          ['Viewports', ((s.viewports as string[]) ?? []).join(', ')],
          ['Steps replayed', `${summary.stepsReplayed} of ${summary.stepsRecorded}${summary.completed ? '' : ' (the journey could not be completed; see the findings)'}`],
          ['Checks run', modules.join('; ') || 'None'],
          ['Tools', 'Prego with Playwright (Chromium) and axe-core. All open source; nothing left this machine.'],
        ],
        { headerRow: false },
      ),
    ];
  }
  if (plan.run.mode === 'explore') {
    const states = plan.locations.filter((l) => l.kind === 'state');
    const skipped = plan.edges.filter((e) => e.outcome === 'skipped' || e.outcome === 'external');
    return [
      heading('3. Scope and method', HeadingLevel.HEADING_1),
      para(scopeSentence(plan) + '.'),
      para(
        'Prego opened the interactive and pressed every control on every screen it found, breadth-first from the start screen, recording where each one led. ' +
          'Timers were frozen so idle resets and attract loops could not interrupt it, form fields received dummy data only, and controls that could cause real effects (such as sending, buying or deleting) were never pressed.',
      ),
      table(
        ['', ''],
        [
          ['Start address', productName(plan)],
          ['Exploration mode', 'Interactive exploration (every control, breadth-first)'],
          ['Viewports', ((s.viewports as string[]) ?? []).join(', ')],
          ['Screens found and audited', String(states.length)],
          ['Deepest screen', `${Math.max(0, ...states.map((l) => l.depth))} taps from the start`],
          ['Actions tried', String(plan.edges.length)],
          ['Not pressed, for safety', skipped.length ? skipped.map((e) => `“${e.step.label}”`).join(', ') : 'None'],
          ['Checks run', modules.join('; ') || 'None'],
          ['Tools', 'Prego with Playwright (Chromium) and axe-core. All open source; nothing left this machine.'],
        ],
        { headerRow: false },
      ),
    ];
  }
  return [
    heading('3. Scope and method', HeadingLevel.HEADING_1),
    para(scopeSentence(plan) + '.'),
    table(
      ['', ''],
      [
        ['Start address', productName(plan)],
        ['Exploration mode', plan.run.mode === 'crawl' ? 'Site crawl (sitemap and links)' : plan.run.mode],
        ['Viewports', ((s.viewports as string[]) ?? []).join(', ')],
        ['Pages found', String(pages.length)],
        ['Page templates', String(templates.size)],
        ['Pages audited', `${auditedCount(plan)}${s.auditAll ? ' (every page)' : ` (up to ${s.perTemplate ?? 3} per template)`}`],
        ['Same template, not audited', String(notAudited.length)],
        ['robots.txt', s.respectRobots === false ? 'Ignored (staging mode)' : 'Respected'],
        ['Checks run', modules.join('; ') || 'None'],
        ['Tools', 'Prego with Playwright (Chromium), Crawlee and axe-core. All open source; nothing left this machine.'],
      ],
      { headerRow: false },
    ),
  ];
}

function findings(plan: ExportPlan, runDir: string): (Paragraph | Table)[] {
  const out: (Paragraph | Table)[] = [heading('4. Findings by category', HeadingLevel.HEADING_1)];
  if (plan.sections.length === 0) out.push(para('Automated checks raised no issues in the areas checked.'));
  for (const section of plan.sections) out.push(...findingsSection(section, runDir));
  return out;
}

function findingsSection(section: ReportSectionPlan, runDir: string): (Paragraph | Table)[] {
  const out: (Paragraph | Table)[] = [
    heading(`${section.number} ${section.title}`, HeadingLevel.HEADING_2),
    para(`${section.tickets.length} ${plural(section.tickets.length, 'issue')} in this category, grouped below by theme. Ticket IDs in bold match tickets.csv.`),
  ];
  for (const theme of themesOf(section.tickets)) {
    const example = theme.tickets.find((t) => t.screenshotFile) ?? theme.tickets[0];
    out.push(
      heading(theme.name, HeadingLevel.HEADING_3),
      para(example.description),
      new Paragraph({ children: [new TextRun({ text: 'Why it matters: ', bold: true }), new TextRun(example.whyItMatters)] }),
      new Paragraph({ children: [new TextRun({ text: 'What to do: ', bold: true }), new TextRun(example.recommendation)] }),
    );
    for (const t of theme.tickets) {
      out.push(
        new Paragraph({
          bullet: { level: 0 },
          children: [
            new TextRun({ text: t.ticketId, bold: true }),
            new TextRun(`: ${where(t)}. ${t.severity} severity, ${t.priority}. ${t.occurrences} ${plural(t.occurrences, 'occurrence')} on ${t.locationsAffected} ${plural(t.locationsAffected, 'page')}.`),
          ],
        }),
      );
    }
    if (example.screenshotFile) {
      const crop = example.occurrenceList.find((o) => o.screenshotFile === example.screenshotFile)?.crop;
      const path = crop ? join(runDir, crop) : '';
      const image = path && existsSync(path) ? pngImage(readFileSync(path), MAX_IMAGE_WIDTH, MAX_IMAGE_HEIGHT, `${theme.name}: example from ${example.exampleLocation}, problem outlined`) : null;
      if (image) out.push(new Paragraph({ spacing: { before: 120 }, children: [image] }));
      out.push(
        new Paragraph({
          spacing: { after: 240 },
          children: [new TextRun({ text: `Example from `, italics: true, size: 18 }), new TextRun({ text: example.ticketId, bold: true, italics: true, size: 18 }), new TextRun({ text: `, problem outlined in pink. Screenshot: ${example.screenshotFile}`, italics: true, size: 18 })],
        }),
      );
    }
  }
  return out;
}

function stateMapSection(plan: ExportPlan, image: Buffer | undefined): (Paragraph | Table)[] {
  const states = stateMapStates(plan);
  const out: (Paragraph | Table)[] = [
    heading('5. State map summary', HeadingLevel.HEADING_1),
    para('Every screen Prego reached, arranged by how many taps it is from the start screen. Screens with a thick red border are dead ends or have a control that does nothing. The full diagram is also in state-map.png.'),
  ];
  const picture = image && pngImage(image, MAX_IMAGE_WIDTH, 600, `State map of ${states.length} screens`);
  if (picture) out.push(new Paragraph({ spacing: { after: 200 }, children: [picture] }));
  out.push(
    table(
      ['Screen', 'Taps from start', 'Issues'],
      [...states].sort((a, b) => a.depth - b.depth || a.id - b.id).map((s) => [s.title, String(s.depth), String(s.issues)]),
      { fontSize: 18 },
    ),
  );
  return out;
}

function journeySection(plan: ExportPlan): (Paragraph | Table)[] {
  const issues = new Map<number, number>();
  for (const t of plan.tickets) for (const id of new Set(t.occurrenceList.map((o) => o.locationId))) issues.set(id, (issues.get(id) ?? 0) + 1);
  return [
    heading('5. Journey steps', HeadingLevel.HEADING_1),
    para('Each step of the recorded journey, the page it ended on and how many issues were found there.'),
    table(
      ['Step', 'Page', 'Issues'],
      plan.locations.map((l) => [l.title ?? '', l.url, String(issues.get(l.id) ?? 0)]),
      { fontSize: 16 },
    ),
  ];
}

function siteMap(plan: ExportPlan): (Paragraph | Table)[] {
  const rows = plan.locations.map((l) => [
    l.url,
    l.title ?? '',
    l.templateKey ?? '–',
    l.audited ? 'Audited' : l.statusCode !== null && l.statusCode >= 400 ? `Broken (HTTP ${l.statusCode})` : 'Same template, not audited',
  ]);
  return [
    heading('5. Site map summary', HeadingLevel.HEADING_1),
    para('Every page Prego found, the template it was grouped into and whether it was audited. Broken links found while crawling are listed too.'),
    table(['Address', 'Page title', 'Template', 'Status'], rows, { fontSize: 16 }),
  ];
}

function comparison(plan: ExportPlan): Paragraph[] {
  const out = [heading('6. Comparison with the previous audit', HeadingLevel.HEADING_1)];
  if (!plan.previousRun) {
    out.push(para('This is the first audit of this project, so there is nothing to compare with yet. Future audits will show which issues are new, fixed or still present.'));
    return out;
  }
  const count = (status: string) => plan.tickets.filter((t) => t.status === status).length;
  out.push(
    para(`Compared with the audit on ${formatDate(plan.previousRun.startedAt)}:`),
    new Paragraph({ bullet: { level: 0 }, children: [new TextRun(`${count('New')} new ${plural(count('New'), 'issue')}`)] }),
    new Paragraph({ bullet: { level: 0 }, children: [new TextRun(`${count('Recurring')} ${plural(count('Recurring'), 'issue')} still present`)] }),
  );
  return out;
}

function limitations(plan: ExportPlan): Paragraph[] {
  const notAudited = plan.locations.filter((l) => !l.audited && (l.statusCode ?? 0) < 400).length;
  const items = [
    'Automated tools find only a portion of accessibility problems. Many WCAG criteria need human judgement, such as whether alt text is meaningful, whether instructions make sense, or whether the reading order is logical.',
    'This report records what automated checks found. It does not show that the product meets WCAG or any other standard, and should support manual testing, not replace it.',
    plan.run.mode === 'explore'
      ? 'Only screens Prego could reach by pressing controls were checked. Screens that need specific input (a correct quiz answer, a search term), gestures such as swiping or pinching, or one of the controls Prego never presses (see section 3) were not explored.'
      : 'Only pages Prego could reach by following links and the sitemap were checked. Pages behind forms, searches or logins that were not configured were not visited.',
    notAudited > 0
      ? `${notAudited} ${plural(notAudited, 'page')} shared a template with pages already audited and were not checked individually. Content-specific problems on those pages may be missed.`
      : '',
    'Content drawn inside <canvas> or WebGL, video and audio content, PDFs and other documents were not checked.',
  ].filter(Boolean);
  const manual = [
    'Keyboard only: tab through every page and interactive element. Check focus is always visible, nothing traps focus, and the order makes sense.',
    'Screen reader: use VoiceOver (Mac or iPhone) and NVDA (Windows) on key journeys, listening for unclear labels, missing announcements and confusing reading order.',
    'Zoom and reflow: zoom to 200% and 400%, and check text spacing overrides. Nothing should overlap, get cut off or need horizontal scrolling.',
    'Content: check alt text, link text and headings describe their purpose, and that error messages explain how to fix the problem.',
    'Media: check videos have captions and transcripts, and that nothing flashes more than three times a second.',
    'Touch and kiosks: check target sizes, gestures with single-tap alternatives, and idle timeouts that give enough warning.',
  ];
  return [
    heading('7. Limitations and manual testing', HeadingLevel.HEADING_1),
    heading('What automated checks cannot cover', HeadingLevel.HEADING_2),
    ...items.map((text) => new Paragraph({ bullet: { level: 0 }, children: [new TextRun(text)] })),
    heading('Recommended manual tests', HeadingLevel.HEADING_2),
    ...manual.map((text) => new Paragraph({ bullet: { level: 0 }, children: [new TextRun(text)] })),
  ];
}

function appendix(plan: ExportPlan): (Paragraph | Table)[] {
  return [
    new Paragraph({ children: [new PageBreak()] }),
    heading('Appendix A: Ticket index', HeadingLevel.HEADING_1),
    para('Every ticket in this report. Full technical detail for each is in tickets.csv, and every individual occurrence is in occurrences.csv.'),
    table(
      ['Ticket ID', 'Title', 'Severity', 'Priority', 'Section'],
      plan.tickets.map((t) => [t.ticketId, t.title, t.severity, t.priority, t.reportSection]),
      { boldFirstColumn: true, fontSize: 18 },
    ),
  ];
}

// Helpers

interface Theme {
  name: string;
  tickets: PlannedTicket[];
}

/** Tickets grouped by rule. The theme name is the ticket title without its location suffix. */
function themesOf(tickets: PlannedTicket[]): Theme[] {
  const themes = new Map<string, Theme>();
  for (const t of tickets) {
    const key = `${t.engine}:${t.ruleId}`;
    const name = t.title.replace(/ \([^)]*\)$/, '');
    if (!themes.has(key)) themes.set(key, { name, tickets: [] });
    themes.get(key)!.tickets.push(t);
  }
  const worst = (theme: Theme) => Math.min(...theme.tickets.map((t) => SEVERITIES.indexOf(t.severity)));
  return [...themes.values()].sort((a, b) => worst(a) - worst(b) || b.tickets.length - a.tickets.length);
}

function where(t: PlannedTicket): string {
  return /\(([^)]*)\)$/.exec(t.title)?.[1] ?? t.exampleLocation ?? '';
}

function auditedCount(plan: ExportPlan): number {
  return plan.locations.filter((l) => l.audited).length;
}

function scopeSentence(plan: ExportPlan): string {
  const s = plan.run.settings as Record<string, unknown>;
  const viewports = `${((s.viewports as string[]) ?? []).join(', ')} ${plural(((s.viewports as string[]) ?? []).length, 'viewport')}`;
  if (plan.run.mode === 'journey') {
    const summary = plan.run.summary as Record<string, unknown>;
    return `Scripted journey “${summary.journey}” on ${productName(plan)}: ${summary.stepsReplayed} of ${summary.stepsRecorded} steps replayed and audited at ${viewports}`;
  }
  if (plan.run.mode === 'explore') {
    const screens = plan.locations.filter((l) => l.kind === 'state').length;
    return `Interactive exploration of ${productName(plan)}: ${screens} ${plural(screens, 'screen')} found and audited at ${viewports}`;
  }
  const found = plan.locations.filter((l) => l.statusCode !== null && l.statusCode < 400).length;
  return `Site crawl of ${productName(plan)}: ${found} ${plural(found, 'page')} found, ${auditedCount(plan)} audited at ${((s.viewports as string[]) ?? []).join(', ')} ${plural(((s.viewports as string[]) ?? []).length, 'viewport')}`;
}

/** The audited URL, or for a local folder the folder itself (its temporary server address means nothing). */
function productName(plan: ExportPlan): string {
  const target = plan.run.target;
  return /^https?:\/\//i.test(target) ? target : `${target} (local folder)`;
}

function heading(text: string, level: (typeof HeadingLevel)[keyof typeof HeadingLevel]) {
  return new Paragraph({ heading: level, children: [new TextRun(text)] });
}

function para(text: string) {
  return new Paragraph({ spacing: { after: 120 }, children: [new TextRun(text)] });
}

function labelled(label: string, value: string) {
  return new Paragraph({ spacing: { after: 80 }, children: [new TextRun({ text: `${label}: `, bold: true }), new TextRun(value)] });
}

function table(header: string[], rows: string[][], options: { headerRow?: boolean; boldFirstColumn?: boolean; fontSize?: number } = {}) {
  const size = options.fontSize ?? 20;
  const border = { style: BorderStyle.SINGLE, size: 4, color: 'BFBFBF' };
  const cell = (text: string, bold = false, shaded = false) =>
    new TableCell({
      borders: { top: border, bottom: border, left: border, right: border },
      shading: shaded ? { type: ShadingType.CLEAR, color: 'auto', fill: 'E8EDF3' } : undefined,
      margins: { top: 60, bottom: 60, left: 100, right: 100 },
      children: [new Paragraph({ children: [new TextRun({ text, bold, size })] })],
    });
  const tableRows = [
    ...(options.headerRow === false ? [] : [new TableRow({ tableHeader: true, children: header.map((h) => cell(h, true, true)) })]),
    ...rows.map((row) => new TableRow({ children: row.map((text, i) => cell(text, (options.boldFirstColumn || options.headerRow === false) && i === 0)) })),
  ];
  return new Table({ width: { size: 100, type: WidthType.PERCENTAGE }, rows: tableRows });
}

/** PNG ImageRun scaled to fit, or null if the data isn't a PNG. */
function pngImage(data: Buffer, maxWidth: number, maxHeight: number, description: string): ImageRun | null {
  if (data.length < 24 || data.toString('ascii', 1, 4) !== 'PNG') return null;
  const width = data.readUInt32BE(16);
  const height = data.readUInt32BE(20);
  const scale = Math.min(1, maxWidth / width, maxHeight / height);
  return new ImageRun({
    type: 'png',
    data,
    transformation: { width: Math.round(width * scale), height: Math.round(height * scale) },
    altText: { name: description, title: description, description },
  });
}

function formatDate(iso: string): string {
  return new Date(iso).toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric' });
}

function plural(n: number, word: string): string {
  return n === 1 ? word : `${word}s`;
}
