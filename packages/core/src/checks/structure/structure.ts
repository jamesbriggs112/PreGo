import type { CheckModule } from '../types.js';
import { measureCopy, type NavigationMetrics } from '../../export/sections.js';

// Measurements for the report's Content and tone and Information architecture sections: how each
// page's copy reads, and the home page's main navigation. It records figures only; it raises no tickets.

/** The navigation is read on the start page: the start address, or its /index.html. */
function isStartPage(url: string, startUrl: string): boolean {
  const page = new URL(url);
  const start = new URL(startUrl);
  const path = (p: string) => p.replace(/\/index\.html?$/, '/');
  return page.origin === start.origin && path(page.pathname) === path(start.pathname);
}

export function structureModule(startUrl: string): CheckModule {
  let navigationDone = false;
  return {
    id: 'structure',
    name: 'Content and structure (for reports)',
    perViewport: false,
    async run({ page, location, recordMetrics }) {
      // The page's own copy: the main content where it's marked up, without navigation and footers.
      const text = await page.evaluate(() => {
        const root = document.querySelector('main, [role="main"]') ?? document.body;
        const copy = root.cloneNode(true) as HTMLElement;
        copy.querySelectorAll('nav, header, footer, script, style, noscript, [aria-hidden="true"], [hidden]').forEach((el) => el.remove());
        return copy.innerText ?? copy.textContent ?? '';
      });
      const metrics: Record<string, unknown> = { content: measureCopy(text) };
      if (!navigationDone && location.kind === 'page' && isStartPage(location.url, startUrl)) {
        navigationDone = true;
        metrics.navigation = await page.evaluate((): NavigationMetrics => {
          const nav =
            document.querySelector('header nav, nav[aria-label*="main" i], nav[aria-label*="primary" i], [role="navigation"]') ?? document.querySelector('nav');
          if (!nav) return { items: [] };
          const list = nav.querySelector('ul');
          const label = (el: Element | null) => (el?.textContent ?? '').replace(/\s+/g, ' ').trim().slice(0, 80);
          const items = list
            ? [...list.children].filter((li) => li.tagName === 'LI').map((li) => {
                const link = li.querySelector('a, button');
                return { label: label(link) || label(li), href: link instanceof HTMLAnchorElement ? link.href : null, children: li.querySelectorAll('ul a, ul button').length };
              })
            : [...nav.querySelectorAll('a')].map((a) => ({ label: label(a), href: a.href, children: 0 }));
          return { items: items.filter((i) => i.label).slice(0, 30) };
        });
      }
      recordMetrics?.(metrics);
      return [];
    },
  };
}
