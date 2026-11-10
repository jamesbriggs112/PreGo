import type { Severity } from '../types.js';
import { FILES, readJson, readManifest, writeJson } from './store.js';
import { JS_EOL, SOFTWARE, npmName } from './software.js';
import type { Advisory, EolCycle, SourceStatus, UpdateProgress, VersionRange, VulnDbManifest } from './types.js';

// Downloads public vulnerability data into the data folder. Only public databases are contacted, and
// the requests name the same fixed list of common software for everyone: nothing about an audited
// site is ever sent. Each source is stored separately; if one fails, its previous copy is kept.

export const SOURCES = {
  retire: { name: 'Retire.js JavaScript library database', url: 'https://raw.githubusercontent.com/RetireJS/retire.js/master/repository/jsrepository-v5.json', licence: 'Apache-2.0' },
  osv: { name: 'OSV.dev (GitHub Advisory Database and Drupal)', url: 'https://api.osv.dev', licence: 'CC-BY 4.0 (GitHub Advisory Database)' },
  nvd: { name: 'NIST National Vulnerability Database', url: 'https://services.nvd.nist.gov/rest/json/cves/2.0', licence: 'Public domain (US government)' },
  kev: { name: 'CISA Known Exploited Vulnerabilities', url: 'https://www.cisa.gov/sites/default/files/feeds/known_exploited_vulnerabilities.json', licence: 'CC0' },
  eol: { name: 'endoflife.date', url: 'https://endoflife.date/api', licence: 'MIT' },
} as const;
type SourceId = keyof typeof SOURCES;

export interface UpdateOptions {
  fetchImpl?: typeof fetch;
  onProgress?: (progress: UpdateProgress) => void;
  signal?: AbortSignal;
  /** Wait between NVD requests: it allows 5 requests in 30 seconds without a key. */
  nvdDelayMs?: number;
}

const GHSA_SEVERITY: Record<string, Severity> = { CRITICAL: 'Critical', HIGH: 'High', MODERATE: 'Medium', MEDIUM: 'Medium', LOW: 'Low' };
export const severityFromScore = (score: number): Severity => (score >= 9 ? 'Critical' : score >= 7 ? 'High' : score >= 4 ? 'Medium' : 'Low');
const USER_AGENT = 'Prego website audit tool (vulnerability data update)';

/** Download every source. Resolves with the new manifest; sources that failed keep their old data and say why. */
export async function updateVulnDb(dataDir: string, options: UpdateOptions = {}): Promise<VulnDbManifest> {
  const doFetch = options.fetchImpl ?? fetch;
  const get = async (url: string, init: RequestInit = {}) => {
    const response = await doFetch(url, { ...init, signal: options.signal, headers: { 'user-agent': USER_AGENT, ...(init.body ? { 'content-type': 'application/json' } : {}), ...init.headers } });
    if (!response.ok) throw new Error(`${new URL(url).host} answered HTTP ${response.status}`);
    return response;
  };
  const previous = readManifest(dataDir);
  const statuses = new Map<SourceId, SourceStatus>();
  const progress = (stage: string, done = 0, total = 0) => options.onProgress?.({ stage, done, total });
  const run = async (id: SourceId, work: () => Promise<number>) => {
    const old = previous?.sources.find((s) => s.id === id);
    try {
      const records = await work();
      statuses.set(id, { id, ...SOURCES[id], fetchedAt: new Date().toISOString(), records, error: null });
    } catch (error) {
      if (options.signal?.aborted) throw error;
      statuses.set(id, { id, ...SOURCES[id], fetchedAt: old?.fetchedAt ?? null, records: old?.records ?? 0, error: (error as Error).message });
    }
  };

  let components: string[] = Object.keys(readJson<Record<string, unknown>>(dataDir, FILES.retire) ?? {});
  await run('retire', async () => {
    progress('Downloading the JavaScript library database');
    const text = await (await get(SOURCES.retire.url)).text();
    const repo = JSON.parse(text) as Record<string, unknown>;
    writeJson(dataDir, FILES.retire, repo);
    components = Object.keys(repo).filter((c) => c !== 'retire-example');
    return components.length;
  });

  const advisories: Record<string, Advisory[]> = readJson(dataDir, FILES.advisories) ?? {};
  await run('osv', async () => {
    const packages = [
      ...[...new Set(components.map(npmName))].map((name) => ({ key: `npm:${name}`, ecosystem: 'npm', name })),
      ...SOFTWARE.filter((s) => s.osv).map((s) => ({ key: s.id, ecosystem: s.osv!.ecosystem, name: s.osv!.name })),
    ];
    if (!packages.length) throw new Error('No package list: the JavaScript library database hasn’t downloaded yet.');
    progress('Finding advisories on OSV.dev', 0, packages.length);
    const ids = new Map<string, Set<string>>(packages.map((p) => [p.key, new Set()]));
    let pending = packages.map((p) => ({ ...p, token: undefined as string | undefined }));
    while (pending.length) {
      const body = { queries: pending.map((p) => ({ package: { name: p.name, ecosystem: p.ecosystem }, ...(p.token ? { page_token: p.token } : {}) })) };
      const { results } = (await (await get(`${SOURCES.osv.url}/v1/querybatch`, { method: 'POST', body: JSON.stringify(body) })).json()) as {
        results: { vulns?: { id: string }[]; next_page_token?: string }[];
      };
      results.forEach((r, i) => r.vulns?.forEach((v) => ids.get(pending[i].key)!.add(v.id)));
      pending = pending.map((p, i) => ({ ...p, token: results[i]?.next_page_token })).filter((p) => p.token);
    }
    const wanted = [...new Set([...ids.values()].flatMap((s) => [...s]))].filter((id) => !id.startsWith('MAL-'));
    const details = new Map<string, OsvVuln>();
    let done = 0;
    await pool(wanted, 8, async (id) => {
      details.set(id, (await (await get(`${SOURCES.osv.url}/v1/vulns/${encodeURIComponent(id)}`)).json()) as OsvVuln);
      progress('Downloading advisories from OSV.dev', ++done, wanted.length);
    });
    let count = 0;
    for (const p of packages) {
      advisories[p.key] = [...ids.get(p.key)!].map((id) => details.get(id)).filter((v): v is OsvVuln => !!v).map((v) => fromOsv(v, p.ecosystem, p.name)).filter((a): a is Advisory => !!a);
      count += advisories[p.key].length;
    }
    writeJson(dataDir, FILES.advisories, advisories);
    return count;
  });

  await run('nvd', async () => {
    const products = SOFTWARE.filter((s) => s.nvd);
    let count = 0;
    let requests = 0;
    for (const [i, software] of products.entries()) {
      progress(`Downloading ${software.name} vulnerabilities from the NVD`, i, products.length);
      const found = new Map<string, Advisory>();
      for (const cpe of software.nvd!) {
        for (let start = 0, total = 1; start < total; start += 2000) {
          if (requests++) await wait(options.nvdDelayMs ?? 6500, options.signal);
          const data = (await (await get(`${SOURCES.nvd.url}?virtualMatchString=cpe:2.3:a:${cpe}&resultsPerPage=2000&startIndex=${start}`)).json()) as { totalResults: number; vulnerabilities: { cve: NvdCve }[] };
          total = data.totalResults;
          for (const { cve } of data.vulnerabilities) {
            const advisory = fromNvd(cve, software.nvd!);
            if (advisory) found.set(advisory.id, advisory);
          }
        }
      }
      advisories[software.id] = [...found.values()];
      count += found.size;
    }
    writeJson(dataDir, FILES.advisories, advisories);
    return count;
  });

  await run('kev', async () => {
    progress('Downloading the CISA list of exploited vulnerabilities');
    const data = (await (await get(SOURCES.kev.url)).json()) as { vulnerabilities: { cveID: string }[] };
    const ids = data.vulnerabilities.map((v) => v.cveID);
    writeJson(dataDir, FILES.kev, ids);
    return ids.length;
  });

  await run('eol', async () => {
    const products = [...new Set([...SOFTWARE.map((s) => s.eol).filter((p): p is string => !!p), ...Object.values(JS_EOL)])];
    const eol: Record<string, EolCycle[]> = {};
    for (const [i, product] of products.entries()) {
      progress('Downloading end-of-life dates', i, products.length);
      const cycles = (await (await get(`${SOURCES.eol.url}/${product}.json`)).json()) as { cycle: string | number; eol: string | boolean; latest?: string }[];
      eol[product] = cycles.map((c) => ({ cycle: String(c.cycle), eol: c.eol, latest: c.latest }));
    }
    writeJson(dataDir, FILES.eol, eol);
    return products.length;
  });

  const manifest: VulnDbManifest = {
    updatedAt: [...statuses.values()].some((s) => !s.error) ? new Date().toISOString() : (previous?.updatedAt ?? null),
    sources: (Object.keys(SOURCES) as SourceId[]).map((id) => statuses.get(id)!),
  };
  writeJson(dataDir, FILES.manifest, manifest);
  return manifest;
}

interface OsvVuln {
  id: string;
  summary?: string;
  details?: string;
  aliases?: string[];
  severity?: { type: string; score: string }[];
  database_specific?: { severity?: string };
  affected?: {
    package?: { name: string; ecosystem: string };
    ranges?: { type: string; events: { introduced?: string; fixed?: string; last_affected?: string }[] }[];
    versions?: string[];
    database_specific?: { severity?: string };
  }[];
  references?: { url: string }[];
}

/** An OSV record as an advisory for one package, or null if it doesn't name that package's versions. */
export function fromOsv(v: OsvVuln, ecosystem: string, name: string): Advisory | null {
  const entries = (v.affected ?? []).filter((a) => a.package?.ecosystem === ecosystem && a.package.name.toLowerCase() === name.toLowerCase());
  const ranges: VersionRange[] = [];
  for (const entry of entries) {
    for (const range of entry.ranges ?? []) {
      if (range.type === 'GIT') continue;
      let current: VersionRange | null = null;
      for (const event of range.events) {
        if (event.introduced !== undefined) current = { introduced: event.introduced };
        else if (current && (event.fixed || event.last_affected)) {
          ranges.push(event.fixed ? { ...current, fixed: event.fixed } : { ...current, lastAffected: event.last_affected });
          current = null;
        }
      }
      if (current) ranges.push(current);
    }
    if (!entry.ranges?.length) for (const version of entry.versions ?? []) ranges.push({ exact: version });
  }
  if (!ranges.length) return null;
  const label = v.database_specific?.severity ?? entries.find((e) => e.database_specific?.severity)?.database_specific?.severity;
  const score = cvssScore(v.severity?.find((s) => s.type.startsWith('CVSS'))?.score);
  return {
    id: v.id,
    aliases: v.aliases ?? [],
    summary: v.summary || (v.details ?? '').split('\n')[0].slice(0, 200),
    severity: (label && GHSA_SEVERITY[label.toUpperCase()]) || (score !== null ? severityFromScore(score) : 'Medium'),
    score,
    url: `https://osv.dev/vulnerability/${v.id}`,
    ranges,
    source: 'OSV',
  };
}

interface NvdCve {
  id: string;
  descriptions: { lang: string; value: string }[];
  metrics?: Record<string, { cvssData: { baseScore: number } }[]>;
  configurations?: {
    nodes: {
      cpeMatch: { vulnerable: boolean; criteria: string; versionStartIncluding?: string; versionStartExcluding?: string; versionEndIncluding?: string; versionEndExcluding?: string }[];
    }[];
  }[];
}

/** An NVD CVE as an advisory for the given CPE products, or null if it has no version ranges for them. */
export function fromNvd(cve: NvdCve, cpes: string[]): Advisory | null {
  const ranges: VersionRange[] = [];
  for (const node of (cve.configurations ?? []).flatMap((c) => c.nodes)) {
    for (const match of node.cpeMatch) {
      const parts = match.criteria.split(':');
      if (!match.vulnerable || !cpes.includes(`${parts[3]}:${parts[4]}`)) continue;
      const version = parts[5];
      if (version && version !== '*' && version !== '-') ranges.push({ exact: version });
      else if (match.versionEndExcluding || match.versionEndIncluding || match.versionStartIncluding || match.versionStartExcluding) {
        // "Starting after" is rare; treat it as starting at, which errs on the side of reporting.
        ranges.push({
          introduced: match.versionStartIncluding ?? match.versionStartExcluding ?? '0',
          fixed: match.versionEndExcluding,
          lastAffected: match.versionEndIncluding,
        });
      }
    }
  }
  if (!ranges.length) return null;
  const metric = ['cvssMetricV40', 'cvssMetricV31', 'cvssMetricV30', 'cvssMetricV2'].map((k) => cve.metrics?.[k]?.[0]).find(Boolean);
  const score = metric?.cvssData.baseScore ?? null;
  return {
    id: cve.id,
    aliases: [],
    summary: (cve.descriptions.find((d) => d.lang === 'en')?.value ?? '').slice(0, 300),
    severity: score !== null ? severityFromScore(score) : 'Medium',
    score,
    url: `https://nvd.nist.gov/vuln/detail/${cve.id}`,
    ranges,
    source: 'NVD',
  };
}

/** A rough CVSS 3 base score from its vector, enough to rank advisories. Null for anything else. */
export function cvssScore(vector: string | undefined): number | null {
  if (!vector?.startsWith('CVSS:3')) return null;
  const m = Object.fromEntries(vector.split('/').slice(1).map((p) => p.split(':')));
  const W = { AV: { N: 0.85, A: 0.62, L: 0.55, P: 0.2 }, AC: { L: 0.77, H: 0.44 }, UI: { N: 0.85, R: 0.62 }, CIA: { H: 0.56, L: 0.22, N: 0 } } as const;
  const changed = m.S === 'C';
  const pr = { N: 0.85, L: changed ? 0.68 : 0.62, H: changed ? 0.5 : 0.27 }[m.PR as 'N' | 'L' | 'H'];
  const av = W.AV[m.AV as keyof typeof W.AV];
  const ac = W.AC[m.AC as keyof typeof W.AC];
  const ui = W.UI[m.UI as keyof typeof W.UI];
  const [c, i, a] = [m.C, m.I, m.A].map((x) => W.CIA[x as keyof typeof W.CIA]);
  if ([pr, av, ac, ui, c, i, a].some((x) => x === undefined)) return null;
  const iss = 1 - (1 - c) * (1 - i) * (1 - a);
  const impact = changed ? 7.52 * (iss - 0.029) - 3.25 * (iss - 0.02) ** 15 : 6.42 * iss;
  if (impact <= 0) return 0;
  const exploitability = 8.22 * av * ac * pr * ui;
  const roundUp = (x: number) => Math.ceil(x * 10) / 10;
  return roundUp(Math.min(changed ? 1.08 * (impact + exploitability) : impact + exploitability, 10));
}

async function pool<T>(items: T[], size: number, work: (item: T) => Promise<void>) {
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(size, items.length) }, async () => {
    while (next < items.length) await work(items[next++]);
  }));
}

function wait(ms: number, signal?: AbortSignal) {
  return new Promise<void>((resolve, reject) => {
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener('abort', () => (clearTimeout(timer), reject(signal.reason)), { once: true });
  });
}
