import { HtmlValidate } from 'html-validate';
import type { CheckFinding, CheckModule } from '../types.js';

/** Most messages reported per page, so one broken template can't produce thousands. */
const MAX_PER_PAGE = 50;

/**
 * HTML validity with html-validate's standard preset: conformance to the HTML standard only (its
 * accessibility rules are left to axe). Pages are validated as served, not as the browser repaired them.
 */
export function markupModule(): CheckModule {
  const validator = new HtmlValidate({ extends: ['html-validate:standard'] });
  return {
    id: 'html',
    name: 'HTML validity',
    perViewport: false,
    async run({ page, location }) {
      let html: string;
      if (location.kind === 'page') {
        const response = await page.context().request.get(page.url(), { failOnStatusCode: false });
        if (!/html/i.test(response.headers()['content-type'] ?? 'text/html')) return [];
        html = await response.text();
      } else {
        // Interactive screens are built in the browser, so their markup is the live DOM.
        html = await page.content();
      }
      const report = await validator.validateString(html, location.url);
      // The HTML standard doesn't require a title on <iframe>: that's an accessibility matter, which axe
      // checks on frames people can see (not ones inside <noscript>, such as Google Tag Manager's).
      const messages = (report.results[0]?.messages ?? []).filter((m) => !(m.ruleId === 'element-required-attributes' && /<iframe> is missing required "title"/.test(m.message)));
      return messages.slice(0, MAX_PER_PAGE).map(
        (m): CheckFinding => ({
          module: 'html',
          engine: 'html-validate',
          ruleId: m.ruleId,
          category: 'TECH',
          severity: m.severity === 2 ? 'Medium' : 'Low',
          title: `Invalid HTML: ${m.message.replace(/: use CSS instead$/, '')}`,
          description: m.message,
          helpUrl: m.ruleUrl ?? null,
          wcagCriteria: [],
          wcagLevel: null,
          selector: m.selector ?? 'html',
          html: html.split('\n')[m.line - 1]?.trim().slice(0, 200) ?? '',
          failureSummary: `Line ${m.line}, column ${m.column}: ${m.message}`,
        }),
      );
    },
  };
}
