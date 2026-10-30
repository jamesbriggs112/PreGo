import { createHash } from 'node:crypto';
import type { Page } from 'playwright';

export interface ScreenIdentity {
  /** Hash of the address (relative to the start origin) plus the normalised accessibility tree. */
  id: string;
  /** Address relative to the start origin, e.g. `/` or `/#/visit`. */
  path: string;
  /** Main heading, or the page title, for showing the screen to people. */
  title: string;
  /** Hash of the visible DOM, to tell "nothing happened" from a change the accessibility tree misses. */
  domHash: string;
}

const MASK_ATTRIBUTE = 'data-prego-masked';

/**
 * Identify the screen currently shown. Content inside `maskSelectors` (clocks, carousels, videos) is
 * hidden from the accessibility tree while it's read, so it can't make one screen look like many.
 */
export async function identifyScreen(page: Page, maskSelectors: string[] = []): Promise<ScreenIdentity> {
  const url = new URL(page.url());
  const path = `${url.pathname}${url.search}${url.hash}`;
  await page.evaluate(
    ({ selectors, attribute }) => {
      for (const selector of selectors) {
        try {
          for (const el of document.querySelectorAll(selector)) {
            el.setAttribute(attribute, el.getAttribute('aria-hidden') ?? '');
            el.setAttribute('aria-hidden', 'true');
          }
        } catch {
          // An invalid selector shouldn't stop exploration.
        }
      }
    },
    { selectors: maskSelectors, attribute: MASK_ATTRIBUTE },
  );
  try {
    const tree = normaliseTree(await page.ariaSnapshot());
    const { title, dom } = await page.evaluate((attribute) => {
      const heading = document.querySelector('h1, [role="heading"][aria-level="1"], h2');
      const clone = document.body.cloneNode(true) as HTMLElement;
      for (const el of clone.querySelectorAll(`[${attribute}], script, style, noscript`)) el.remove();
      return { title: (heading?.textContent ?? document.title).replace(/\s+/g, ' ').trim(), dom: clone.innerHTML };
    }, MASK_ATTRIBUTE);
    return {
      id: hash(`${path}\n${tree}`),
      path,
      title: title || path,
      domHash: hash(dom),
    };
  } finally {
    await page.evaluate((attribute) => {
      for (const el of document.querySelectorAll(`[${attribute}]`)) {
        const previous = el.getAttribute(attribute);
        if (previous) el.setAttribute('aria-hidden', previous);
        else el.removeAttribute('aria-hidden');
        el.removeAttribute(attribute);
      }
    }, MASK_ATTRIBUTE);
  }
}

/** Drop values that change without the screen changing: form field contents and live counters. */
export function normaliseTree(tree: string): string {
  return tree
    .split('\n')
    .map((line) => line.replace(/^(\s*- (?:textbox|searchbox|spinbutton|slider)\b[^:]*):.*$/, '$1'))
    .join('\n');
}

function hash(text: string): string {
  return createHash('sha1').update(text).digest('hex').slice(0, 16);
}
