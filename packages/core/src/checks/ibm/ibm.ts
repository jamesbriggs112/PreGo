import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import type { Page } from 'playwright';
import type { CheckFinding, CheckModule } from '../types.js';

/** IBM's engine, bundled: injected into the page, so nothing is fetched from IBM. */
const ACE = join(dirname(createRequire(import.meta.url).resolve('accessibility-checker-engine/package.json')), 'ace.js');

interface IbmResult {
  ruleId: string;
  selector: string;
  html: string;
  message: string;
  criteria: string[];
  level: string | null;
}

/**
 * IBM Equal Access as an optional second accessibility engine (WCAG 2.2 ruleset). Only confirmed
 * violations are kept, and anything axe already reported on the same element for the same WCAG
 * criterion is dropped, so the second engine only adds what the first missed.
 */
export function ibmModule(): CheckModule {
  return {
    id: 'ibm',
    name: 'Accessibility, second engine (IBM Equal Access)',
    async run({ page }) {
      await page.addScriptTag({ path: ACE });
      const results = await page.evaluate(async (): Promise<IbmResult[]> => {
        type Ace = { Checker: new () => { check(doc: Document, rulesets: string[]): Promise<{ results: { ruleId: string; value: [string, string]; path: { dom: string }; message: string; snippet: string }[] }>; getGuidelines(): { id: string; checkpoints: { num: string; wcagLevel: string; rules?: { id: string }[] }[] }[] } };
        const ace = (window as unknown as { ace: Ace }).ace;
        const checker = new ace.Checker();
        const report = await checker.check(document, ['WCAG_2_2']);
        // Which WCAG criteria (and level) each rule belongs to.
        const criteria = new Map<string, { nums: string[]; levels: string[] }>();
        for (const cp of checker.getGuidelines().find((g) => g.id === 'WCAG_2_2')?.checkpoints ?? []) {
          for (const rule of cp.rules ?? []) {
            const entry = criteria.get(rule.id) ?? { nums: [], levels: [] };
            entry.nums.push(cp.num);
            entry.levels.push(cp.wcagLevel);
            criteria.set(rule.id, entry);
          }
        }
        const cssPath = (el: Element): string => {
          if (el === document.documentElement) return 'html';
          const parts: string[] = [];
          for (let node: Element | null = el; node && node !== document.documentElement; node = node.parentElement) {
            if (node.id && document.querySelectorAll(`#${CSS.escape(node.id)}`).length === 1) {
              parts.unshift(`#${CSS.escape(node.id)}`);
              break;
            }
            const same = node.parentElement ? [...node.parentElement.children].filter((c) => c.tagName === node!.tagName) : [];
            parts.unshift(same.length > 1 ? `${node.tagName.toLowerCase()}:nth-of-type(${same.indexOf(node) + 1})` : node.tagName.toLowerCase());
          }
          return parts.join(' > ');
        };
        return report.results
          .filter((r) => r.value[0] === 'VIOLATION' && r.value[1] === 'FAIL')
          .map((r) => {
            const el = document.evaluate(r.path.dom, document, null, XPathResult.FIRST_ORDERED_NODE_TYPE, null).singleNodeValue as Element | null;
            const c = criteria.get(r.ruleId);
            return {
              ruleId: r.ruleId,
              selector: el ? cssPath(el) : 'html',
              html: r.snippet.slice(0, 300),
              message: r.message,
              criteria: [...new Set(c?.nums ?? [])],
              level: c?.levels.includes('A') ? 'A' : (c?.levels[0] ?? null),
            };
          });
      });
      return results.map(
        (r): CheckFinding => ({
          module: 'ibm',
          engine: 'ibm',
          ruleId: r.ruleId,
          category: 'A11Y',
          severity: r.level === 'A' ? 'High' : 'Medium',
          title: r.message,
          description: r.message,
          helpUrl: `https://able.ibm.com/rules/archives/latest/doc/en-US/${r.ruleId}.html`,
          wcagCriteria: r.criteria,
          wcagLevel: r.level,
          selector: r.selector,
          html: r.html,
          failureSummary: r.message,
        }),
      );
    },
    dedupe: (page, own, others) => dropDuplicates(page, own, others.filter((f) => f.engine === 'axe-core')),
  };
}

/**
 * Drop findings that another engine already reported on the same element (or, for page-level
 * findings, the same page) for a shared WCAG criterion.
 */
export async function dropDuplicates(page: Page, own: CheckFinding[], others: CheckFinding[]): Promise<CheckFinding[]> {
  if (!own.length || !others.length) return own;
  const keep = await page.evaluate(
    ({ own, others }) => {
      const resolve = (selector: string): Element | null => {
        if (selector === 'html') return document.documentElement;
        try {
          return document.querySelector(selector);
        } catch {
          return null;
        }
      };
      const otherElements = others.map((o) => ({ el: resolve(o.selector), criteria: o.criteria }));
      return own.map((f) => {
        const el = resolve(f.selector);
        return !otherElements.some((o) => o.el && el && o.el === el && o.criteria.some((c) => f.criteria.includes(c)));
      });
    },
    { own: own.map((f) => ({ selector: f.selector, criteria: f.wcagCriteria })), others: others.map((o) => ({ selector: o.selector, criteria: o.wcagCriteria })) },
  );
  return own.filter((_, i) => keep[i]);
}
