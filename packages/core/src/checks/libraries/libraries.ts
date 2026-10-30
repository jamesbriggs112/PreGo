import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Severity } from '../../types.js';
import type { CheckFinding, CheckModule } from '../types.js';
import { guidanceFor } from '../guidance.js';

// Outdated JavaScript libraries with published vulnerabilities, found with Retire.js (Apache-2.0)
// in the scripts each page already loads. The database is a local copy (npm run update:retire-db).

interface Vulnerability {
  below: string;
  atOrAbove?: string;
  severity: 'none' | 'low' | 'medium' | 'high' | 'critical';
  identifiers: { CVE?: string[]; summary?: string; githubID?: string };
  info: string[];
}
interface Component {
  component: string;
  version: string;
  vulnerabilities?: Vulnerability[];
}
interface Retire {
  replaceVersion(text: string): string;
  scanUri(uri: string, repo: unknown): Component[];
  scanFileName(fileName: string, repo: unknown, includeUri: boolean): Component[];
  scanFileContent(content: string, repo: unknown, hasher: { sha1(data: string): string }): Component[];
}

const require = createRequire(import.meta.url);
const retire = require('retire/lib/retire.js') as Retire;
const DATABASE = join(dirname(fileURLToPath(import.meta.url)), '../../../vendor/retire/jsrepository-v5.json');
let repository: unknown;
const loadRepository = () => (repository ??= JSON.parse(retire.replaceVersion(readFileSync(DATABASE, 'utf8'))));
const hasher = { sha1: (data: string) => createHash('sha1').update(data).digest('hex') };

const SEVERITY: Record<string, Severity> = { critical: 'Critical', high: 'High', medium: 'Medium', low: 'Low', none: 'Low' };
const RANK = ['none', 'low', 'medium', 'high', 'critical'];

/** The vulnerable libraries in one script, by address and content. Exported for tests. */
export function scanScript(url: string, content: string | null): Component[] {
  const repo = loadRepository();
  const fileName = new URL(url).pathname.split('/').pop() ?? '';
  const found = [...retire.scanUri(url, repo), ...retire.scanFileName(fileName, repo, false), ...(content ? retire.scanFileContent(content, repo, hasher) : [])];
  const unique = new Map<string, Component>();
  for (const c of found) if (c.vulnerabilities?.length) unique.set(`${c.component}@${c.version}`, c);
  return [...unique.values()];
}

export function librariesModule(): CheckModule {
  const scanned = new Map<string, Component[]>();
  return {
    id: 'libraries',
    name: 'Outdated JavaScript libraries',
    perViewport: false,
    async run({ page }) {
      const scripts = await page.evaluate(() => [
        ...new Set([...document.scripts].map((s) => s.src).concat(performance.getEntriesByType('resource').filter((e) => (e as PerformanceResourceTiming).initiatorType === 'script').map((e) => e.name))),
      ]);
      const out: CheckFinding[] = [];
      for (const url of scripts.filter((s) => /^https?:/.test(s))) {
        if (!scanned.has(url)) {
          // The browser already downloaded this script; fetching it again reads what a visitor receives.
          const response = await page.context().request.get(url, { failOnStatusCode: false, timeout: 15_000 }).catch(() => null);
          const body = response?.ok() ? await response.text().catch(() => null) : null;
          scanned.set(url, scanScript(url, body && body.length < 5_000_000 ? body : null));
        }
        for (const component of scanned.get(url)!) out.push(finding(component, url));
      }
      return out;
    },
  };
}

function finding(component: Component, url: string): CheckFinding {
  const guidance = guidanceFor('prego', 'vulnerable-library')!;
  const vulns = component.vulnerabilities ?? [];
  const worst = vulns.reduce((w, v) => (RANK.indexOf(v.severity) > RANK.indexOf(w) ? v.severity : w), 'none' as Vulnerability['severity']);
  const ids = [...new Set(vulns.flatMap((v) => v.identifiers.CVE ?? (v.identifiers.githubID ? [v.identifiers.githubID] : [])))];
  const fixedIn = vulns.map((v) => v.below).sort((a, b) => a.localeCompare(b, undefined, { numeric: true })).at(-1);
  return {
    module: 'libraries',
    engine: 'retire.js',
    ruleId: 'vulnerable-library',
    category: 'SEC',
    severity: SEVERITY[worst],
    title: `${guidance.title}: ${component.component} ${component.version}`,
    description: guidance.description,
    helpUrl: vulns[0]?.info[0] ?? null,
    wcagCriteria: [],
    wcagLevel: null,
    selector: 'html',
    html: `<script src="${url}">`,
    failureSummary: `${component.component} ${component.version} has ${vulns.length} known vulnerabilit${vulns.length === 1 ? 'y' : 'ies'}${ids.length ? ` (${ids.slice(0, 5).join(', ')}${ids.length > 5 ? ', …' : ''})` : ''}. Fixed in ${fixedIn} or later. Loaded from ${url}.`,
    siteWide: true,
    component: `libraries:${component.component}@${component.version}`,
  };
}
