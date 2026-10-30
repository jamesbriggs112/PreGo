import type { Page } from 'playwright';
import type { Severity } from '../../types.js';
import type { CheckContext, CheckFinding, CheckModule, LocatedFinding } from '../types.js';
import { guidanceFor } from '../guidance.js';

// Accessibility checks axe-core can't do from a static snapshot: they press keys, resize the page or
// change its styles. Each one restores the page afterwards so later modules see it unchanged.

interface Rule {
  severity: Severity;
  wcag: string[];
  level: string | null;
}

const RULES: Record<string, Rule> = {
  'keyboard-trap': { severity: 'Critical', wcag: ['2.1.2'], level: 'A' },
  'focus-not-visible': { severity: 'High', wcag: ['2.4.7'], level: 'AA' },
  reflow: { severity: 'Medium', wcag: ['1.4.10'], level: 'AA' },
  'zoom-text-clipped': { severity: 'High', wcag: ['1.4.4'], level: 'AA' },
  'text-spacing': { severity: 'Medium', wcag: ['1.4.12'], level: 'AA' },
  'target-size-touch': { severity: 'Low', wcag: ['2.5.5'], level: 'AAA' },
  'skip-link-missing': { severity: 'Medium', wcag: ['2.4.1'], level: 'A' },
  'skip-link-broken': { severity: 'Medium', wcag: ['2.4.1'], level: 'A' },
  'multiple-h1': { severity: 'Low', wcag: [], level: null },
  'no-landmarks': { severity: 'Medium', wcag: ['1.3.1'], level: 'A' },
  'duplicate-title': { severity: 'Medium', wcag: ['2.4.2'], level: 'A' },
};

function finding(ruleId: keyof typeof RULES, selector: string, html: string, failureSummary: string, extra: Partial<CheckFinding> = {}): CheckFinding {
  const rule = RULES[ruleId];
  const guidance = guidanceFor('prego', ruleId)!;
  return {
    module: 'a11y-custom',
    engine: 'prego',
    ruleId,
    category: 'A11Y',
    severity: rule.severity,
    title: guidance.title,
    description: guidance.description,
    helpUrl: null,
    wcagCriteria: rule.wcag,
    wcagLevel: rule.level,
    selector,
    html,
    failureSummary,
    ...extra,
  };
}

/** Code shared by the in-page checks: a unique selector and a short HTML snippet for an element. */
const HELPERS = `
  window.__pregoPath = (el) => {
    if (el.id && document.querySelectorAll('#' + CSS.escape(el.id)).length === 1) return '#' + CSS.escape(el.id);
    const parts = [];
    for (let node = el; node && node !== document.documentElement; node = node.parentElement) {
      if (node.id && document.querySelectorAll('#' + CSS.escape(node.id)).length === 1) { parts.unshift('#' + CSS.escape(node.id)); break; }
      const same = node.parentElement ? [...node.parentElement.children].filter((c) => c.tagName === node.tagName) : [];
      parts.unshift(same.length > 1 ? node.tagName.toLowerCase() + ':nth-of-type(' + (same.indexOf(node) + 1) + ')' : node.tagName.toLowerCase());
    }
    return parts.join(' > ');
  };
  window.__pregoSnippet = (el) => el.outerHTML.length > 200 ? el.outerHTML.slice(0, 200) + '…' : el.outerHTML;
`;

const FOCUSABLE = 'a[href], button:not([disabled]), input:not([disabled]):not([type="hidden"]), select:not([disabled]), textarea:not([disabled]), summary, [tabindex]:not([tabindex="-1"]), [contenteditable="true"]';

export interface CustomA11yOptions {
  /** Most Tab presses when walking the focus order. Default 60. */
  maxTabs?: number;
}

export function customA11yModule(options: CustomA11yOptions = {}): CheckModule {
  const titles: { locationId: number; url: string; title: string; viewport: string; kind: string }[] = [];
  return {
    id: 'a11y-custom',
    name: 'Custom accessibility checks',
    async run(context) {
      const { page } = context;
      await page.evaluate(HELPERS);
      const findings: CheckFinding[] = [];
      if (context.touch) findings.push(...(await targetSize(page)));
      // Everything else is about the page, not the screen size, so it runs once.
      if (!context.firstViewport) return findings;
      titles.push({ locationId: context.location.id, url: context.location.url, title: (await page.title()).trim(), viewport: context.viewport, kind: context.location.kind });
      findings.push(...(await structure(page)));
      findings.push(...(await keyboard(page, options.maxTabs ?? 60)));
      findings.push(...(await clipping(page, context)));
      findings.push(...(await reflow(page)));
      return findings;
    },
    async finish() {
      // Pages (not interactive screens, which share one title by design) with the same title.
      const byTitle = new Map<string, typeof titles>();
      for (const t of titles.filter((t) => t.kind === 'page' && t.title)) {
        const key = t.title.toLowerCase();
        byTitle.set(key, [...(byTitle.get(key) ?? []), t]);
      }
      const out: LocatedFinding[] = [];
      for (const group of byTitle.values()) {
        if (new Set(group.map((g) => g.url)).size < 2) continue;
        for (const page of group) {
          out.push({
            ...finding('duplicate-title', 'title', `<title>${page.title}</title>`, `${group.length} pages share the title “${page.title}”: ${group.map((g) => new URL(g.url).pathname).join(', ')}.`, {
              siteWide: true,
              component: `title:${page.title.toLowerCase()}`,
            }),
            locationId: page.locationId,
            viewport: page.viewport,
          });
        }
      }
      return out;
    },
  };
}

/** Skip link, main headings and landmarks: read from the page as it is. */
async function structure(page: Page): Promise<CheckFinding[]> {
  const result = await page.evaluate((focusable) => {
    const w = window as unknown as { __pregoPath: (el: Element) => string; __pregoSnippet: (el: Element) => string };
    const visible = (el: Element) => {
      const r = el.getBoundingClientRect();
      const s = getComputedStyle(el);
      return s.display !== 'none' && s.visibility !== 'hidden' && (r.width > 0 || r.height > 0 || el.matches('a[href^="#"]'));
    };
    const main = document.querySelector('main, [role="main"]') ?? document.querySelector('h1');
    const tabbable = [...document.querySelectorAll(focusable)].filter((el) => visible(el) && !el.closest('[inert], [aria-hidden="true"]'));
    const before = main ? tabbable.filter((el) => !main.contains(el) && el.compareDocumentPosition(main) & Node.DOCUMENT_POSITION_FOLLOWING) : [];
    const first = tabbable[0];
    const skipHref = first instanceof HTMLAnchorElement && first.getAttribute('href')?.startsWith('#') ? first.getAttribute('href')! : null;
    const skipTarget = skipHref && skipHref.length > 1 ? document.getElementById(decodeURIComponent(skipHref.slice(1))) : null;
    const h1s = [...document.querySelectorAll('h1')].filter(visible);
    const landmarks = document.querySelectorAll('main, nav, header, footer, aside, [role="main"], [role="navigation"], [role="banner"], [role="contentinfo"], [role="complementary"], [role="region"], [role="search"], form[aria-label], form[aria-labelledby]');
    return {
      linksBefore: before.length,
      skip: skipHref ? { ok: !!skipTarget, selector: w.__pregoPath(first), html: w.__pregoSnippet(first), href: skipHref } : null,
      extraH1s: h1s.slice(1).map((h) => ({ selector: w.__pregoPath(h), html: w.__pregoSnippet(h), text: (h.textContent ?? '').trim() })),
      h1Count: h1s.length,
      landmarks: landmarks.length,
    };
  }, FOCUSABLE);

  const out: CheckFinding[] = [];
  if (result.skip && !result.skip.ok) {
    out.push(finding('skip-link-broken', result.skip.selector, result.skip.html, `The first link goes to ${result.skip.href}, but nothing on the page has that ID.`));
  } else if (!result.skip && result.linksBefore >= 3) {
    out.push(finding('skip-link-missing', 'html', '<html>', `${result.linksBefore} links and controls come before the main content, and the first one isn’t a skip link.`));
  }
  for (const h of result.extraH1s) out.push(finding('multiple-h1', h.selector, h.html, `The page has ${result.h1Count} main headings (h1). This one says “${h.text}”.`));
  if (result.landmarks === 0) out.push(finding('no-landmarks', 'html', '<html>', 'The page has no header, navigation, main or footer landmarks.'));
  return out;
}

/** Walk the focus order with Tab: find keyboard traps and focus with no visible indicator. */
async function keyboard(page: Page, maxTabs: number): Promise<CheckFinding[]> {
  const total = await page.evaluate((focusable) => document.querySelectorAll(focusable).length, FOCUSABLE);
  if (total === 0) return [];
  await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
  await page.locator('body').focus().catch(() => undefined);
  const visited: string[] = [];
  const out: CheckFinding[] = [];
  const reported = new Set<string>();
  let stuck = 0;
  try {
    for (let i = 0; i < Math.min(maxTabs, total + 3); i++) {
      await page.keyboard.press('Tab');
      const state = await page.evaluate(() => {
        const w = window as unknown as { __pregoPath: (el: Element) => string; __pregoSnippet: (el: Element) => string };
        const el = document.activeElement;
        if (!el || el === document.body) return null;
        const props = ['outline-style', 'outline-width', 'outline-color', 'box-shadow', 'background-color', 'color', 'border-top-color', 'border-bottom-color', 'text-decoration-line', 'transform'];
        const read = () => {
          const s = getComputedStyle(el);
          return props.map((p) => s.getPropertyValue(p)).join('|');
        };
        const focused = read();
        const outline = getComputedStyle(el);
        const hasOutline = outline.outlineStyle !== 'none' && parseFloat(outline.outlineWidth) > 0;
        (el as HTMLElement).blur();
        const unfocused = read();
        (el as HTMLElement).focus({ preventScroll: true });
        return { selector: w.__pregoPath(el), html: w.__pregoSnippet(el), visibleFocus: hasOutline || focused !== unfocused };
      });
      if (!state) continue;
      if (visited.at(-1) === state.selector) {
        stuck++;
        if (stuck >= 2 && new Set(visited).size < total) {
          out.push(finding('keyboard-trap', state.selector, state.html, 'Pressing Tab three times left focus on this element: keyboard users can’t move past it.'));
          break;
        }
      } else {
        stuck = 0;
      }
      visited.push(state.selector);
      if (!state.visibleFocus && !reported.has(state.selector)) {
        reported.add(state.selector);
        out.push(finding('focus-not-visible', state.selector, state.html, 'Nothing about this element’s appearance changes when it has keyboard focus.'));
      }
    }
  } finally {
    await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur()).catch(() => undefined);
  }
  return out;
}

/** Elements whose text is cut off, as selector → snippet. */
async function clippedElements(page: Page): Promise<Map<string, string>> {
  const list = await page.evaluate(() => {
    const w = window as unknown as { __pregoPath: (el: Element) => string; __pregoSnippet: (el: Element) => string };
    const out: [string, string][] = [];
    for (const el of document.body.querySelectorAll('*')) {
      if (!(el instanceof HTMLElement) || !el.innerText?.trim()) continue;
      const s = getComputedStyle(el);
      const hidesX = ['hidden', 'clip'].includes(s.overflowX);
      const hidesY = ['hidden', 'clip'].includes(s.overflowY);
      if (!hidesX && !hidesY) continue;
      const overflows = (hidesX && el.scrollWidth > el.clientWidth + 1) || (hidesY && el.scrollHeight > el.clientHeight + 1);
      // Buttons don't report overflow through scroll sizes, so also compare where the text renders.
      const box = el.getBoundingClientRect();
      const range = document.createRange();
      range.selectNodeContents(el);
      const text = range.getBoundingClientRect();
      const spills = (hidesY && (text.top < box.top - 1 || text.bottom > box.bottom + 1)) || (hidesX && (text.left < box.left - 1 || text.right > box.right + 1));
      if (overflows || spills) out.push([w.__pregoPath(el), w.__pregoSnippet(el)]);
    }
    return out;
  });
  return new Map(list);
}

/** Text cut off at 200% zoom, or when text spacing is increased: only what wasn't already cut off. */
async function clipping(page: Page, context: CheckContext): Promise<CheckFinding[]> {
  const out: CheckFinding[] = [];
  const before = await clippedElements(page);
  const size = page.viewportSize();

  // WCAG 1.4.12 text spacing.
  await page.addStyleTag({ content: '* { line-height: 1.5 !important; letter-spacing: 0.12em !important; word-spacing: 0.16em !important; } p { margin-bottom: 2em !important; }' }).then(async (handle) => {
    for (const [selector, html] of await clippedElements(page)) {
      if (!before.has(selector)) out.push(finding('text-spacing', selector, html, 'Text is cut off when line, letter and word spacing are increased to the WCAG 1.4.12 values.'));
    }
    await handle.evaluate((el) => (el as Element).remove());
  });

  // WCAG 1.4.4: 200% zoom is the same CSS layout as half the viewport.
  if (size && size.width >= 640) {
    await page.setViewportSize({ width: Math.round(size.width / 2), height: Math.round(size.height / 2) });
    await settleLayout(page);
    for (const [selector, html] of await clippedElements(page)) {
      if (!before.has(selector)) out.push(finding('zoom-text-clipped', selector, html, `Text is cut off at 200% zoom (a ${Math.round(size.width / 2)}px-wide layout on the ${context.viewport} viewport).`));
    }
    await page.setViewportSize(size);
    await settleLayout(page);
  }
  return out;
}

/** WCAG 1.4.10: no horizontal scrolling at 320 CSS pixels wide. Reports the widest offenders. */
async function reflow(page: Page): Promise<CheckFinding[]> {
  const size = page.viewportSize();
  if (!size) return [];
  await page.setViewportSize({ width: 320, height: 256 });
  await settleLayout(page);
  try {
    const offenders = await page.evaluate(() => {
      const w = window as unknown as { __pregoPath: (el: Element) => string; __pregoSnippet: (el: Element) => string };
      if (document.documentElement.scrollWidth <= window.innerWidth + 1) return [];
      // Content that may scroll in two dimensions under WCAG's exceptions.
      const EXEMPT = 'table, pre, code, canvas, video, iframe, map, svg, [role="grid"], [role="application"]';
      const wide = [...document.body.querySelectorAll('*')].filter((el) => {
        const r = el.getBoundingClientRect();
        return r.width > window.innerWidth + 1 && r.right > window.innerWidth + 1 && !el.closest(EXEMPT);
      });
      // The innermost wide elements are the cause; their ancestors are only stretched by them.
      return wide
        .filter((el) => !wide.some((other) => other !== el && el.contains(other)))
        .slice(0, 5)
        .map((el) => ({ selector: w.__pregoPath(el), html: w.__pregoSnippet(el), width: Math.round(el.getBoundingClientRect().width) }));
    });
    return offenders.map((o) => finding('reflow', o.selector, o.html, `At 320 pixels wide this element is ${o.width}px wide, so the page scrolls sideways.`));
  } finally {
    await page.setViewportSize(size);
    await settleLayout(page);
  }
}

/** On touch screens: controls smaller than 44 × 44 CSS pixels (inline links in text are exempt). */
async function targetSize(page: Page): Promise<CheckFinding[]> {
  const small = await page.evaluate(() => {
    const w = window as unknown as { __pregoPath: (el: Element) => string; __pregoSnippet: (el: Element) => string };
    const controls = document.querySelectorAll('a[href], button, input:not([type="hidden"]), select, [role="button"], [role="link"], [role="checkbox"], [role="tab"]');
    const out: { selector: string; html: string; width: number; height: number }[] = [];
    for (const el of controls) {
      const r = el.getBoundingClientRect();
      if (r.width === 0 || r.height === 0 || getComputedStyle(el).visibility === 'hidden') continue;
      // Off-screen until focused (skip links) or scrolled away sideways: not a tap target.
      if (r.right <= 0 || r.left >= window.innerWidth) continue;
      if (r.width >= 44 && r.height >= 44) continue;
      // Exempt: links within a sentence, and checkboxes or radios whose label is also tappable.
      const parent = el.parentElement;
      if (el.tagName === 'A' && parent && ['P', 'LI', 'TD', 'SPAN'].includes(parent.tagName) && (parent.textContent ?? '').trim().length > (el.textContent ?? '').trim().length + 10) continue;
      if (el instanceof HTMLInputElement && ['checkbox', 'radio'].includes(el.type) && el.labels?.length) continue;
      out.push({ selector: w.__pregoPath(el), html: w.__pregoSnippet(el), width: Math.round(r.width), height: Math.round(r.height) });
    }
    return out;
  });
  return small.map((s) => finding('target-size-touch', s.selector, s.html, `This control is ${s.width} × ${s.height} pixels; touch targets should be at least 44 × 44.`));
}

/**
 * Apply a resize or style change. Reading layout makes the browser recalculate styles and media
 * queries straight away, so there is no need to wait (timers may be frozen on explored screens).
 */
async function settleLayout(page: Page) {
  await page.evaluate(() => document.documentElement.getBoundingClientRect().width);
}
