import { averagePerformance } from '../checks/lighthouse/lighthouse.js';
import { checkedCategories } from '../checks/categories.js';
import type { AccessibilityStatementInfo } from '../profile/profile.js';
import type { ExportPlan } from './plan.js';
import { assessReadiness } from './readiness.js';

// What the site does well, from checks that passed and good measurements. Only what the data
// supports, each with its evidence, and only from checks that ran.

export interface Strength {
  /** The strength in a short sentence: "Pages load quickly". */
  text: string;
  /** What shows it: "Average Lighthouse performance score of 90". */
  evidence: string;
}

const MAX_STRENGTHS = 6;

export function strengths(plan: Pick<ExportPlan, 'tickets' | 'locations' | 'run'>, now = new Date()): Strength[] {
  const out: Strength[] = [];
  const ran = new Set(((plan.run.settings.modules as { id: string }[] | undefined) ?? []).map((m) => m.id));
  const checked = checkedCategories(plan.run.settings);
  const has = (...rules: string[]) => plan.tickets.some((t) => rules.includes(t.ruleId));
  const pages = plan.locations.filter((l) => l.kind === 'page' && l.audited);

  const performance = averagePerformance(plan.locations);
  if (performance !== null && performance >= 85) out.push({ text: 'Pages load quickly', evidence: `An average speed score of ${performance} out of 100.` });

  const start = String(plan.run.settings.startUrl ?? plan.run.target);
  if (checked.has('SEC') && /^https:/i.test(start) && !has('no-https', 'mixed-content', 'certificate-expired')) {
    out.push({ text: 'The site is served securely over HTTPS', evidence: 'Every page checked loaded over HTTPS, with no insecure files mixed in.' });
  }

  if (ran.has('links') && Number(plan.run.summary.brokenLinks ?? 0) === 0 && plan.run.mode === 'crawl') {
    out.push({ text: 'No broken links', evidence: `None of the links followed across ${pages.length} pages led to a missing page.` });
  }

  if (ran.has('axe') && pages.length && !has('html-has-lang', 'html-lang-valid', 'html_lang_exists')) {
    out.push({ text: 'Every page says what language it’s in', evidence: `All ${pages.length} pages checked set their language, so screen readers pronounce them correctly.` });
  }

  if (ran.has('a11y-custom') && pages.length && !has('skip-link-missing', 'skip_main_exists')) {
    out.push({ text: 'Keyboard users can skip straight to the content', evidence: 'Pages have a “skip to content” link or a marked main area.' });
  }

  const statement = plan.locations.map((l) => l.metrics.accessibilityStatement as AccessibilityStatementInfo | undefined).find((s) => s?.url && s.updated);
  if (statement?.updated && now.getTime() - Date.parse(statement.updated) < 365 * 86_400_000) {
    out.push({ text: 'The accessibility statement is up to date', evidence: `It was last reviewed on ${statement.updated}.` });
  }

  // The future-readiness checklist's passes: canonical addresses, AI crawlers, the sitemap and so on.
  for (const item of assessReadiness(plan.locations)?.items ?? []) {
    if (item.status === 'good') out.push({ text: item.area, evidence: item.found });
  }
  return out.slice(0, MAX_STRENGTHS);
}
