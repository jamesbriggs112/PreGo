import { createRequire } from 'node:module';
import type { Severity } from '../../types.js';
import { checkTls, type TlsReport } from './tls.js';
import type { CheckFinding, CheckModule } from '../types.js';
import { guidanceFor } from '../guidance.js';

// Security headers, cookie flags and mixed content, read from each page's real response. Each problem
// is site-wide: one ticket listing the pages it was seen on.

const SEVERITY: Record<string, Severity> = {
  'no-https': 'High',
  'mixed-content': 'High',
  'missing-hsts': 'Medium',
  'missing-csp': 'Medium',
  'weak-csp': 'Low',
  'missing-frame-protection': 'Medium',
  'missing-referrer-policy': 'Low',
  'missing-permissions-policy': 'Low',
  'missing-nosniff': 'Low',
  'insecure-cookie': 'Medium',
  'server-version-disclosed': 'Low',
  'certificate-expired': 'High',
  'certificate-untrusted': 'High',
  'certificate-expiring': 'Medium',
};

// Google's CSP Evaluator (Apache-2.0), the same library Lighthouse uses.
const require = createRequire(import.meta.url);
const { CspParser } = require('csp_evaluator/dist/parser.js') as { CspParser: new (csp: string) => { csp: unknown } };
const { CspEvaluator } = require('csp_evaluator/dist/evaluator.js') as { CspEvaluator: new (csp: unknown) => { evaluate(): { severity: number; description: string; directive: string }[] } };
const CSP_HIGH = 10;
const CSP_SYNTAX = 20;

/** Serious weaknesses CSP Evaluator finds in a policy. */
export function evaluateCsp(csp: string): string[] {
  try {
    return new CspEvaluator(new CspParser(csp).csp)
      .evaluate()
      .filter((f) => f.severity === CSP_HIGH || f.severity === CSP_SYNTAX)
      .map((f) => `${f.directive}: ${f.description}`);
  } catch {
    return [];
  }
}

const LOCAL_HOST = /^(localhost|127\.\d+\.\d+\.\d+|\[::1\]|.+\.localhost|.+\.test)$/i;

export interface HeaderReport {
  url: string;
  headers: Record<string, string>;
  /** Raw Set-Cookie header values. */
  cookies: string[];
  /** Subresource URLs the page loaded (for mixed content). */
  resources: string[];
}

/** The security problems in one page's response. Exported so it can be tested without a browser. */
export function analyseHeaders({ url, headers, cookies, resources }: HeaderReport): { ruleId: string; detail: string }[] {
  const out: { ruleId: string; detail: string }[] = [];
  const page = new URL(url);
  const https = page.protocol === 'https:';
  const local = LOCAL_HOST.test(page.hostname);
  const h = (name: string) => headers[name.toLowerCase()];

  if (!https && !local) out.push({ ruleId: 'no-https', detail: `${url} is served over plain HTTP.` });
  if (https && !h('strict-transport-security')) out.push({ ruleId: 'missing-hsts', detail: 'No Strict-Transport-Security header.' });
  if (https) {
    const insecure = resources.filter((r) => r.startsWith('http:'));
    if (insecure.length) out.push({ ruleId: 'mixed-content', detail: `Loads ${insecure.length} resource(s) over plain HTTP, e.g. ${insecure[0]}.` });
  }

  const csp = h('content-security-policy');
  if (!csp) {
    out.push({ ruleId: 'missing-csp', detail: 'No Content-Security-Policy header.' });
  } else {
    const directive = (name: string) => csp.split(';').map((d) => d.trim()).find((d) => d.toLowerCase().startsWith(`${name} `));
    const scripts = directive('script-src') ?? directive('default-src');
    if (!scripts) out.push({ ruleId: 'weak-csp', detail: 'The Content-Security-Policy has no script-src or default-src, so it doesn’t restrict scripts.' });
    else if (/'unsafe-inline'|'unsafe-eval'|\s\*(\s|$)/.test(scripts)) out.push({ ruleId: 'weak-csp', detail: `The policy allows ${/'unsafe-eval'/.test(scripts) ? "'unsafe-eval'" : /'unsafe-inline'/.test(scripts) ? "'unsafe-inline'" : 'any source (*)'} for scripts: ${scripts}.` });
    else {
      const weaknesses = evaluateCsp(csp);
      if (weaknesses.length) out.push({ ruleId: 'weak-csp', detail: `CSP Evaluator found: ${weaknesses.slice(0, 3).join(' ')}` });
    }
  }
  const framing = h('x-frame-options') || (csp && /frame-ancestors/i.test(csp));
  if (!framing) out.push({ ruleId: 'missing-frame-protection', detail: 'Neither X-Frame-Options nor a CSP frame-ancestors directive is set.' });
  if (!h('referrer-policy')) out.push({ ruleId: 'missing-referrer-policy', detail: 'No Referrer-Policy header.' });
  if (!h('permissions-policy')) out.push({ ruleId: 'missing-permissions-policy', detail: 'No Permissions-Policy header.' });
  if ((h('x-content-type-options') ?? '').toLowerCase() !== 'nosniff') out.push({ ruleId: 'missing-nosniff', detail: 'X-Content-Type-Options is not set to nosniff.' });

  for (const cookie of cookies) {
    const [nameValue, ...attributes] = cookie.split(';').map((p) => p.trim());
    const name = nameValue.split('=')[0];
    const has = (attr: string) => attributes.some((a) => a.toLowerCase().startsWith(attr));
    const missing = [https && !has('secure') && 'Secure', !has('httponly') && 'HttpOnly', !has('samesite') && 'SameSite'].filter(Boolean);
    if (missing.length) out.push({ ruleId: 'insecure-cookie', detail: `Cookie “${name}” is set without ${missing.join(', ')}.` });
  }

  return out.concat(serverDisclosure(h));
}

function serverDisclosure(h: (name: string) => string | undefined): { ruleId: string; detail: string }[] {
  const out: { ruleId: string; detail: string }[] = [];
  const server = [h('server'), h('x-powered-by'), h('x-aspnet-version')].filter((v): v is string => !!v && /\d/.test(v));
  if (server.length) out.push({ ruleId: 'server-version-disclosed', detail: `Headers reveal software versions: ${server.join(', ')}.` });
  return out;
}

/** Certificate and protocol problems, from one ordinary connection (plus one trying older protocols). */
export function analyseTls(report: TlsReport, now = new Date()): { ruleId: string; detail: string }[] {
  const out: { ruleId: string; detail: string }[] = [];
  if (report.validTo) {
    const days = Math.floor((report.validTo.getTime() - now.getTime()) / 86_400_000);
    if (days < 0) out.push({ ruleId: 'certificate-expired', detail: `The certificate for ${report.host} expired on ${report.validTo.toISOString().slice(0, 10)}.` });
    else if (days < 30) out.push({ ruleId: 'certificate-expiring', detail: `The certificate for ${report.host} expires in ${days} day${days === 1 ? '' : 's'} (${report.validTo.toISOString().slice(0, 10)}).` });
  }
  if (!report.authorized && report.error && !/expired/i.test(report.error)) out.push({ ruleId: 'certificate-untrusted', detail: `Browsers won’t trust the certificate for ${report.host}: ${report.error}.` });
  return out;
}

export function securityModule(): CheckModule {
  let tlsChecked = false;
  return {
    id: 'security',
    name: 'Security headers',
    perViewport: false,
    async run({ page, location }) {
      // Explored screens and journey steps share the start page's response; check it once.
      if (location.kind === 'state' && location.depth > 1) return [];
      const url = page.url();
      const response = await page.context().request.get(url, { failOnStatusCode: false, maxRedirects: 5 });
      const headers = response.headers();
      const cookies = response
        .headersArray()
        .filter((h) => h.name.toLowerCase() === 'set-cookie')
        .map((h) => h.value);
      const resources = await page.evaluate(() => performance.getEntriesByType('resource').map((e) => e.name));
      const problems = analyseHeaders({ url, headers, cookies, resources });
      const page_ = new URL(url);
      if (!tlsChecked && page_.protocol === 'https:') {
        tlsChecked = true;
        const tls = await checkTls(page_.hostname, Number(page_.port) || 443).catch(() => null);
        if (tls) problems.push(...analyseTls(tls));
      }
      return problems.map(({ ruleId, detail }) => finding(ruleId, detail));
    },
  };
}

function finding(ruleId: string, failureSummary: string): CheckFinding {
  const guidance = guidanceFor('prego', ruleId)!;
  return {
    module: 'security',
    engine: 'prego',
    ruleId,
    category: 'SEC',
    severity: SEVERITY[ruleId],
    title: guidance.title,
    description: guidance.description,
    helpUrl: null,
    wcagCriteria: [],
    wcagLevel: null,
    selector: 'html',
    html: '<html>',
    failureSummary,
    siteWide: true,
    component: `security:${ruleId}`,
  };
}
