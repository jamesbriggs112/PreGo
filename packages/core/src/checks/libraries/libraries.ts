import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Severity } from '../../types.js';
import type { CheckFinding, CheckModule } from '../types.js';
import { guidanceFor } from '../guidance.js';
import { openVulnDb, type VulnDb } from '../../vulndb/store.js';
import { JS_EOL, npmName } from '../../vulndb/software.js';
import type { Advisory } from '../../vulndb/types.js';

// Outdated JavaScript libraries with published vulnerabilities. Retire.js (Apache-2.0) recognises the
// libraries in the scripts each page already loads; their versions are checked against Retire's own
// list and the OSV.dev advisories in Prego's local vulnerability data, with CISA's list of exploited
// vulnerabilities and end-of-life dates. All of it is read from this computer: see vulndb/.

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
/** The copy bundled with Prego, used until the vulnerability data has been downloaded. */
export const BUNDLED_RETIRE = join(dirname(fileURLToPath(import.meta.url)), '../../../vendor/retire/jsrepository-v5.json');
const repositories = new Map<string, unknown>();
const loadRepository = (path = BUNDLED_RETIRE) => {
  if (!repositories.has(path)) repositories.set(path, JSON.parse(retire.replaceVersion(readFileSync(path, 'utf8'))));
  return repositories.get(path);
};
const hasher = { sha1: (data: string) => createHash('sha1').update(data).digest('hex') };


/** The libraries in one script, by address and content, with Retire's vulnerabilities for each. Exported for tests. */
export function scanScript(url: string, content: string | null, repositoryPath?: string): Component[] {
  const repo = loadRepository(repositoryPath);
  const fileName = new URL(url).pathname.split('/').pop() ?? '';
  const found = [...retire.scanUri(url, repo), ...retire.scanFileName(fileName, repo, false), ...(content ? retire.scanFileContent(content, repo, hasher) : [])];
  const unique = new Map<string, Component>();
  for (const c of found) {
    const key = `${c.component}@${c.version}`;
    if (!unique.get(key)?.vulnerabilities?.length) unique.set(key, c);
  }
  return [...unique.values()];
}

/** What's known about one library version: Retire's vulnerabilities, OSV advisories not already among them, exploitation and end of life. */
export interface LibraryReport {
  component: Component;
  advisories: Advisory[];
  exploited: string[];
  endOfLife: ReturnType<VulnDb['endOfLife']>;
}

export function assessLibrary(component: Component, db: VulnDb): LibraryReport {
  const retireIds = new Set((component.vulnerabilities ?? []).flatMap((v) => [...(v.identifiers.CVE ?? []), ...(v.identifiers.githubID ? [v.identifiers.githubID] : [])]));
  const advisories = db.advisoriesFor(`npm:${npmName(component.component)}`, component.version).filter((a) => ![a.id, ...a.aliases].some((id) => retireIds.has(id)));
  const allIds = [...retireIds, ...advisories.flatMap((a) => [a.id, ...a.aliases])];
  const eolProduct = JS_EOL[component.component];
  return { component, advisories, exploited: db.exploited(allIds), endOfLife: eolProduct ? db.endOfLife(eolProduct, component.version) : null };
}

export function librariesModule(options: { dataDir?: string } = {}): CheckModule {
  const db = options.dataDir ? openVulnDb(options.dataDir) : null;
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
          scanned.set(url, scanScript(url, body && body.length < 5_000_000 ? body : null, db?.retirePath ?? undefined));
        }
        for (const component of scanned.get(url)!) {
          const report = db ? assessLibrary(component, db) : { component, advisories: [], exploited: [], endOfLife: null };
          if (component.vulnerabilities?.length || report.advisories.length) out.push(finding(report, url, db?.date ?? null));
          if (report.endOfLife) out.push(eolFinding(report, url));
        }
      }
      return out;
    },
  };
}

const RETIRE_SEVERITY: Record<Vulnerability['severity'], Severity> = { critical: 'Critical', high: 'High', medium: 'Medium', low: 'Low', none: 'Low' };
const SEVERITIES: Severity[] = ['Low', 'Medium', 'High', 'Critical'];
const worse = (a: Severity, b: Severity) => (SEVERITIES.indexOf(a) >= SEVERITIES.indexOf(b) ? a : b);
const dataDate = (date: string | null) => (date ? `Vulnerability data from ${new Date(date).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' })}.` : 'Vulnerability data: the copy bundled with Prego.');

function finding({ component, advisories, exploited }: LibraryReport, url: string, date: string | null): CheckFinding {
  const guidance = guidanceFor('prego', 'vulnerable-library')!;
  const vulns = component.vulnerabilities ?? [];
  let severity = [...vulns.map((v) => RETIRE_SEVERITY[v.severity]), ...advisories.map((a) => a.severity)].reduce(worse, 'Low');
  // Weaknesses attackers are known to be using are urgent whatever their score.
  if (exploited.length) severity = worse(severity, 'High');
  const ids = [...new Set([...vulns.flatMap((v) => v.identifiers.CVE ?? (v.identifiers.githubID ? [v.identifiers.githubID] : [])), ...advisories.map((a) => a.aliases.find((x) => x.startsWith('CVE-')) ?? a.id)])];
  const fixedIn = [...vulns.map((v) => v.below), ...advisories.flatMap((a) => a.ranges.map((r) => r.fixed).filter((f): f is string => !!f))]
    .sort((a, b) => a.localeCompare(b, undefined, { numeric: true }))
    .at(-1);
  const count = ids.length || vulns.length;
  return {
    module: 'libraries',
    engine: advisories.length ? 'retire.js, OSV' : 'retire.js',
    ruleId: 'vulnerable-library',
    category: 'SEC',
    severity,
    title: `${guidance.title}: ${component.component} ${component.version}`,
    description: guidance.description,
    helpUrl: vulns[0]?.info[0] ?? advisories[0]?.url ?? null,
    wcagCriteria: [],
    wcagLevel: null,
    selector: 'html',
    html: `<script src="${url}">`,
    failureSummary:
      `${component.component} ${component.version} has ${count} known vulnerabilit${count === 1 ? 'y' : 'ies'}${ids.length ? ` (${ids.slice(0, 5).join(', ')}${ids.length > 5 ? ', …' : ''})` : ''}.` +
      (exploited.length ? ` ${exploited.join(', ')} ${exploited.length === 1 ? 'is' : 'are'} on CISA’s list of vulnerabilities known to be exploited.` : '') +
      (fixedIn ? ` Fixed in ${fixedIn} or later.` : '') +
      ` Loaded from ${url}. ${dataDate(date)}`,
    siteWide: true,
    component: `libraries:${component.component}@${component.version}`,
  };
}

function eolFinding({ component, endOfLife }: LibraryReport, url: string): CheckFinding {
  const guidance = guidanceFor('prego', 'end-of-life-software')!;
  return {
    module: 'libraries',
    engine: 'endoflife.date',
    ruleId: 'end-of-life-software',
    category: 'SEC',
    severity: 'Medium',
    title: `${guidance.title}: ${component.component} ${component.version}`,
    description: guidance.description,
    helpUrl: `https://endoflife.date/${JS_EOL[component.component]}`,
    wcagCriteria: [],
    wcagLevel: null,
    selector: 'html',
    html: `<script src="${url}">`,
    failureSummary: `${component.component} ${endOfLife!.cycle} no longer gets security fixes${endOfLife!.endedOn ? ` (support ended ${endOfLife!.endedOn})` : ''}.${endOfLife!.latest ? ` The last ${endOfLife!.cycle} release is ${endOfLife!.latest}.` : ''} Loaded from ${url}.`,
    siteWide: true,
    component: `libraries:eol:${component.component}@${endOfLife!.cycle}`,
  };
}
