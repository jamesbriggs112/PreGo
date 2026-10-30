import type { CheckFinding, CheckModule } from '../types.js';
import { guidanceFor } from '../guidance.js';

export interface CanvasModuleOptions {
  /** Share of the viewport a canvas must cover to be flagged. Default 0.4 (40%). */
  threshold?: number;
}

/**
 * Flag <canvas> elements (2D or WebGL) that cover a large part of the screen. Nothing drawn in a
 * canvas can be read by accessibility engines or assistive technology, so the content needs a human
 * to check it. Prego says so, with a screenshot, rather than reporting the screen as fine.
 */
export function canvasModule(options: CanvasModuleOptions = {}): CheckModule {
  const threshold = options.threshold ?? 0.4;
  return {
    id: 'canvas',
    name: 'Canvas and WebGL detection',
    async run({ page }) {
      const canvases = await page.evaluate(() => {
        const viewport = window.innerWidth * window.innerHeight;
        const path = (el: Element): string => {
          if (el.id) return `#${CSS.escape(el.id)}`;
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
        return [...document.querySelectorAll('canvas')].map((canvas) => {
          const r = canvas.getBoundingClientRect();
          // The part of the canvas inside the viewport.
          const visible = Math.max(0, Math.min(r.right, innerWidth) - Math.max(r.left, 0)) * Math.max(0, Math.min(r.bottom, innerHeight) - Math.max(r.top, 0));
          const label = canvas.getAttribute('aria-label') || canvas.getAttribute('aria-labelledby') || canvas.getAttribute('title');
          return {
            selector: path(canvas),
            html: canvas.outerHTML.replace(/>[\s\S]*$/, '>'),
            coverage: viewport ? visible / viewport : 0,
            hasName: !!label,
            hasFallback: canvas.textContent!.trim().length > 0 || canvas.children.length > 0,
            hidden: canvas.getAttribute('aria-hidden') === 'true',
          };
        });
      });
      const guidance = guidanceFor('prego', 'canvas-content')!;
      return canvases
        .filter((c) => c.coverage > threshold)
        .map(
          (c): CheckFinding => ({
            module: 'canvas',
            engine: 'prego',
            ruleId: 'canvas-content',
            category: 'A11Y',
            severity: 'Medium',
            title: guidance.title,
            description: guidance.description,
            helpUrl: null,
            wcagCriteria: [],
            wcagLevel: null,
            selector: c.selector,
            html: c.html,
            failureSummary: [
              `A canvas covers ${Math.round(c.coverage * 100)}% of the screen.`,
              c.hidden ? 'It is hidden from assistive technology (aria-hidden), so its content must be available another way.' : c.hasName ? 'It has an accessible name, but its content is still not readable.' : 'It has no accessible name.',
              c.hasFallback ? 'It has fallback content inside the element.' : 'It has no fallback content.',
              'Manual review required.',
            ].join(' '),
          }),
        );
    },
  };
}
