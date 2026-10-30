import { firefox, webkit, type Browser, type BrowserType, type Page } from 'playwright';
import type { BasicAuth } from '../../browser/session.js';
import { trackerName } from '../../browser/trackers.js';
import type { Severity } from '../../types.js';
import type { CheckFinding, CheckModule } from '../types.js';
import { guidanceFor } from '../guidance.js';

// Each template's first page, opened again in Firefox and in WebKit (Safari's engine) at the same
// window size, and compared with Chrome: script errors, sideways scrolling, controls and content that
// disappear, and elements that move or change width.

const ENGINES: { id: string; name: string; type: BrowserType }[] = [
  { id: 'firefox', name: 'Firefox', type: firefox },
  { id: 'webkit', name: 'Safari (WebKit)', type: webkit },
];

const RULES: Record<string, Severity> = {
  'browser-script-error': 'Medium',
  'browser-horizontal-scroll': 'Medium',
  'browser-element-missing': 'Medium',
  'browser-layout-differs': 'Low',
};

const MAX_TEMPLATES = 20;

export interface LayoutSnapshot {
  scrollWidth: number;
  clientWidth: number;
  elements: Record<string, { x: number; w: number; visible: boolean; label: string }>;
}

/** Positions of the landmarks, headings, images and controls on a page, keyed by CSS path. */
export async function snapshotLayout(page: Page): Promise<LayoutSnapshot> {
  return page.evaluate(() => {
    const path = (el: Element): string => {
      const parts: string[] = [];
      for (let node: Element | null = el; node && node !== document.documentElement; node = node.parentElement) {
        if (node.id) {
          parts.unshift(`#${CSS.escape(node.id)}`);
          break;
        }
        const same = node.parentElement ? [...node.parentElement.children].filter((c) => c.tagName === node!.tagName) : [];
        parts.unshift(same.length > 1 ? `${node.tagName.toLowerCase()}:nth-of-type(${same.indexOf(node) + 1})` : node.tagName.toLowerCase());
      }
      return parts.join(' > ');
    };
    const elements: LayoutSnapshot['elements'] = {};
    const candidates = document.querySelectorAll('header, nav, main, footer, h1, h2, form, button, [role="button"], input:not([type="hidden"]), select, textarea, img, video, iframe');
    for (const el of [...candidates].slice(0, 200)) {
      const rect = el.getBoundingClientRect();
      const style = getComputedStyle(el);
      const visible = rect.width > 0 && rect.height > 0 && style.visibility !== 'hidden' && style.display !== 'none' && Number(style.opacity) > 0;
      const label = (el.getAttribute('aria-label') ?? (el as HTMLElement).innerText ?? el.getAttribute('alt') ?? '').trim().replace(/\s+/g, ' ').slice(0, 40);
      elements[path(el)] = { x: Math.round(rect.x + scrollX), w: Math.round(rect.width), visible, label: label || el.tagName.toLowerCase() };
    }
    return { scrollWidth: document.documentElement.scrollWidth, clientWidth: document.documentElement.clientWidth, elements };
  });
}

/** How another engine's layout differs from Chrome's. Exported so it can be tested without browsers. */
export function compareLayouts(chrome: LayoutSnapshot, other: LayoutSnapshot): { ruleId: string; detail: string }[] {
  const out: { ruleId: string; detail: string }[] = [];
  const overflows = (s: LayoutSnapshot) => s.scrollWidth > s.clientWidth + 2;
  if (overflows(other) && !overflows(chrome)) out.push({ ruleId: 'browser-horizontal-scroll', detail: `The page is ${other.scrollWidth}px wide in a ${other.clientWidth}px window, so it scrolls sideways.` });

  const missing: string[] = [];
  const moved: string[] = [];
  for (const [key, el] of Object.entries(chrome.elements)) {
    if (!el.visible) continue;
    const there = other.elements[key];
    if (!there || !there.visible) {
      missing.push(`“${el.label}” (${key})`);
      continue;
    }
    const widthChange = Math.abs(there.w - el.w);
    if (Math.abs(there.x - el.x) > 40 || (widthChange > 40 && widthChange > el.w * 0.3)) moved.push(`“${el.label}” (${key}): ${el.w}px wide at x=${el.x} in Chrome, ${there.w}px at x=${there.x}`);
  }
  const list = (items: string[]) => items.slice(0, 5).join('; ') + (items.length > 5 ? `; and ${items.length - 5} more` : '');
  if (missing.length) out.push({ ruleId: 'browser-element-missing', detail: `${missing.length} element${missing.length === 1 ? '' : 's'} visible in Chrome ${missing.length === 1 ? 'is' : 'are'} missing or hidden: ${list(missing)}.` });
  if (moved.length) out.push({ ruleId: 'browser-layout-differs', detail: `${moved.length} element${moved.length === 1 ? '' : 's'} sit${moved.length === 1 ? 's' : ''} differently from Chrome: ${list(moved)}.` });
  return out;
}

export function browsersModule(options: { basicAuth?: BasicAuth; onRequest?: (url: string) => void } = {}): CheckModule {
  const launched = new Map<string, Promise<Browser>>();
  const templates = new Set<string>();

  return {
    id: 'browsers',
    name: 'Firefox and Safari',
    perViewport: false,
    async run({ page, location }) {
      const url = page.url();
      if (!/^https?:/.test(url) || (location.kind === 'state' && location.depth > 1)) return [];
      const template = location.templateKey ?? location.url;
      if (templates.has(template) || templates.size >= MAX_TEMPLATES) return [];
      templates.add(template);

      const chrome = await snapshotLayout(page);
      const size = page.viewportSize() ?? { width: 1280, height: 800 };
      const out: CheckFinding[] = [];
      for (const engine of ENGINES) {
        if (!launched.has(engine.id)) launched.set(engine.id, engine.type.launch({ headless: true }));
        const browser = await launched.get(engine.id)!;
        const context = await browser.newContext({
          viewport: size,
          ignoreHTTPSErrors: true,
          httpCredentials: options.basicAuth ? { ...options.basicAuth, origin: new URL(url).origin, send: 'unauthorized' } : undefined,
        });
        try {
          // Firefox and WebKit can't take Chromium's resolver rules, so trackers are blocked here instead.
          await context.route('**/*', (route) => {
            const requestUrl = route.request().url();
            let host = '';
            try {
              host = new URL(requestUrl).hostname;
            } catch {
              // data: and blob: URLs
            }
            if (trackerName(host)) return route.abort('blockedbyclient');
            options.onRequest?.(requestUrl);
            return route.continue();
          });
          const other = await context.newPage();
          const errors: string[] = [];
          other.on('pageerror', (error) => errors.push(error.message.split('\n')[0]));
          await other.goto(url, { waitUntil: 'load', timeout: 30_000 });
          await other.waitForLoadState('networkidle', { timeout: 3_000 }).catch(() => undefined);
          for (const message of [...new Set(errors)].slice(0, 3)) out.push(finding('browser-script-error', engine, `A script fails in ${engine.name}: ${message}`));
          for (const { ruleId, detail } of compareLayouts(chrome, await snapshotLayout(other))) out.push(finding(ruleId, engine, `In ${engine.name}: ${detail}`));
        } catch (error) {
          out.push(finding('browser-script-error', engine, `The page couldn’t be loaded in ${engine.name}: ${error instanceof Error ? error.message.split('\n')[0] : error}`));
        } finally {
          await context.close();
        }
      }
      return out;
    },
    async close() {
      for (const browser of launched.values()) await (await browser.catch(() => null))?.close();
      launched.clear();
    },
  };
}

function finding(ruleId: string, engine: { id: string; name: string }, failureSummary: string): CheckFinding {
  const guidance = guidanceFor('prego', ruleId)!;
  return {
    module: 'browsers',
    engine: 'prego',
    ruleId,
    category: 'UX',
    severity: RULES[ruleId],
    title: `${guidance.title} in ${engine.name}`,
    description: guidance.description,
    helpUrl: null,
    wcagCriteria: [],
    wcagLevel: null,
    selector: 'html',
    html: '<html>',
    failureSummary,
    component: `browsers:${engine.id}:${ruleId}`,
  };
}
