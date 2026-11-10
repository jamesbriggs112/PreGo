import type { Category, Severity } from '../../types.js';
import type { CheckFinding, CheckModule, LocatedFinding } from '../types.js';
import { guidanceFor } from '../guidance.js';

// Mistakes that slip through at launch: staging settings left on, links to the staging site,
// placeholder text, and the small things a live site is expected to have. Every request here is one
// an ordinary visitor's browser could make.

const RULES: Record<string, { severity: Severity; category: Category; siteWide: boolean }> = {
  noindex: { severity: 'High', category: 'TECH', siteWide: true },
  'robots-blocks-all': { severity: 'High', category: 'TECH', siteWide: true },
  'staging-links': { severity: 'Medium', category: 'TECH', siteWide: true },
  'staging-canonical': { severity: 'Medium', category: 'TECH', siteWide: true },
  'placeholder-text': { severity: 'Medium', category: 'CONT', siteWide: false },
  'no-sitemap': { severity: 'Low', category: 'TECH', siteWide: true },
  'no-favicon': { severity: 'Low', category: 'TECH', siteWide: true },
  'no-analytics': { severity: 'Low', category: 'TECH', siteWide: true },
};

/** Hosts that are clearly not production: local machines and staging, dev, test or preview subdomains. */
const NON_PRODUCTION = /^(localhost|127\.\d+\.\d+\.\d+|\[::1\]|0\.0\.0\.0|.+\.localhost|.+\.test|.+\.local)$|(^|[.-])(staging|stage|stg|dev|develop|test|testing|uat|qa|preview|sandbox)([.-]|\d|$)/i;
const LOCAL = /^(localhost|127\.\d+\.\d+\.\d+|\[::1\]|.+\.localhost|.+\.test)$/i;
const PLACEHOLDER = /\blorem ipsum\b|\bdolor sit amet\b|\bTODO\b|\bFIXME\b|\[(?:insert|placeholder|tbc|tbd|add)[^\]]{0,40}\]|\bplaceholder text\b/i;
const ANALYTICS = /googletagmanager\.com|google-analytics\.com|plausible\.io|matomo|piwik|clarity\.ms|hotjar\.com|cdn\.segment\.com|usefathom\.com|umami|cloudflareinsights\.com|simpleanalytics/i;

export interface PageFacts {
  url: string;
  robotsMeta: string[];
  robotsHeader: string | null;
  canonical: string | null;
  urls: string[];
  text: string;
}

/** Page-level go-live problems. Exported so it can be tested without a browser. */
export function analysePage(facts: PageFacts): { ruleId: string; detail: string; component?: string }[] {
  const out: { ruleId: string; detail: string; component?: string }[] = [];
  const page = new URL(facts.url);
  const robots = [...facts.robotsMeta, facts.robotsHeader ?? ''].join(',').toLowerCase();
  if (/\bnoindex\b|\bnone\b/.test(robots)) out.push({ ruleId: 'noindex', detail: facts.robotsHeader && /noindex|none/i.test(facts.robotsHeader) ? `X-Robots-Tag: ${facts.robotsHeader}` : `<meta name="robots" content="${facts.robotsMeta.join(', ')}">` });

  // Links to a non-production host. When auditing staging itself, its own absolute address counts too,
  // because it will be wrong once the site moves to its live address. A local folder is exempt.
  const pageLocal = LOCAL.test(page.hostname);
  const hosts = new Map<string, string>();
  for (const raw of facts.urls) {
    let target: URL;
    try {
      target = new URL(raw, facts.url);
    } catch {
      continue;
    }
    if (!/^https?:$/.test(target.protocol) || !/^https?:\/\//i.test(raw.trim())) continue;
    const sameHost = target.host === page.host;
    if (sameHost && pageLocal) continue;
    if (NON_PRODUCTION.test(target.hostname) && !hosts.has(target.host)) hosts.set(target.host, raw.trim());
  }
  for (const [host, example] of hosts) out.push({ ruleId: 'staging-links', detail: `Links or files point at ${host}, e.g. ${example}.`, component: `golive:staging-links:${host}` });

  if (facts.canonical) {
    try {
      const canonical = new URL(facts.canonical, facts.url);
      if (NON_PRODUCTION.test(canonical.hostname) && !(pageLocal && canonical.host === page.host)) out.push({ ruleId: 'staging-canonical', detail: `The canonical address is ${canonical.href}.` });
    } catch {
      // An unparseable canonical is html-validate's business.
    }
  }

  const placeholder = PLACEHOLDER.exec(facts.text);
  if (placeholder) {
    const at = placeholder.index;
    out.push({ ruleId: 'placeholder-text', detail: `“…${facts.text.slice(Math.max(0, at - 30), at + 50).replace(/\s+/g, ' ').trim()}…”` });
  }
  return out;
}

/** True when robots.txt blocks every crawler from the whole site. */
export function robotsBlocksAll(robots: string): boolean {
  let applies = false;
  let inRules = false;
  for (const line of robots.split(/\r?\n/).map((l) => l.replace(/#.*/, '').trim())) {
    const [field, ...rest] = line.split(':');
    const value = rest.join(':').trim();
    if (/^user-agent$/i.test(field)) {
      if (inRules) applies = false;
      inRules = false;
      if (value === '*') applies = true;
    } else if (/^(dis)?allow$/i.test(field)) {
      inRules = true;
      if (applies && /^disallow$/i.test(field) && value === '/') return true;
    }
  }
  return false;
}

export function goLiveModule(): CheckModule {
  let siteChecked = false;
  let analyticsSeen = false;
  let firstPage: { locationId: number; viewport: string } | undefined;

  return {
    id: 'golive',
    name: 'Go-live mistakes',
    perViewport: false,
    async run({ page, location, viewport }) {
      const url = page.url();
      if (!/^https?:/.test(url)) return [];
      const request = page.context().request;
      const out: CheckFinding[] = [];
      const facts = await page.evaluate(() => ({
        robotsMeta: [...document.querySelectorAll('meta[name="robots" i], meta[name="googlebot" i]')].map((m) => m.getAttribute('content') ?? ''),
        canonical: document.querySelector('link[rel="canonical" i]')?.getAttribute('href') ?? null,
        urls: [...document.querySelectorAll('a[href], link[href], script[src], img[src], iframe[src], source[src], form[action]')]
          .map((e) => e.getAttribute('href') ?? e.getAttribute('src') ?? e.getAttribute('action') ?? '')
          .filter(Boolean),
        text: document.body?.innerText ?? '',
        icon: !!document.querySelector('link[rel~="icon" i]'),
        scripts: [...document.scripts].map((s) => s.src).filter(Boolean),
        analyticsGlobal: ['gtag', 'ga', '_paq', 'plausible', 'clarity', 'fathom', 'umami'].some((g) => g in window),
      }));
      // Explored screens and journey steps share the start page's response headers.
      const robotsHeader = location.kind === 'state' && location.depth > 1 ? null : ((await request.get(url, { failOnStatusCode: false }).catch(() => null))?.headers()['x-robots-tag'] ?? null);
      for (const f of analysePage({ url, ...facts, robotsHeader })) out.push(finding(f.ruleId, f.detail, f.component));
      if (facts.analyticsGlobal || facts.scripts.some((s) => ANALYTICS.test(s))) analyticsSeen = true;
      firstPage ??= { locationId: location.id, viewport };

      if (!siteChecked) {
        siteChecked = true;
        const origin = new URL(url).origin;
        const get = (path: string) => request.get(origin + path, { failOnStatusCode: false, maxRedirects: 5 }).catch(() => null);
        const robots = await get('/robots.txt');
        const robotsText = robots?.ok() ? await robots.text() : '';
        if (robotsBlocksAll(robotsText)) out.push(finding('robots-blocks-all', 'robots.txt has “User-agent: *” with “Disallow: /”.'));
        if (!/^\s*sitemap:/im.test(robotsText) && !(await get('/sitemap.xml'))?.ok()) out.push(finding('no-sitemap', 'No sitemap.xml, and robots.txt doesn’t point to one.'));
        // Only addresses the site links to, or that crawlers are expected to read (robots.txt and the
        // sitemap), are requested: no made-up addresses, and no guessing at /favicon.ico.
        if (!facts.icon) out.push(finding('no-favicon', 'The start page doesn’t link an icon with <link rel="icon">.'));
      }
      return out;
    },
    async finish(): Promise<LocatedFinding[]> {
      if (analyticsSeen || !firstPage) return [];
      return [{ ...finding('no-analytics', 'No common analytics script (Google Analytics, Tag Manager, Plausible, Matomo, Clarity, Fathom and others) was found on any page audited.'), ...firstPage }];
    },
  };
}

function finding(ruleId: string, failureSummary: string, component?: string): CheckFinding {
  const guidance = guidanceFor('prego', ruleId)!;
  const rule = RULES[ruleId];
  return {
    module: 'golive',
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
    ...(rule.siteWide && { siteWide: true, component: component ?? `golive:${ruleId}` }),
  };
}
