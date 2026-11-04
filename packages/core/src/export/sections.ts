import { HeadingLevel, ImageRun, Paragraph, type Table } from 'docx';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { ExportPlan, OutlineEntry } from './plan.js';
import type { Location } from '../types.js';

// The report's optional sections: Analytics, Content and tone, Information architecture and
// Competitor analysis. Each shows figures Prego gathered, then the auditor's own notes.

type Block = Paragraph | Table;

export interface SectionContext {
  plan: ExportPlan;
  runDir: string;
  charts: Partial<Record<'analytics' | 'competitors', Buffer>>;
  helpers: {
    heading: (text: string, level: (typeof HeadingLevel)[keyof typeof HeadingLevel]) => Paragraph;
    para: (text: string) => Paragraph;
    table: (header: string[], rows: string[][], options?: { headerRow?: boolean; boldFirstColumn?: boolean; fontSize?: number }) => Table;
    pngImage: (data: Buffer, maxWidth: number, maxHeight: number, description: string) => ImageRun | null;
    writtenText: (text: string) => Paragraph[];
    plural: (n: number, word: string) => string;
  };
}

/** Readability figures for one page, recorded while it was audited. */
export interface ContentMetrics {
  words: number;
  sentences: number;
  /** Flesch reading ease: higher is easier. 60–70 is plain English. */
  readingEase: number;
  averageSentenceWords: number;
  /** Sentences of more than 25 words. */
  longSentences: number;
  /** How often the copy talks to the reader ("you") and about the organisation ("we"), per 100 words. */
  youPer100: number;
  wePer100: number;
}

/** The site's main navigation, recorded on the start page. */
export interface NavigationMetrics {
  items: { label: string; href: string | null; children: number }[];
}

/** One site in the competitor comparison, recorded at the end of the audit. */
export interface CompetitorResult {
  url: string;
  /** The audited site itself, compared alongside its competitors. */
  own: boolean;
  title: string | null;
  desktop: CompetitorScores | null;
  mobile: CompetitorScores | null;
  /** Home page screenshot (JPEG), relative to the run folder. */
  screenshot: string | null;
  error?: string;
}

export interface CompetitorScores {
  performance: number | null;
  accessibility: number | null;
  bestPractices: number | null;
  seo: number | null;
}

const notes = (ctx: SectionContext, key: 'analytics' | 'content' | 'ia' | 'competitors'): Block[] => {
  const text = ctx.plan.options.text[key];
  return text ? [ctx.helpers.heading('Observations', HeadingLevel.HEADING_2), ...ctx.helpers.writtenText(text)] : [];
};

const chart = (ctx: SectionContext, image: Buffer | undefined, description: string): Block[] => {
  const picture = image && ctx.helpers.pngImage(image, 600, 380, description);
  return picture ? [new Paragraph({ spacing: { before: 120, after: 200 }, children: [picture] })] : [];
};

const show = (n: number | null | undefined) => (n === null || n === undefined ? '–' : String(n));

// Analytics

export function analyticsSection(ctx: SectionContext, entry: OutlineEntry): Block[] {
  const { heading, para, table } = ctx.helpers;
  const a = ctx.plan.project.settings.analytics!;
  const out: Block[] = [
    heading(`${entry.number}. ${entry.title}`, HeadingLevel.HEADING_1),
    para(`Figures from Google Analytics${a.period ? ` for ${a.period}` : ''}, imported from ${a.files.join(', ')}. They show how people reach and use the site, to set the findings in context.`),
  ];
  if (a.engagementSeconds !== null) out.push(para(`Average engagement time per active user: ${duration(a.engagementSeconds)}.`));
  out.push(...chart(ctx, ctx.charts.analytics, 'Users by traffic source'));
  for (const t of a.tables) {
    const total = t.rows.reduce((sum, r) => sum + r.value, 0) || 1;
    out.push(
      heading(t.title, HeadingLevel.HEADING_2),
      table(
        [t.id === 'pages' ? 'Page' : t.id === 'devices' ? 'Device' : t.id === 'countries' ? 'Country' : 'Source', t.measure, 'Share'],
        t.rows.slice(0, 10).map((r) => [r.label, r.value.toLocaleString('en-GB'), `${Math.round((r.value / total) * 100)}%`]),
        { fontSize: 18 },
      ),
    );
  }
  return [...out, ...notes(ctx, 'analytics')];
}

function duration(seconds: number): string {
  const m = Math.floor(seconds / 60);
  const s = Math.round(seconds % 60);
  return m ? `${m} min ${s} s` : `${s} seconds`;
}

// Content and tone

export function contentSection(ctx: SectionContext, entry: OutlineEntry): Block[] {
  const { heading, para, table, plural } = ctx.helpers;
  const pages = ctx.plan.locations
    .map((l) => ({ l, m: l.metrics.content as ContentMetrics | undefined }))
    .filter((p): p is { l: Location; m: ContentMetrics } => !!p.m && p.m.words >= 20);
  const out: Block[] = [heading(`${entry.number}. ${entry.title}`, HeadingLevel.HEADING_1)];
  if (!pages.length) return [...out, para('There wasn’t enough text on the audited pages to measure.'), ...notes(ctx, 'content')];

  const avg = (f: (m: ContentMetrics) => number) => Math.round(pages.reduce((sum, p) => sum + f(p.m), 0) / pages.length);
  const ease = avg((m) => m.readingEase);
  const hard = pages.filter((p) => p.m.readingEase < 50).length;
  const you = pages.reduce((s, p) => s + p.m.youPer100, 0) / pages.length;
  const we = pages.reduce((s, p) => s + p.m.wePer100, 0) / pages.length;
  out.push(
    para(
      `Prego measured the copy on ${pages.length} audited ${plural(pages.length, 'page')}. Reading ease is the Flesch score: 60 to 70 is plain English that most adults read easily, and below 50 is hard going for many readers.`,
    ),
    table(
      ['', ''],
      [
        ['Average reading ease', `${ease} (${easeBand(ease)})`],
        ['Pages that are hard to read (below 50)', `${hard} of ${pages.length}`],
        ['Average sentence length', `${avg((m) => m.averageSentenceWords)} words (aim for 15 to 20)`],
        ['Sentences over 25 words', String(pages.reduce((s, p) => s + p.m.longSentences, 0))],
        ['Talks to the reader (“you”)', `${you.toFixed(1)} times per 100 words`],
        ['Talks about itself (“we”)', `${we.toFixed(1)} times per 100 words`],
      ],
      { headerRow: false },
    ),
    para(toneSentence(you, we)),
    heading('Hardest pages to read', HeadingLevel.HEADING_2),
    table(
      ['Page', 'Words', 'Reading ease', 'Average sentence'],
      [...pages]
        .sort((a, b) => a.m.readingEase - b.m.readingEase)
        .slice(0, 10)
        .map(({ l, m }) => [pathOf(l), String(m.words), `${Math.round(m.readingEase)} (${easeBand(m.readingEase)})`, `${Math.round(m.averageSentenceWords)} words`]),
      { fontSize: 18 },
    ),
  );
  return [...out, ...notes(ctx, 'content')];
}

function easeBand(score: number): string {
  return score >= 70 ? 'easy' : score >= 60 ? 'plain English' : score >= 50 ? 'fairly hard' : score >= 30 ? 'hard' : 'very hard';
}

function toneSentence(you: number, we: number): string {
  if (you >= 1.5 && you >= we) return 'The copy speaks to the reader directly, which usually reads as warm and helpful.';
  if (we > you * 2 && we >= 1) return 'The copy talks about the organisation more than to the reader, which can feel formal or inward-looking.';
  return 'The copy rarely addresses the reader directly, which tends to read as neutral and formal.';
}

// Information architecture

export function iaSection(ctx: SectionContext, entry: OutlineEntry): Block[] {
  const { heading, para, table, plural } = ctx.helpers;
  const pages = ctx.plan.locations.filter((l) => l.kind === 'page' && l.statusCode !== null && l.statusCode < 400);
  const segments = pages.map((l) => new URL(l.url).pathname.split('/').filter(Boolean));
  const depthOf = (parts: string[]) => parts.length;
  const topLevel = segments.filter((p) => depthOf(p) <= 1).length;
  const maxDepth = Math.max(0, ...segments.map(depthOf));
  const sections = new Map<string, number>();
  for (const parts of segments) if (parts[0]) sections.set(parts[0], (sections.get(parts[0]) ?? 0) + 1);

  const out: Block[] = [
    heading(`${entry.number}. ${entry.title}`, HeadingLevel.HEADING_1),
    para('How the site’s pages are organised, from the addresses Prego found while crawling and the main navigation on the home page.'),
    table(
      ['', ''],
      [
        ['Pages found', String(pages.length)],
        ['Pages directly under the home page', `${topLevel} (${Math.round((topLevel / Math.max(1, pages.length)) * 100)}%)`],
        ['Deepest address', `${maxDepth} ${plural(maxDepth, 'level')}`],
        ['Top-level sections', String(sections.size)],
      ],
      { headerRow: false },
    ),
  ];
  if (pages.length >= 10 && topLevel / pages.length > 0.6) {
    out.push(para('Most pages sit directly under the home page, so the structure is flat. A flat structure gives the navigation little hierarchy to show, and makes it harder to add sections as the site grows.'));
  }
  const nav = pages.find((l) => l.metrics.navigation)?.metrics.navigation as NavigationMetrics | undefined;
  if (nav?.items.length) {
    out.push(
      heading('Main navigation', HeadingLevel.HEADING_2),
      table(
        ['Menu item', 'Goes to', 'Sub-items'],
        nav.items.map((i) => [i.label, i.href ? new URL(i.href, ctx.plan.run.target.startsWith('http') ? ctx.plan.run.target : 'http://x/').pathname : '–', i.children ? String(i.children) : '–']),
        { fontSize: 18 },
      ),
    );
  }
  if (sections.size) {
    out.push(
      heading('Pages in each section', HeadingLevel.HEADING_2),
      table(
        ['Section', 'Pages'],
        [...sections].sort((a, b) => b[1] - a[1]).slice(0, 20).map(([name, n]) => [`/${name}/`, String(n)]),
        { fontSize: 18 },
      ),
    );
  }
  return [...out, ...notes(ctx, 'ia')];
}

function pathOf(l: Location): string {
  return l.kind === 'state' ? (l.title ?? l.url) : new URL(l.url).pathname;
}

// Competitor analysis

export function competitorSection(ctx: SectionContext, entry: OutlineEntry): Block[] {
  const { heading, para, table } = ctx.helpers;
  const results = (ctx.plan.run.summary.competitors as CompetitorResult[] | undefined) ?? [];
  const name = (r: CompetitorResult) => `${r.title ?? new URL(r.url).hostname}${r.own ? ' (this site)' : ''}`;
  const out: Block[] = [
    heading(`${entry.number}. ${entry.title}`, HeadingLevel.HEADING_1),
    para(
      'Each site’s home page, scored by Lighthouse on this computer at desktop and mobile settings. Scores are out of 100 and vary a little between runs. Only public home pages were loaded, the same way any visitor would see them.',
    ),
    ...chart(ctx, ctx.charts.competitors, 'Performance scores by site, desktop and mobile'),
    table(
      ['Site', 'Performance (desktop / mobile)', 'Accessibility', 'Best practices', 'SEO'],
      results.map((r) =>
        r.error
          ? [name(r), `Couldn’t be scored: ${r.error}`, '–', '–', '–']
          : [name(r), `${show(r.desktop?.performance)} / ${show(r.mobile?.performance)}`, show(r.desktop?.accessibility), show(r.desktop?.bestPractices), show(r.desktop?.seo)],
      ),
      { fontSize: 18 },
    ),
  ];
  for (const r of results.filter((r) => r.screenshot)) {
    const path = join(ctx.runDir, r.screenshot!);
    if (!existsSync(path)) continue;
    const image = jpegImage(readFileSync(path), 420, 300, `${name(r)} home page`);
    if (!image) continue;
    out.push(heading(name(r), HeadingLevel.HEADING_3), new Paragraph({ spacing: { after: 160 }, children: [image] }));
  }
  return [...out, ...notes(ctx, 'competitors')];
}

/** JPEG ImageRun scaled to fit, reading the size from the file, or null if it isn't a JPEG. */
function jpegImage(data: Buffer, maxWidth: number, maxHeight: number, description: string): ImageRun | null {
  if (data[0] !== 0xff || data[1] !== 0xd8) return null;
  let i = 2;
  while (i < data.length) {
    if (data[i] !== 0xff) return null;
    const marker = data[i + 1];
    const length = data.readUInt16BE(i + 2);
    // Start-of-frame markers hold the image size.
    if (marker >= 0xc0 && marker <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(marker)) {
      const height = data.readUInt16BE(i + 5);
      const width = data.readUInt16BE(i + 7);
      const scale = Math.min(1, maxWidth / width, maxHeight / height);
      return new ImageRun({ type: 'jpg', data, transformation: { width: Math.round(width * scale), height: Math.round(height * scale) }, altText: { name: description, title: description, description } });
    }
    i += 2 + length;
  }
  return null;
}

/** How a page's copy reads: length, reading ease and who it addresses. Used by the structure check. */
export function measureCopy(text: string): ContentMetrics {
  const sentences = text
    .replace(/\s+/g, ' ')
    .split(/(?<=[.!?])\s+(?=[A-Z0-9“"‘'])/)
    .map((s) => s.trim())
    .filter((s) => /\p{L}/u.test(s));
  const wordsIn = (s: string) => s.match(/\p{L}[\p{L}'’-]*/gu) ?? [];
  const words = sentences.flatMap(wordsIn);
  const syllables = words.reduce((sum, w) => sum + syllableCount(w), 0);
  const n = Math.max(1, words.length);
  const per100 = (pattern: RegExp) => Math.round((words.filter((w) => pattern.test(w)).length / n) * 1000) / 10;
  const averageSentenceWords = words.length / Math.max(1, sentences.length);
  return {
    words: words.length,
    sentences: sentences.length,
    readingEase: Math.round((206.835 - 1.015 * averageSentenceWords - 84.6 * (syllables / n)) * 10) / 10,
    averageSentenceWords: Math.round(averageSentenceWords * 10) / 10,
    longSentences: sentences.filter((s) => wordsIn(s).length > 25).length,
    youPer100: per100(/^(you|your|yours|yourself)$/i),
    wePer100: per100(/^(we|our|ours|us)$/i),
  };
}

/** An estimate of a word's syllables from its vowel groups, good enough for reading-ease scores. */
function syllableCount(word: string): number {
  const w = word.toLowerCase().replace(/[^a-z]/g, '');
  if (w.length <= 3) return 1;
  const trimmed = w.replace(/(?:[^laeiouy]es|ed|[^laeiouy]e)$/, '').replace(/^y/, '');
  return Math.max(1, trimmed.match(/[aeiouy]{1,2}/g)?.length ?? 1);
}
