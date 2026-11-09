import type { CheckModule } from '../types.js';
import { measureCopy, type NavigationMetrics } from '../../export/sections.js';
import type { PageSignals } from '../../audience/types.js';

// Measurements for the report's Content and tone and Information architecture sections, and for
// suggesting the site's purposes and audiences: how each page's copy reads, what a visitor can do on it
// (contact links, forms), its main headings, and the home page's main navigation. It reads what's on
// the page only, records figures, and raises no tickets.

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
      const signals = await page.evaluate((): PageSignals => {
        const text = (el: Element) => (el.textContent ?? '').replace(/\s+/g, ' ').trim();
        const forms = [...document.querySelectorAll('form')].map((form): PageSignals['forms'][number] => {
          const fields = [...form.querySelectorAll('input, textarea, select')] as HTMLInputElement[];
          const has = (pattern: RegExp) => fields.some((f) => pattern.test(`${f.type} ${f.name} ${f.id} ${f.getAttribute('autocomplete') ?? ''}`));
          if (has(/password/)) return 'login';
          if (form.getAttribute('role') === 'search' || form.closest('[role="search"]') || has(/^search|\b(q|s|query|search)\b/)) return 'search';
          if (form.querySelector('textarea') || has(/message|enquiry|comment/)) return 'contact';
          if (fields.filter((f) => !['hidden', 'submit', 'button'].includes(f.type)).length <= 2 && has(/email/)) return 'newsletter';
          return 'other';
        });
        return {
          tel: document.querySelectorAll('a[href^="tel:"]').length,
          mailto: document.querySelectorAll('a[href^="mailto:"]').length,
          // A phone number written out, for pages that don't link it: starting 0 (UK-style) or +, in groups.
          phoneText: /(?:\+\d{1,3}[\s-]?(?:\(0\))?|\(?0)\d{2,5}\)?[\s-]?\d{3,4}[\s-]?\d{3,4}\b/.test(document.body.innerText ?? ''),
          forms,
          headings: [...document.querySelectorAll('h1, h2')].map(text).filter(Boolean).slice(0, 8),
          links: [...document.querySelectorAll('a[href]')]
            .map((a) => ({ label: text(a).slice(0, 80), url: new URL((a as HTMLAnchorElement).href, window.location.href) }))
            .filter(({ label, url }) => label && url.origin === window.location.origin)
            .map(({ label, url }) => ({ label, path: url.pathname }))
            .filter((link, i, all) => all.findIndex((l) => l.path === link.path) === i)
            .slice(0, 60),
        };
      });
      const metrics: Record<string, unknown> = { content: measureCopy(text), signals };
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
