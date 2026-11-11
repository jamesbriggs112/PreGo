import type { Page } from 'playwright';
import type { Severity } from '../../types.js';
import type { CheckFinding, CheckModule, LocatedFinding } from '../types.js';
import { guidanceFor } from '../guidance.js';
import type { AccessibilityStatementInfo } from '../../profile/profile.js';
import { sameSite } from '../../profile/site.js';

// Whether the site links an accessibility statement, and how recently it was reviewed. Only a page the
// site links to is read: the statement itself, if it isn't one of the pages audited anyway. UK public
// sector sites must publish one (the 2018 accessibility regulations) and review it every year; for
// everyone else it's good practice.

const RULES: Record<string, Severity> = { 'no-accessibility-statement': 'Low', 'accessibility-statement-outdated': 'Low' };
const MONTHS = ['january', 'february', 'march', 'april', 'may', 'june', 'july', 'august', 'september', 'october', 'november', 'december'];
const STALE_DAYS = 365;

/** Links that look like they go to an accessibility statement, best first. */
async function statementLinks(page: Page): Promise<{ href: string; text: string }[]> {
  return page.evaluate(() =>
    [...document.querySelectorAll('a[href]')]
      .map((a) => ({ href: (a as HTMLAnchorElement).href, text: (a.textContent ?? a.getAttribute('aria-label') ?? '').replace(/\s+/g, ' ').trim() }))
      .filter((l) => /^https?:/.test(l.href) && (/accessibility/i.test(l.text) || /accessib/i.test(new URL(l.href).pathname)) && !/^#|skip/i.test(l.text))
      .sort((a, b) => Number(/statement/i.test(b.text + b.href)) - Number(/statement/i.test(a.text + a.href))),
  );
}

/** Dates written in the text, as YYYY-MM-DD: 1 March 2024, March 1, 2024, 01/03/2024 (UK order) and 2024-03-01. */
export function datesIn(text: string): string[] {
  const out: string[] = [];
  const pad = (n: number) => String(n).padStart(2, '0');
  const add = (y: number, m: number, d: number) => {
    if (y >= 2000 && y <= 2100 && m >= 1 && m <= 12 && d >= 1 && d <= 31) out.push(`${y}-${pad(m)}-${pad(d)}`);
  };
  // A full month name or its abbreviation (Sept too), never another word that starts the same way.
  const month = (name: string) => MONTHS.findIndex((m) => m.startsWith(name.toLowerCase().replace(/^sept$/, 'sep'))) + 1;
  for (const m of text.matchAll(/\b(\d{1,2})(?:st|nd|rd|th)?\s+(?:of\s+)?([A-Za-z]{3,9})\.?,?\s+(\d{4})\b/g)) if (month(m[2])) add(Number(m[3]), month(m[2]), Number(m[1]));
  for (const m of text.matchAll(/\b([A-Za-z]{3,9})\.?\s+(\d{1,2})(?:st|nd|rd|th)?,?\s+(\d{4})\b/g)) if (month(m[1])) add(Number(m[3]), month(m[1]), Number(m[2]));
  for (const m of text.matchAll(/\b(\d{4})-(\d{2})-(\d{2})\b/g)) add(Number(m[1]), Number(m[2]), Number(m[3]));
  for (const m of text.matchAll(/\b(\d{1,2})[/.](\d{1,2})[/.](\d{4})\b/g)) add(Number(m[3]), Number(m[2]), Number(m[1]));
  // Month and year only ("reviewed in March 2025"): the first of the month.
  for (const m of text.matchAll(/(?<!\d\s)\b([A-Za-z]{3,9})\s+(\d{4})\b/g)) if (month(m[1])) add(Number(m[2]), month(m[1]), 1);
  return out;
}

/** What a statement's text says: when it was last prepared, reviewed or updated, the WCAG version, and compliance. */
export function readStatement(text: string): Pick<AccessibilityStatementInfo, 'updated' | 'wcag' | 'compliance'> {
  const clean = text.replace(/\s+/g, ' ');
  const sentences = clean.split(/(?<=[.!?])\s+(?=[A-Z])/);
  const dated = sentences
    .filter((s) => /\b(prepared|reviewed|updated|revised|last (?:tested|checked|assessed)|published|tested on|was tested|evaluated)\b/i.test(s))
    .flatMap(datesIn);
  const today = new Date().toISOString().slice(0, 10);
  const updated =
    dated
      .filter((d) => d <= today)
      .sort()
      .at(-1) ?? null;
  const wcag = /(?:WCAG|Web Content Accessibility Guidelines)\s*\(?(?:version\s*)?(2\.[0-2]|3\.0)/i.exec(clean)?.[1] ?? null;
  const compliance = /\bnot compliant\b|\bnon-compliant\b/i.test(clean)
    ? 'none'
    : /\bpartially compliant\b/i.test(clean)
      ? 'partial'
      : /\bfully compliant\b/i.test(clean)
        ? 'full'
        : null;
  return { updated, wcag, compliance };
}

export function statementModule(): CheckModule {
  let info: AccessibilityStatementInfo | null = null;
  let firstPage: { locationId: number; viewport: string } | undefined;
  let searched = 0;

  return {
    id: 'statement',
    name: 'Accessibility statement',
    perViewport: false,
    async run({ page, location, viewport, recordMetrics }) {
      if (info?.url || !/^https?:/.test(page.url()) || (location.kind === 'state' && location.depth > 0) || searched >= 40) return [];
      searched++;
      firstPage ??= { locationId: location.id, viewport };
      // The statement itself may be one of the pages audited.
      const here =
        /accessib/i.test(new URL(page.url()).pathname) &&
        /accessibility statement/i.test(
          (await page.title().catch(() => '')) +
            (await page
              .locator('h1')
              .first()
              .textContent({ timeout: 500 })
              .catch(() => '')),
        );
      const link = here ? { href: page.url(), text: (await page.title().catch(() => '')) || 'Accessibility statement' } : (await statementLinks(page).catch(() => []))[0];
      if (!link) {
        info ??= { url: null, linkText: null, foundOn: null, updated: null, wcag: null, compliance: null, read: false };
        return [];
      }
      let text: string | null = null;
      if (here)
        text = await page
          .locator('body')
          .innerText({ timeout: 5_000 })
          .catch(() => null);
      else if (sameSite(new URL(link.href).hostname, new URL(page.url()).hostname)) {
        // A page the site links to, fetched the way following the link would.
        const response = await page.request.get(link.href, { timeout: 15_000, maxRedirects: 3 }).catch(() => null);
        if (response?.ok() && /html|text/.test(response.headers()['content-type'] ?? '')) text = htmlToText((await response.text()).slice(0, 2_000_000));
      }
      info = { url: link.href, linkText: link.text || null, foundOn: page.url(), ...(text ? readStatement(text) : { updated: null, wcag: null, compliance: null }), read: !!text };
      recordMetrics?.({ accessibilityStatement: info });
      firstPage = { locationId: location.id, viewport };
      return [];
    },
    async finish(): Promise<LocatedFinding[]> {
      if (!firstPage || !info) return [];
      const at = { locationId: firstPage.locationId, viewport: firstPage.viewport };
      if (!info.url) return [{ ...finding('no-accessibility-statement', 'No page Prego looked at links to an accessibility statement.'), ...at }];
      if (info.updated) {
        const days = Math.floor((Date.now() - Date.parse(info.updated)) / 86_400_000);
        if (days > STALE_DAYS) {
          const months = Math.floor(days / 30.4);
          return [
            {
              ...finding(
                'accessibility-statement-outdated',
                `The accessibility statement (${info.url}) was last prepared, reviewed or updated on ${info.updated}, about ${months} months ago.`,
              ),
              ...at,
            },
          ];
        }
      }
      return [];
    },
  };
}

function htmlToText(html: string): string {
  return html
    .replace(/<(script|style|noscript|template)[\s\S]*?<\/\1>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(Number(n)))
    .replace(/\s+/g, ' ');
}

function finding(ruleId: string, failureSummary: string): CheckFinding {
  const guidance = guidanceFor('prego', ruleId)!;
  return {
    module: 'statement',
    engine: 'prego',
    ruleId,
    category: 'A11Y',
    severity: RULES[ruleId],
    title: guidance.title,
    description: guidance.description,
    helpUrl: 'https://www.gov.uk/guidance/make-your-website-or-app-accessible-and-publish-an-accessibility-statement',
    wcagCriteria: [],
    wcagLevel: null,
    selector: 'html',
    html: '<html>',
    failureSummary,
    siteWide: true,
    component: `statement:${ruleId}`,
  };
}
