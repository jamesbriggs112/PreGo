import { HeadingLevel, Packer, Paragraph, Table, TextRun } from 'docx';
import { writeFileSync } from 'node:fs';
import { AI_CRAWLERS } from '../checks/future/future.js';
import { SHARE_IMAGE } from '../checks/sharing/sharing.js';
import { scoreRating } from './overview.js';
import { brandedDocument, cover, heading, para, plural, pngImage, resolveBranding, table, themesOf, writtenText, type ReportBranding } from './docx.js';
import type { ExportPlan } from './plan.js';
import { previewPngs, type PreviewPage } from './previews.js';
import { assessReadiness, STATUS_LABELS, type Readiness } from './readiness.js';

/** Rules whose tickets belong in this report's recommendations. */
const RULES = new Set([
  'content-needs-javascript',
  'structured-data-invalid',
  'structured-data-missing',
  'organisation-data-missing',
  'sitemap-no-dates',
  'share-image-broken',
  'share-image-small',
  'share-image-relative',
  'canonical-missing',
  'twitter-card-missing',
  'touch-icon-missing',
  'open-graph-missing',
  'meta-description-missing',
  'meta-description-length',
  'title-length',
]);

const MAX_PREVIEWS = 3;

/** The home page first, then pages with a different share image or title. */
export function previewPages(readiness: Readiness): PreviewPage[] {
  const withSharing = readiness.pages.filter((p) => p.sharing && p.location.kind === 'page').sort((a, b) => a.location.depth - b.location.depth || a.location.id - b.location.id);
  const chosen: PreviewPage[] = [];
  for (const p of withSharing) {
    if (chosen.length >= MAX_PREVIEWS) break;
    const s = p.sharing!;
    if (chosen.some((c) => (c.sharing.image?.url ?? '') === (s.image?.url ?? '') && c.sharing.title === s.title)) continue;
    chosen.push({ url: p.location.url, sharing: s });
  }
  return chosen;
}

/** Whether the export can include this report: the Search and sharing or Future readiness check ran. */
export function hasReadiness(plan: Pick<ExportPlan, 'locations'>): boolean {
  return assessReadiness(plan.locations) !== null;
}

/**
 * Search, sharing and future readiness: how the site appears in search and when shared, and how ready
 * it is for AI assistants, answer engines and voice search. Written for the client, so no ticket IDs.
 */
export async function futureDocx(plan: ExportPlan, runDir: string, branding: ReportBranding = {}): Promise<Buffer> {
  const brand = resolveBranding(branding);
  const readiness = assessReadiness(plan.locations);
  let n = 0;
  const section = (title: string) => heading(`${++n}. ${title}`, HeadingLevel.HEADING_1);
  const children: (Paragraph | Table)[] = [...cover(plan, brand, 'Search, sharing and future readiness')];

  if (!readiness) {
    children.push(para('The Search and sharing and Future readiness checks weren’t part of this audit, so there’s nothing to report. Run the audit again with them ticked.'));
    return Packer.toBuffer(brandedDocument(brand, `${plan.project.name}: Search, sharing and future readiness`, `${plan.project.name} future readiness`, children));
  }

  // 1. At a glance
  children.push(
    section('At a glance'),
    para(
      'People increasingly find and judge organisations through search results, shared links and AI assistants that answer questions for them. This report looks at how the site comes across in each, and how ready it is for what’s next.',
    ),
    new Paragraph({ spacing: { after: 160 }, children: [new TextRun({ text: `Future readiness: ${readiness.score} / 100`, bold: true, size: 28 }), new TextRun({ text: `  ${scoreRating(readiness.score)}`, size: 24 })] }),
    table(
      ['Area', 'Status', 'What we found'],
      readiness.items.map((i) => [i.area, STATUS_LABELS[i.status], i.found]),
      { boldFirstColumn: true },
    ),
    para('The score counts each area as good, partly or needing work. It shows where to focus, not a measure against any standard.'),
  );

  // 2. Search and sharing
  const pages = previewPages(readiness);
  if (pages.length) {
    children.push(
      section('How the site looks in search and when shared'),
      para(
        'When someone searches, or shares a link on LinkedIn, Facebook, X, WhatsApp or Slack, the platform builds a preview from the page’s title, description and share image. These are drawn from each page’s own tags in the style of each platform; the platforms themselves may crop or shorten them a little differently.',
      ),
    );
    const images = await previewPngs(pages, runDir);
    pages.forEach((page, i) => {
      children.push(heading(new URL(page.url).pathname === '/' ? 'Home page' : new URL(page.url).pathname, HeadingLevel.HEADING_2));
      const picture = pngImage(images[i], 600, 520, `Previews of ${page.url} in a search result, a social post and a message`);
      if (picture) children.push(new Paragraph({ spacing: { after: 120 }, children: [picture] }));
      const img = page.sharing.image;
      const notes = [
        !page.sharing.description && 'There’s no meta description, so search engines choose text from the page.',
        !img && 'There’s no share image, so shared links show no picture.',
        img && !img.ok && 'The share image doesn’t load.',
        img?.ok && img.width && (img.width < SHARE_IMAGE.minimum.width || (img.height ?? 0) < SHARE_IMAGE.minimum.height) && `The share image is ${img.width} × ${img.height} pixels, so most platforms show it small.`,
        page.sharing.og.title && !page.sharing.twitter.card && 'X shows it as a small card, because there’s no twitter:card tag.',
      ].filter((x): x is string => typeof x === 'string');
      for (const note of notes) children.push(new Paragraph({ bullet: { level: 0 }, children: [new TextRun(note)] }));
    });
    const rows = readiness.pages
      .filter((p) => p.sharing)
      .map(({ location, sharing: s }) => {
        const img = s!.image;
        return [
          location.kind === 'page' ? new URL(location.url).pathname : (location.title ?? location.url),
          `${s!.title.length} characters`,
          s!.description ? `${s!.description.length} characters` : 'None',
          !img ? 'None' : !img.ok ? 'Doesn’t load' : img.width ? `${img.width} × ${img.height}` : 'Loads',
          s!.twitter.card ?? 'None',
          s!.canonical ? 'Yes' : 'No',
        ];
      });
    children.push(
      heading('Every page', HeadingLevel.HEADING_2),
      para(`Titles show in full up to about 60 characters and descriptions up to about 155. Share images show large from ${SHARE_IMAGE.recommended.width} × ${SHARE_IMAGE.recommended.height} pixels.`),
      table(['Page', 'Title', 'Description', 'Share image', 'X card', 'Canonical'], rows, { fontSize: 16 }),
    );
  }

  // 3. AI assistants
  const futurePages = readiness.pages.filter((p) => p.future);
  children.push(
    section('AI assistants and answer engines'),
    para(
      'Assistants such as ChatGPT, Claude, Gemini, Perplexity and Copilot increasingly answer questions directly, quoting and linking the sites they trust. They can only do that for sites they’re allowed to read, can read without running JavaScript, and can understand.',
    ),
  );
  if (readiness.site?.aiCrawlers) {
    children.push(
      heading('Which AI crawlers may read the site', HeadingLevel.HEADING_2),
      para('From the site’s robots.txt. Blocking crawlers that train AI models while allowing those that fetch pages for answers is a common, deliberate choice.'),
      table(
        ['Crawler', 'Company', 'Used for', 'Allowed'],
        readiness.site.aiCrawlers.map((c) => [c.agent, c.owner, c.purpose, c.allowed ? 'Yes' : 'Blocked']),
        { fontSize: 18 },
      ),
    );
  } else if (readiness.site) {
    children.push(para(`The site has no robots.txt, so all ${AI_CRAWLERS.length} AI crawlers we check for may read it.`));
  }
  if (futurePages.length) {
    const needJs = futurePages.filter((p) => p.future!.textWithoutJs < 0.5);
    children.push(
      heading('Content without JavaScript', HeadingLevel.HEADING_2),
      para(
        needJs.length
          ? `${needJs.length} ${plural(needJs.length, 'page')} only show most of ${needJs.length === 1 ? 'its' : 'their'} text once JavaScript runs, so many AI crawlers see ${needJs.length === 1 ? 'it' : 'them'} as almost empty: ${needJs
              .slice(0, 6)
              .map((p) => new URL(p.location.url).pathname)
              .join(', ')}${needJs.length > 6 ? ' and others' : ''}.`
          : 'Every page’s main text is in the HTML the server sends, so crawlers that don’t run JavaScript can read it.',
      ),
    );
    const types = [...new Set(futurePages.flatMap((p) => p.future!.schemaTypes))];
    children.push(
      heading('Structured data', HeadingLevel.HEADING_2),
      para(
        types.length
          ? `The site describes itself with these schema.org types: ${types.join(', ')}. Structured data tells search engines and assistants exactly what a page is, so they can show and quote it accurately.`
          : 'No page describes itself with schema.org structured data. Adding it (Organization on the home page; Article, Event, Product, FAQPage or BreadcrumbList where they fit) helps search engines and assistants understand the site.',
      ),
    );

    // 4. Voice
    const questions = futurePages.reduce((sum, p) => sum + p.future!.questionHeadings, 0);
    const summaries = futurePages.filter((p) => p.future!.summaryFirst).length;
    children.push(
      section('Voice search and spoken answers'),
      para(
        'Voice assistants read out one short answer. They favour pages that ask and answer questions plainly, open with a concise summary, mark up FAQs, and give the same contact details everywhere.',
      ),
      ...readiness.items.filter((i) => ['answers', 'voice', 'contact'].includes(i.id)).map((i) => new Paragraph({ bullet: { level: 0 }, children: [new TextRun({ text: `${i.area}: `, bold: true }), new TextRun(i.found)] })),
      para(`Across the pages checked there ${questions === 1 ? 'is 1 heading' : `are ${questions} headings`} phrased as a question, and ${summaries} ${plural(summaries, 'page')} open with a short summary paragraph.`),
    );
  }

  // 5. What to do
  const tickets = plan.tickets.filter((t) => RULES.has(t.ruleId));
  const themes = themesOf(tickets);
  children.push(section('What to do'));
  if (themes.length) {
    themes.forEach((theme, i) =>
      children.push(
        new Paragraph({
          spacing: { after: 100 },
          indent: { left: 360, hanging: 360 },
          children: [new TextRun({ text: `${i + 1}.\t`, bold: true }), new TextRun({ text: `${theme.name}. `, bold: true }), new TextRun(theme.tickets[0].recommendation)],
        }),
      ),
    );
  } else {
    children.push(para('The checks raised nothing to fix in these areas. Keep titles, descriptions, share images and structured data up to date as pages are added.'));
  }
  if (plan.options.text.future) children.push(...writtenText(plan.options.text.future));

  // 6. About
  children.push(
    section('About these results'),
    ...[
      'Prego read only what the site publishes for every visitor and crawler: its pages, their HTML as first sent, robots.txt and the sitemap.',
      'It didn’t look for an llms.txt file, because sites don’t usually link to it.',
      'How each AI assistant chooses and ranks sources isn’t public and changes often, so these results show readiness, not where the site will appear.',
      'Previews are drawn from the page’s tags in each platform’s style; the platforms’ own previews may differ a little.',
    ].map((text) => new Paragraph({ bullet: { level: 0 }, children: [new TextRun(text)] })),
  );
  return Packer.toBuffer(brandedDocument(brand, `${plan.project.name}: Search, sharing and future readiness`, `${plan.project.name} future readiness`, children));
}

export async function writeFutureDocx(plan: ExportPlan, runDir: string, path: string, branding: ReportBranding = {}) {
  writeFileSync(path, await futureDocx(plan, runDir, branding));
}
