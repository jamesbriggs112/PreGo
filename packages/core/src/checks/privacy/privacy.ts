import type { Browser } from 'playwright';
import type { BasicAuth } from '../../browser/session.js';
import type { Severity } from '../../types.js';
import type { CheckFinding, CheckModule, LocatedFinding } from '../types.js';
import { guidanceFor } from '../guidance.js';
import { trackerName } from '../../browser/trackers.js';
import { sameSite } from '../../profile/site.js';

export { trackerName };

// What a first-time visitor's browser is given before they answer the cookie banner. Each template's
// first page is opened in a fresh browser with no stored consent, and nothing on it is clicked.
// Requests to known trackers are recorded and blocked, so the audit itself sends nothing to them
// (browser/trackers.ts keeps them unreachable for every check).

const RULES: Record<string, Severity> = { 'trackers-before-consent': 'High', 'tracking-cookies-before-consent': 'High', 'third-party-services': 'Low' };

/** Cookies set by common analytics and advertising scripts. */
const TRACKING_COOKIES = /^(_ga(_.+)?|_gid|_gat.*|_gcl_.+|_fbp|_fbc|fr|_hj.+|_clck|_clsk|_uet(sid|vid)|_pin_unauth|_tt_enable_cookie|_ttp|li_fat_id|IDE|test_cookie|__hs.+|hubspotutk|mp_.+_mixpanel|ajs_(anonymous|user)_id)$/;

export function isTrackingCookie(name: string): boolean {
  return TRACKING_COOKIES.test(name);
}

export function privacyModule(options: { basicAuth?: BasicAuth; onRequest?: (url: string) => void } = {}): CheckModule {
  const templatesChecked = new Set<string>();
  const thirdParties = new Set<string>();
  let firstPage: { locationId: number; viewport: string } | undefined;

  return {
    id: 'privacy',
    name: 'Cookies and privacy',
    perViewport: false,
    async run({ page, location, viewport }) {
      const url = page.url();
      if (!/^https?:/.test(url) || (location.kind === 'state' && location.depth > 1)) return [];
      const template = location.templateKey ?? location.url;
      if (templatesChecked.has(template) || templatesChecked.size >= 10) return [];
      templatesChecked.add(template);
      firstPage ??= { locationId: location.id, viewport };
      const browser = page.context().browser() as Browser | null;
      if (!browser) return [];

      const origin = new URL(url);
      const context = await browser.newContext({
        ignoreHTTPSErrors: true,
        httpCredentials: options.basicAuth ? { ...options.basicAuth, origin: origin.origin, send: 'unauthorized' } : undefined,
      });
      const trackers = new Map<string, string>();
      try {
        await context.route('**/*', (route) => {
          const requestUrl = route.request().url();
          let host = '';
          try {
            host = new URL(requestUrl).hostname;
          } catch {
            return route.continue();
          }
          const tracker = trackerName(host);
          if (tracker) {
            trackers.set(tracker, host);
            return route.abort('blockedbyclient');
          }
          if (/^https?:/.test(requestUrl) && !sameSite(host, origin.hostname)) thirdParties.add(host);
          options.onRequest?.(requestUrl);
          return route.continue();
        });
        const fresh = await context.newPage();
        await fresh.goto(url, { waitUntil: 'load', timeout: 30_000 });
        // Tag managers often fire a moment after load.
        await fresh.waitForLoadState('networkidle', { timeout: 3_000 }).catch(() => undefined);
        const cookies = (await context.cookies()).filter((c) => isTrackingCookie(c.name));

        const out: CheckFinding[] = [];
        for (const [name, host] of trackers) {
          out.push(finding('trackers-before-consent', `${name} (${host}) loads before the visitor has given consent.`, `privacy:tracker:${name}`));
        }
        if (cookies.length) {
          const names = [...new Set(cookies.map((c) => c.name))];
          out.push(finding('tracking-cookies-before-consent', `Tracking cookies are set before consent: ${names.join(', ')}.`, `privacy:cookies:${names.sort().join(',')}`));
        }
        return out;
      } catch {
        return [];
      } finally {
        await context.close();
      }
    },
    // Every outside service contacted before consent, for the privacy notice: one ticket for the site.
    async finish(): Promise<LocatedFinding[]> {
      if (!thirdParties.size || !firstPage) return [];
      const hosts = [...thirdParties].sort();
      return [{ ...finding('third-party-services', `Before consent, pages contact ${hosts.length} other service${hosts.length === 1 ? '' : 's'}: ${hosts.join(', ')}.`, 'privacy:third-parties'), ...firstPage }];
    },
  };
}

function finding(ruleId: string, failureSummary: string, component: string): CheckFinding {
  const guidance = guidanceFor('prego', ruleId)!;
  return {
    module: 'privacy',
    engine: 'prego',
    ruleId,
    category: 'SEC',
    severity: RULES[ruleId],
    title: guidance.title,
    description: guidance.description,
    helpUrl: 'https://ico.org.uk/for-organisations/direct-marketing-and-privacy-and-electronic-communications/guide-to-pecr/cookies-and-similar-technologies/',
    wcagCriteria: [],
    wcagLevel: null,
    selector: 'html',
    html: '<html>',
    failureSummary,
    siteWide: true,
    component,
  };
}
