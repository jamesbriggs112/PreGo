import type { Page } from 'playwright';

export interface ComponentInfo {
  /**
   * Tag-and-class path from <body> to the nearest container around the element (form, main, article,
   * header, footer, nav, aside, section, dialog or anything with a landmark role), e.g.
   * `body>main>form.contact`. Stable across pages and runs, unlike engine selectors.
   */
  path: string;
  /**
   * True when the element sits in the site's top-level header, footer or navigation, i.e. a component
   * shared by every template. Shared problems get one site-wide ticket rather than one per template.
   */
  shared: boolean;
}

const PAGE_LEVEL = new Set(['html', 'head', 'title', 'document']);

/** Work out which component an engine selector's element belongs to. */
export async function describeComponent(page: Page, selector: string): Promise<ComponentInfo> {
  if (PAGE_LEVEL.has(selector.trim().toLowerCase())) return { path: 'html', shared: false };
  const info = await page
    .evaluate((selector) => {
      const CONTAINERS = new Set(['FORM', 'MAIN', 'ARTICLE', 'HEADER', 'FOOTER', 'NAV', 'ASIDE', 'SECTION', 'DIALOG']);
      const ROLES = new Set(['banner', 'contentinfo', 'navigation', 'main', 'complementary', 'form', 'search', 'dialog', 'region']);
      const SHARED_TAGS = new Set(['HEADER', 'FOOTER', 'NAV']);
      const SHARED_ROLES = new Set(['banner', 'contentinfo', 'navigation']);
      const el = document.querySelector(selector);
      if (!el) return null;
      const sig = (node: Element) => {
        const classes = [...node.classList].filter((c) => !/\d/.test(c)).sort();
        return node.tagName.toLowerCase() + (classes.length ? '.' + classes.join('.') : '');
      };
      const isContainer = (node: Element) => CONTAINERS.has(node.tagName) || ROLES.has(node.getAttribute('role') ?? '');
      // Nearest container at or above the element, stopping at <body>.
      let container: Element | null = el;
      while (container && container !== document.body && !isContainer(container)) container = container.parentElement;
      if (!container || container === document.documentElement) container = document.body;
      const chain: Element[] = [];
      for (let node: Element | null = container; node && node !== document.documentElement; node = node.parentElement) chain.unshift(node);
      // Shared if any ancestor in the chain is a header/footer/nav that isn't inside main content.
      let shared = false;
      for (const node of chain) {
        if (node.tagName === 'MAIN' || node.tagName === 'ARTICLE' || node.getAttribute('role') === 'main') break;
        if (SHARED_TAGS.has(node.tagName) || SHARED_ROLES.has(node.getAttribute('role') ?? '')) {
          shared = true;
          break;
        }
      }
      return { path: chain.map(sig).join('>'), shared };
    }, selector)
    .catch(() => null);
  return info ?? { path: `unresolved:${selector}`, shared: false };
}

/**
 * A page template in words: `/` is the home page, a template under /news/ (any address there) is
 * "pages under /news/", and a single page is its own address.
 */
export function templateName(templateKey: string): string {
  if (templateKey === '/') return 'home page';
  const star = templateKey.indexOf('*');
  if (star < 0) return templateKey;
  const prefix = templateKey.slice(0, star).replace(/[^/]*$/, '');
  if (prefix !== '/' && prefix) return `pages under ${prefix}`;
  // Only wildcards: say how deep the pages are.
  if (/\*\*/.test(templateKey)) return 'pages across the site';
  const depth = templateKey.split('/').filter(Boolean).length;
  return depth <= 1 ? 'top-level pages' : depth === 2 ? 'second-level pages' : 'deeper pages';
}

/** Human description of where a component is, for ticket titles. */
export function componentLabel(path: string, shared: boolean, templateKey: string | null): string {
  // Problems that belong to the whole site (a missing security header, colour drift).
  if (path.startsWith('site:')) return 'site-wide';
  if (shared) {
    if (/(^|>)header/.test(path)) return 'site header, every page';
    if (/(^|>)footer/.test(path)) return 'site footer, every page';
    if (/(^|>)nav/.test(path)) return 'site navigation, every page';
    return 'shared component, every page';
  }
  const where = templateKey ? templateName(templateKey) : 'page';
  const last = path.split('>').pop()?.split('.')[0];
  if (last === 'form') return `form on ${where}`;
  return where;
}
