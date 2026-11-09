import { RobotsTxtFile } from '@crawlee/utils';
import type { Category, Severity } from '../../types.js';
import type { CheckFinding, CheckModule } from '../types.js';
import { guidanceFor } from '../guidance.js';

// Future readiness: how well the site serves AI assistants, answer engines and voice search as well
// as people. It reads only what the site already publishes (the page, its own HTML as first sent,
// robots.txt and the sitemap) and asks nothing of the site that an ordinary crawler wouldn't.

const RULES: Record<string, { severity: Severity; category: Category; siteWide: boolean }> = {
  'content-needs-javascript': { severity: 'Medium', category: 'TECH', siteWide: false },
  'structured-data-invalid': { severity: 'Medium', category: 'TECH', siteWide: false },
  'structured-data-missing': { severity: 'Low', category: 'CONT', siteWide: true },
  'organisation-data-missing': { severity: 'Low', category: 'CONT', siteWide: true },
  'sitemap-no-dates': { severity: 'Low', category: 'TECH', siteWide: true },
};

/** AI crawlers and the companies behind them. Blocking them is a choice, so the report shows it rather than raising tickets. */
export const AI_CRAWLERS: { agent: string; owner: string; purpose: string }[] = [
  { agent: 'GPTBot', owner: 'OpenAI', purpose: 'Training' },
  { agent: 'OAI-SearchBot', owner: 'OpenAI', purpose: 'ChatGPT search' },
  { agent: 'ChatGPT-User', owner: 'OpenAI', purpose: 'Fetching pages a user asks about' },
  { agent: 'ClaudeBot', owner: 'Anthropic', purpose: 'Training' },
  { agent: 'Claude-SearchBot', owner: 'Anthropic', purpose: 'Claude search' },
  { agent: 'Claude-User', owner: 'Anthropic', purpose: 'Fetching pages a user asks about' },
  { agent: 'PerplexityBot', owner: 'Perplexity', purpose: 'Search answers' },
  { agent: 'Google-Extended', owner: 'Google', purpose: 'Gemini training and grounding' },
  { agent: 'Applebot-Extended', owner: 'Apple', purpose: 'Apple Intelligence training' },
  { agent: 'Meta-ExternalAgent', owner: 'Meta', purpose: 'Training' },
  { agent: 'Amazonbot', owner: 'Amazon', purpose: 'Alexa answers' },
  { agent: 'CCBot', owner: 'Common Crawl', purpose: 'Open dataset used for training' },
];

/** What the future readiness check records on each page, for the report. */
export interface FutureMetrics {
  /** Share of the page's visible text that's in the HTML before any JavaScript runs, 0 to 1. */
  textWithoutJs: number;
  /** Share of the page's links that are in the HTML before any JavaScript runs, 0 to 1. */
  linksWithoutJs: number;
  /** schema.org types in JSON-LD or microdata. */
  schemaTypes: string[];
  /** JSON-LD blocks that couldn't be read. */
  schemaErrors: number;
  /** Headings phrased as questions. */
  questionHeadings: number;
  /** A short paragraph straight after the main heading, which answer engines and voice assistants can quote. */
  summaryFirst: boolean;
  speakable: boolean;
  /** Phone numbers linked on the page, digits only. Business contact details. */
  phones: string[];
}

/** What the check records about the site once, on the first page. */
export interface FutureSiteMetrics {
  /** null when there's no robots.txt. */
  aiCrawlers: { agent: string; owner: string; purpose: string; allowed: boolean }[] | null;
  sitemap: { found: boolean; urls: number; withDates: number } | null;
}

/** Visible words in HTML as first sent: without scripts, styles and tags. Exported for tests. */
export function textOfHtml(html: string): string {
  return html
    .replace(/<(script|style|noscript|template|svg)\b[\s\S]*?<\/\1>/gi, ' ')
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&[a-z#0-9]+;/gi, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Which AI crawlers robots.txt lets read the home page. Exported for tests. */
export function aiCrawlerAccess(origin: string, robotsText: string): FutureSiteMetrics['aiCrawlers'] {
  const robots = RobotsTxtFile.from(`${origin}/robots.txt`, robotsText);
  return AI_CRAWLERS.map((c) => ({ ...c, allowed: robots.isAllowed(`${origin}/`, c.agent) }));
}

/** URLs in a sitemap and how many have a last-modified date. A sitemap index counts its own entries. */
export function sitemapDates(xml: string): { urls: number; withDates: number } {
  const entries = xml.match(/<(url|sitemap)>[\s\S]*?<\/\1>/gi) ?? [];
  return { urls: entries.length, withDates: entries.filter((e) => /<lastmod>\s*\S/i.test(e)).length };
}

export function futureModule(startUrl: string): CheckModule {
  let siteChecked = false;
  let organisationSeen = false;
  let anySchema = false;
  let firstPage: { locationId: number; viewport: string } | undefined;
  const isStart = (url: string) => {
    const a = new URL(url);
    const b = new URL(startUrl);
    return a.origin === b.origin && a.pathname.replace(/\/index\.html?$/, '/') === b.pathname.replace(/\/index\.html?$/, '/');
  };

  return {
    id: 'future',
    name: 'Future readiness',
    perViewport: false,
    async run({ page, location, viewport, recordMetrics }) {
      const url = page.url();
      if (!/^https?:/.test(url) || (location.kind === 'state' && location.depth > 0)) return [];
      const request = page.context().request;
      firstPage ??= { locationId: location.id, viewport };
      const out: CheckFinding[] = [];

      const rendered = await page.evaluate(() => {
        const visible = (document.body?.innerText ?? '').replace(/\s+/g, ' ').trim();
        const types: string[] = [];
        let errors = 0;
        let speakable = false;
        const collect = (node: unknown) => {
          if (!node || typeof node !== 'object') return;
          if (Array.isArray(node)) return node.forEach(collect);
          const obj = node as Record<string, unknown>;
          const type = obj['@type'];
          for (const t of Array.isArray(type) ? type : [type]) if (typeof t === 'string') types.push(t);
          if ('speakable' in obj) speakable = true;
          for (const value of Object.values(obj)) if (value && typeof value === 'object') collect(value);
        };
        for (const script of document.querySelectorAll('script[type="application/ld+json" i]')) {
          try {
            collect(JSON.parse(script.textContent ?? ''));
          } catch {
            errors++;
          }
        }
        for (const el of document.querySelectorAll('[itemtype]')) types.push((el.getAttribute('itemtype') ?? '').split('/').pop() ?? '');
        const h1 = document.querySelector('h1');
        let next = h1?.nextElementSibling;
        while (next && !/^(P|DIV|SECTION)$/.test(next.tagName)) next = next.nextElementSibling;
        const firstWords = (next?.textContent ?? '').trim().split(/\s+/).filter(Boolean).length;
        return {
          visibleLength: visible.length,
          links: document.querySelectorAll('a[href]').length,
          types: [...new Set(types.filter(Boolean))],
          errors,
          speakable,
          questionHeadings: [...document.querySelectorAll('h1, h2, h3, h4')].filter((h) => /\?\s*$/.test(h.textContent ?? '')).length,
          summaryFirst: firstWords >= 10 && firstWords <= 60,
          phones: [...document.querySelectorAll('a[href^="tel:" i]')].map((a) => (a.getAttribute('href') ?? '').replace(/\D/g, '')).filter(Boolean),
        };
      });

      // The page as first sent, before JavaScript: what most AI crawlers and many bots see.
      const raw = await request
        .get(url, { failOnStatusCode: false, maxRedirects: 5 })
        .then(async (r) => (r.ok() && /html/i.test(r.headers()['content-type'] ?? '') ? r.text() : null))
        .catch(() => null);
      const rawText = raw === null ? null : textOfHtml(raw);
      const rawLinks = raw === null ? null : (raw.match(/<a\b[^>]*\bhref\s*=/gi) ?? []).length;
      const ratio = (part: number | null, whole: number) => (part === null ? 1 : whole === 0 ? 1 : Math.min(1, Math.round((part / whole) * 100) / 100));
      const metrics: FutureMetrics = {
        textWithoutJs: ratio(rawText?.length ?? null, rendered.visibleLength),
        linksWithoutJs: ratio(rawLinks, rendered.links),
        schemaTypes: rendered.types,
        schemaErrors: rendered.errors,
        questionHeadings: rendered.questionHeadings,
        summaryFirst: rendered.summaryFirst,
        speakable: rendered.speakable,
        phones: [...new Set(rendered.phones)],
      };

      if (rendered.visibleLength >= 200 && metrics.textWithoutJs < 0.5) {
        out.push(finding('content-needs-javascript', `Only ${Math.round(metrics.textWithoutJs * 100)}% of the page’s text is in the HTML before JavaScript runs.`));
      }
      if (rendered.errors) out.push(finding('structured-data-invalid', `${rendered.errors} JSON-LD ${rendered.errors === 1 ? 'block isn’t' : 'blocks aren’t'} valid JSON, so search engines and AI tools ignore ${rendered.errors === 1 ? 'it' : 'them'}.`));
      if (rendered.types.length) anySchema = true;
      if (rendered.types.some((t) => /^(Organization|LocalBusiness|Corporation|NGO|GovernmentOrganization|EducationalOrganization|Museum|Store|.*Business)$/.test(t))) organisationSeen = true;

      const site: Partial<FutureSiteMetrics> = {};
      if (!siteChecked) {
        siteChecked = true;
        const origin = new URL(url).origin;
        const get = (path: string) => request.get(origin + path, { failOnStatusCode: false, maxRedirects: 5 }).catch(() => null);
        const robots = await get('/robots.txt');
        const robotsText = robots?.ok() ? await robots.text() : null;
        site.aiCrawlers = robotsText === null ? null : aiCrawlerAccess(origin, robotsText);
        const sitemapUrl = /^\s*sitemap:\s*(\S+)/im.exec(robotsText ?? '')?.[1] ?? `${origin}/sitemap.xml`;
        const sitemap = await request.get(sitemapUrl, { failOnStatusCode: false, maxRedirects: 5 }).catch(() => null);
        if (sitemap?.ok()) {
          const counted = sitemapDates(await sitemap.text());
          site.sitemap = { found: true, ...counted };
          if (counted.urls && counted.withDates < counted.urls / 2) out.push(finding('sitemap-no-dates', `${counted.urls - counted.withDates} of ${counted.urls} sitemap entries have no last-modified date.`));
        } else {
          site.sitemap = { found: false, urls: 0, withDates: 0 };
        }
      }
      recordMetrics?.({ future: metrics, ...(Object.keys(site).length && { futureSite: site }) });
      if (isStart(url) && !organisationSeen && location.kind === 'page') {
        out.push(finding('organisation-data-missing', 'The home page has no schema.org Organization (or LocalBusiness) data saying who runs the site.'));
      }
      return out;
    },
    async finish() {
      if (anySchema || !firstPage) return [];
      return [{ ...finding('structured-data-missing', 'No page audited has schema.org structured data (JSON-LD or microdata).'), ...firstPage }];
    },
  };
}

function finding(ruleId: string, failureSummary: string): CheckFinding {
  const guidance = guidanceFor('prego', ruleId)!;
  const rule = RULES[ruleId];
  return {
    module: 'future',
    engine: 'prego',
    ruleId,
    category: rule.category,
    severity: rule.severity,
    title: guidance.title,
    description: guidance.description,
    helpUrl: null,
    wcagCriteria: [],
    wcagLevel: null,
    selector: 'html',
    html: '<html>',
    failureSummary,
    ...(rule.siteWide && { siteWide: true, component: `future:${ruleId}` }),
  };
}
