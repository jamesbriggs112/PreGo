import type { Severity } from '../../types.js';
import type { CheckFinding, CheckModule } from '../types.js';
import { guidanceFor } from '../guidance.js';
import { openVulnDb, type VulnDb } from '../../vulndb/store.js';
import { SOFTWARE, detectSoftware, type DetectedSoftware } from '../../vulndb/software.js';

// Server software and content management systems with known vulnerabilities or no more security
// fixes. Versions come only from what a visitor's browser receives: the Server and X-Powered-By
// headers and the generator meta tag. They're checked against Prego's local copy of the NVD, OSV.dev,
// CISA's exploited list and endoflife.date. Nothing is probed, and nothing about the site is sent
// anywhere.

const SEVERITIES: Severity[] = ['Low', 'Medium', 'High', 'Critical'];
const worse = (a: Severity, b: Severity) => (SEVERITIES.indexOf(a) >= SEVERITIES.indexOf(b) ? a : b);

/** The findings for one piece of detected software. Exported for tests. */
export function assessSoftware(software: DetectedSoftware, db: VulnDb): CheckFinding[] {
  const out: CheckFinding[] = [];
  const advisories = db.advisoriesFor(software.id, software.version);
  const date = db.date ? `Vulnerability data from ${new Date(db.date).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' })}.` : '';
  const caveat = software.distro
    ? ' The header shows it’s packaged by a Linux distribution, which often fixes vulnerabilities without changing the version number, so the server may already be patched: ask the host to confirm.'
    : ' Versions shown in headers and generator tags can be out of date, so confirm the version with whoever runs the site.';
  if (advisories.length) {
    const ids = advisories.map((a) => a.aliases.find((x) => x.startsWith('CVE-')) ?? a.id);
    const exploited = db.exploited(advisories.flatMap((a) => [a.id, ...a.aliases]));
    let severity = advisories.map((a) => a.severity).reduce(worse, 'Low');
    if (exploited.length) severity = worse(severity, 'High');
    // A distribution's build may be patched, so it's a prompt to check, not a finding.
    if (software.distro) severity = 'Low';
    const serious = advisories.filter((a) => a.severity === 'Critical' || a.severity === 'High').length;
    out.push(
      finding('vulnerable-software', software, severity, advisories[0].url,
        `${software.name} ${software.version} may be affected by ${advisories.length} known vulnerabilit${advisories.length === 1 ? 'y' : 'ies'}` +
          `${serious ? `, ${serious} of them critical or high` : ''} (${ids.slice(0, 5).join(', ')}${ids.length > 5 ? ', …' : ''}).` +
          (exploited.length ? ` ${exploited.slice(0, 3).join(', ')}${exploited.length > 3 ? ` and ${exploited.length - 3} more` : ''} ${exploited.length === 1 ? 'is' : 'are'} on CISA’s list of vulnerabilities known to be exploited.` : '') +
          ` Found from the ${software.evidence}.${caveat} ${date}`.trimEnd(),
      ),
    );
  }
  const product = SOFTWARE.find((s) => s.id === software.id)?.eol;
  const eol = product ? db.endOfLife(product, software.version) : null;
  if (eol) {
    out.push(
      finding('end-of-life-software', software, software.distro ? 'Low' : 'Medium', `https://endoflife.date/${product}`,
        `${software.name} ${eol.cycle} no longer gets security fixes from its makers${eol.endedOn ? ` (support ended ${eol.endedOn})` : ''}.` +
          `${eol.latest ? ` The last ${eol.cycle} release is ${eol.latest}.` : ''} Found from the ${software.evidence}.` +
          (software.distro ? ' Some Linux distributions keep fixing older versions for longer, so ask the host whether this one is still supported.' : ''),
      ),
    );
  }
  return out;
}

function finding(ruleId: 'vulnerable-software' | 'end-of-life-software', software: DetectedSoftware, severity: Severity, helpUrl: string, failureSummary: string): CheckFinding {
  const guidance = guidanceFor('prego', ruleId)!;
  return {
    module: 'software',
    engine: ruleId === 'vulnerable-software' ? 'NVD, OSV' : 'endoflife.date',
    ruleId,
    category: 'SEC',
    severity,
    title: `${guidance.title}: ${software.name} ${software.version}`,
    description: guidance.description,
    helpUrl,
    wcagCriteria: [],
    wcagLevel: null,
    selector: 'html',
    html: '<html>',
    failureSummary,
    siteWide: true,
    component: `software:${ruleId}:${software.id}@${software.version}`,
  };
}

export function softwareModule(options: { dataDir?: string } = {}): CheckModule {
  const seen = new Set<string>();
  return {
    id: 'software',
    name: 'Known vulnerable software',
    perViewport: false,
    async run({ page, location }) {
      if (!options.dataDir || (location.kind === 'state' && location.depth > 1)) return [];
      const url = page.url();
      if (!/^https?:/.test(url)) return [];
      // The same request a visitor's browser made for this page, read again for its headers.
      const response = await page.context().request.get(url, { failOnStatusCode: false, maxRedirects: 5 }).catch(() => null);
      const headers = response?.headers() ?? {};
      const generators = await page.evaluate(() => [...document.querySelectorAll('meta[name="generator" i]')].map((m) => m.getAttribute('content') ?? '')).catch(() => [] as string[]);
      const db = openVulnDb(options.dataDir);
      const out: CheckFinding[] = [];
      for (const software of detectSoftware(headers, generators)) {
        const key = `${software.id}@${software.version}`;
        if (seen.has(key)) continue;
        seen.add(key);
        out.push(...assessSoftware(software, db));
      }
      return out;
    },
  };
}
