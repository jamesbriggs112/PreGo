import type { FailedPage } from '../../crawl/crawler.js';
import type { CheckFinding, CheckModule } from '../types.js';
import { guidanceFor } from '../guidance.js';

/**
 * Broken links found while crawling, reported on the page that links to them (with the link itself
 * outlined). Each broken address is one site-wide ticket listing every page that links to it.
 */
export function brokenLinksModule(failedPages: FailedPage[]): CheckModule {
  const byReferrer = new Map<string, FailedPage[]>();
  for (const failed of failedPages) {
    if (!failed.referrer) continue;
    const key = normalise(failed.referrer);
    byReferrer.set(key, [...(byReferrer.get(key) ?? []), failed]);
  }
  return {
    id: 'links',
    name: 'Broken links',
    perViewport: false,
    async run({ page, location }) {
      if (location.kind !== 'page') return [];
      const broken = byReferrer.get(normalise(location.url)) ?? byReferrer.get(normalise(page.url())) ?? [];
      const out: CheckFinding[] = [];
      for (const failed of broken) {
        const anchor = await page.evaluate((target) => {
          const link = [...document.querySelectorAll('a[href]')].find((a) => (a as HTMLAnchorElement).href === target);
          if (!link) return null;
          const path: string[] = [];
          for (let node: Element | null = link; node && node !== document.documentElement; node = node.parentElement) {
            if (node.id) {
              path.unshift(`#${CSS.escape(node.id)}`);
              break;
            }
            const same = node.parentElement ? [...node.parentElement.children].filter((c) => c.tagName === node!.tagName) : [];
            path.unshift(same.length > 1 ? `${node.tagName.toLowerCase()}:nth-of-type(${same.indexOf(node) + 1})` : node.tagName.toLowerCase());
          }
          return { selector: path.join(' > '), html: link.outerHTML.slice(0, 200), text: (link.textContent ?? '').trim() };
        }, failed.url);
        // 401 and 403 often mean the server turns away automated tools, not that the page is gone.
        const denied = isAccessDenied(failed.statusCode);
        const ruleId = denied ? 'link-access-denied' : 'broken-link';
        const guidance = guidanceFor('prego', ruleId)!;
        const status = failed.statusCode ? `HTTP ${failed.statusCode}` : failed.error;
        out.push({
          module: 'links',
          engine: 'prego',
          ruleId,
          category: 'UX',
          severity: denied ? 'Low' : failed.statusCode && failed.statusCode >= 500 ? 'High' : 'Medium',
          title: guidance.title,
          description: guidance.description,
          helpUrl: null,
          wcagCriteria: [],
          wcagLevel: null,
          selector: anchor?.selector ?? 'html',
          html: anchor?.html ?? `<a href="${failed.url}">`,
          failureSummary: `${anchor?.text ? `The link “${anchor.text}”` : 'A link'} goes to ${failed.url}, which returns ${status}.`,
          siteWide: true,
          // Same-site links by path: the origin can change between runs (local folders get a new port).
          component: `link:${sameSite(failed.url, location.url) ? new URL(failed.url).pathname + new URL(failed.url).search : failed.url}`,
        });
      }
      return out;
    },
  };
}

export const isAccessDenied = (statusCode: number | null) => statusCode === 401 || statusCode === 403;

function sameSite(a: string, b: string): boolean {
  return new URL(a).origin === new URL(b).origin;
}

/** Same page whether or not the address ends in a slash or index.html. */
function normalise(url: string): string {
  const u = new URL(url);
  u.hash = '';
  u.pathname = u.pathname.replace(/\/index\.html?$/, '/');
  return u.href;
}
