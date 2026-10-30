import { AxeBuilder } from '@axe-core/playwright';
import type { ImpactValue, Result } from 'axe-core';
import type { Severity } from '../../types.js';
import type { CheckFinding, CheckModule } from '../types.js';
import { guidanceFor } from '../guidance.js';

/** WCAG 2.2 A and AA rules, plus axe best practices (which include skipped heading levels). */
export const AXE_TAGS = ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22a', 'wcag22aa', 'best-practice'];

const SEVERITY_BY_IMPACT: Record<NonNullable<ImpactValue>, Severity> = {
  critical: 'Critical',
  serious: 'High',
  moderate: 'Medium',
  minor: 'Low',
};

const MAX_HTML_LENGTH = 500;

export interface AxeModuleOptions {
  tags?: string[];
  /** Rule IDs to switch off, e.g. for known false positives on a project. */
  disableRules?: string[];
}

export function axeModule(options: AxeModuleOptions = {}): CheckModule {
  return {
    id: 'axe',
    name: 'Accessibility (axe-core)',
    async run({ page }) {
      let builder = new AxeBuilder({ page }).withTags(options.tags ?? AXE_TAGS);
      if (options.disableRules?.length) builder = builder.disableRules(options.disableRules);
      const results = await builder.analyze();
      return results.violations.flatMap((violation) => toFindings(violation));
    },
  };
}

function toFindings(violation: Result): CheckFinding[] {
  const { criteria, level } = wcagFromTags(violation.tags);
  const guidance = guidanceFor('axe-core', violation.id);
  return violation.nodes.map((node) => ({
    module: 'axe',
    engine: 'axe-core',
    ruleId: violation.id,
    category: 'A11Y',
    severity: SEVERITY_BY_IMPACT[node.impact ?? violation.impact ?? 'moderate'],
    title: guidance?.title ?? violation.help,
    description: guidance?.description ?? violation.description,
    helpUrl: violation.helpUrl ?? null,
    wcagCriteria: criteria,
    wcagLevel: level,
    // Targets inside iframes or shadow roots are lists of selectors; join them for display.
    selector: node.target.map((t) => (Array.isArray(t) ? t.join(' ') : t)).join(' '),
    html: node.html.length > MAX_HTML_LENGTH ? `${node.html.slice(0, MAX_HTML_LENGTH)}…` : node.html,
    failureSummary: node.failureSummary ?? null,
  }));
}

/** `wcag143` → `1.4.3`; level from `wcag2aa`, `wcag21a` and so on. */
export function wcagFromTags(tags: string[]): { criteria: string[]; level: string | null } {
  const criteria = tags
    .map((tag) => /^wcag(\d)(\d)(\d+)$/.exec(tag))
    .filter((m): m is RegExpExecArray => m !== null)
    .map(([, a, b, c]) => `${a}.${b}.${c}`);
  const levels = tags.map((tag) => /^wcag2\d?(a{1,3})$/.exec(tag)?.[1]).filter(Boolean) as string[];
  const level = levels.length ? levels.sort((x, y) => x.length - y.length)[0].toUpperCase() : null;
  return { criteria, level };
}
