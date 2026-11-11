import { gzipSync } from 'node:zlib';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { affected, compareVersions } from './versions.js';
import { cvssScore, fromNvd, fromOsv, updateVulnDb } from './update.js';
import { detectSoftware } from './software.js';
import { openVulnDb, readManifest, vulnDbAgeDays } from './store.js';
import { assessSoftware } from '../checks/software/software.js';
import { assessLibrary } from '../checks/libraries/libraries.js';

const dirs: string[] = [];
const tempDir = () => {
  const dir = mkdtempSync(join(tmpdir(), 'prego-vulndb-'));
  dirs.push(dir);
  return dir;
};
afterAll(() => dirs.forEach((d) => rmSync(d, { recursive: true, force: true })));

describe('versions', () => {
  it('compares dotted versions numerically, with letters and pre-releases', () => {
    expect(compareVersions('1.10.0', '1.9.9')).toBe(1);
    expect(compareVersions('2.4.49', '2.4.49')).toBe(0);
    expect(compareVersions('1.0.2k', '1.0.2')).toBe(1);
    expect(compareVersions('3.0.0-rc1', '3.0.0')).toBe(-1);
    expect(compareVersions('8.1', '8.1.0')).toBe(0);
  });

  it('checks ranges: introduced, fixed, last affected and exact', () => {
    expect(affected('1.8.1', [{ introduced: '1.2', fixed: '3.5.0' }])).toBe(true);
    expect(affected('3.5.0', [{ introduced: '1.2', fixed: '3.5.0' }])).toBe(false);
    expect(affected('1.1', [{ introduced: '1.2', fixed: '3.5.0' }])).toBe(false);
    expect(affected('2.4.50', [{ introduced: '0', lastAffected: '2.4.50' }])).toBe(true);
    expect(affected('2.4.49', [{ exact: '2.4.49' }])).toBe(true);
    // An open range with no bounds at all would match everything, so it doesn't count.
    expect(affected('1.0', [{}])).toBe(false);
  });
});

describe('reading the sources', () => {
  it('turns an OSV record into an advisory for the named package only', () => {
    const advisory = fromOsv(
      {
        id: 'GHSA-gxr4-xjj5-5px2',
        summary: 'Potential XSS in jQuery',
        aliases: ['CVE-2020-11022'],
        database_specific: { severity: 'MODERATE' },
        affected: [
          { package: { name: 'jquery', ecosystem: 'npm' }, ranges: [{ type: 'SEMVER', events: [{ introduced: '1.2' }, { fixed: '3.5.0' }] }] },
          { package: { name: 'jquery-rails', ecosystem: 'RubyGems' }, ranges: [{ type: 'ECOSYSTEM', events: [{ introduced: '0' }, { fixed: '4.4.0' }] }] },
        ],
      },
      'npm',
      'jquery',
    );
    expect(advisory).toMatchObject({ id: 'GHSA-gxr4-xjj5-5px2', severity: 'Medium', ranges: [{ introduced: '1.2', fixed: '3.5.0' }], url: 'https://osv.dev/vulnerability/GHSA-gxr4-xjj5-5px2' });
    expect(fromOsv({ id: 'X', affected: [] }, 'npm', 'jquery')).toBeNull();
  });

  it('turns an NVD CVE into an advisory with ranges for the product, and scores its severity', () => {
    const advisory = fromNvd(
      {
        id: 'CVE-2021-41773',
        descriptions: [{ lang: 'en', value: 'A path traversal flaw in Apache HTTP Server 2.4.49.' }],
        metrics: { cvssMetricV31: [{ cvssData: { baseScore: 7.5 } }] },
        configurations: [
          {
            nodes: [
              {
                cpeMatch: [
                  { vulnerable: true, criteria: 'cpe:2.3:a:apache:http_server:2.4.49:*:*:*:*:*:*:*' },
                  { vulnerable: true, criteria: 'cpe:2.3:o:fedoraproject:fedora:34:*:*:*:*:*:*:*' },
                ],
              },
            ],
          },
        ],
      },
      ['apache:http_server'],
    );
    expect(advisory).toMatchObject({ id: 'CVE-2021-41773', severity: 'High', score: 7.5, ranges: [{ exact: '2.4.49' }], source: 'NVD' });
  });

  it('scores a CVSS 3 vector', () => {
    expect(cvssScore('CVSS:3.1/AV:N/AC:L/PR:N/UI:N/S:U/C:H/I:H/A:H')).toBe(9.8);
    expect(cvssScore('CVSS:3.1/AV:N/AC:H/PR:N/UI:R/S:C/C:H/I:L/A:N')).toBe(6.9);
    expect(cvssScore('CVSS:4.0/AV:N')).toBeNull();
  });
});

describe('detecting software from what a visitor receives', () => {
  it('reads versions from headers and the generator tag, and notices distribution builds', () => {
    const found = detectSoftware({ server: 'Apache/2.4.41 (Ubuntu)', 'x-powered-by': 'PHP/7.4.3' }, ['WordPress 6.4.2']);
    expect(found.map((s) => [s.id, s.version, s.distro])).toEqual([
      ['apache', '2.4.41', true],
      ['php', '7.4.3', false],
      ['wordpress', '6.4.2', false],
    ]);
    expect(found[0].evidence).toBe('Server header: Apache/2.4.41 (Ubuntu)');
    // No version, nothing to check.
    expect(detectSoftware({ server: 'nginx', 'x-powered-by': 'Express' }, ['Drupal'])).toEqual([]);
  });
});

/** A small update served by a fake fetch: one library, one server product, the exploited list and end-of-life dates. */
async function fakeUpdate(dataDir: string) {
  const responses: Record<string, unknown> = {
    'raw.githubusercontent.com': { jquery: { vulnerabilities: [], extractors: {} } },
    'api.osv.dev/v1/querybatch': { results: [{ vulns: [{ id: 'GHSA-1' }] }] },
    'api.osv.dev/v1/vulns/GHSA-1': {
      id: 'GHSA-1',
      summary: 'XSS',
      aliases: ['CVE-2020-11023'],
      database_specific: { severity: 'MODERATE' },
      affected: [{ package: { name: 'jquery', ecosystem: 'npm' }, ranges: [{ type: 'SEMVER', events: [{ introduced: '1.0.3' }, { fixed: '3.5.0' }] }] }],
    },
    'services.nvd.nist.gov': {
      totalResults: 1,
      vulnerabilities: [
        {
          cve: {
            id: 'CVE-2021-41773',
            descriptions: [{ lang: 'en', value: 'Path traversal' }],
            metrics: { cvssMetricV31: [{ cvssData: { baseScore: 7.5 } }] },
            configurations: [{ nodes: [{ cpeMatch: [{ vulnerable: true, criteria: 'cpe:2.3:a:apache:http_server:2.4.49:*:*:*:*:*:*:*' }] }] }],
          },
        },
      ],
    },
    'www.cisa.gov': { vulnerabilities: [{ cveID: 'CVE-2021-41773' }, { cveID: 'CVE-2020-11023' }] },
    'endoflife.date': [
      { cycle: '2.4', eol: false, latest: '2.4.62' },
      { cycle: '1', eol: true, latest: '1.12.4' },
      { cycle: '7.4', eol: '2022-11-28', latest: '7.4.33' },
    ],
  };
  const requested: string[] = [];
  const fetchImpl = (async (input: string | URL) => {
    const url = String(input);
    requested.push(url);
    if (url.includes('iptoasn.com')) return new Response(gzipSync(Array.from({ length: 1200 }, (_, i) => `1.0.${Math.floor(i / 256)}.${i % 256}\t1.0.${Math.floor(i / 256)}.${i % 256}\t1\tUS\tX`).join('\n')));
    const key = Object.keys(responses)
      .sort((a, b) => b.length - a.length)
      .find((k) => url.includes(k));
    const body = key ? responses[key] : null;
    // Packages other than jQuery and Apache have nothing.
    const empty = url.includes('services.nvd.nist.gov') && !url.includes('apache:http_server') ? { totalResults: 0, vulnerabilities: [] } : null;
    return new Response(JSON.stringify(empty ?? body ?? {}), { status: key ? 200 : 404 });
  }) as typeof fetch;
  const manifest = await updateVulnDb(dataDir, { fetchImpl, nvdDelayMs: 0 });
  return { manifest, requested };
}

describe('updating and using the local data', () => {
  it('downloads every source into the data folder, naming only common software', async () => {
    const dataDir = tempDir();
    expect(vulnDbAgeDays(dataDir)).toBeNull();
    const { manifest, requested } = await fakeUpdate(dataDir);
    expect(manifest.sources.map((s) => [s.id, s.error])).toEqual([
      ['retire', null],
      ['osv', null],
      ['nvd', null],
      ['kev', null],
      ['eol', null],
      ['ipasn', null],
    ]);
    expect(readManifest(dataDir)?.updatedAt).toEqual(expect.any(String));
    expect(vulnDbAgeDays(dataDir)).toBe(0);
    // Every request goes to a public database.
    for (const url of requested) expect(new URL(url).host).toMatch(/^(raw\.githubusercontent\.com|api\.osv\.dev|services\.nvd\.nist\.gov|www\.cisa\.gov|endoflife\.date|iptoasn\.com)$/);
  });

  it('keeps the previous copy of a source that fails, and says why', async () => {
    const dataDir = tempDir();
    await fakeUpdate(dataDir);
    const manifest = await updateVulnDb(dataDir, { fetchImpl: (async () => new Response('', { status: 503 })) as typeof fetch, nvdDelayMs: 0 });
    expect(manifest.sources.every((s) => s.error?.includes('HTTP 503'))).toBe(true);
    expect(manifest.sources.find((s) => s.id === 'kev')?.records).toBe(2);
    expect(openVulnDb(dataDir).exploited(['CVE-2021-41773'])).toEqual(['CVE-2021-41773']);
  });

  it('flags vulnerable and unsupported software, with exploited vulnerabilities raised', async () => {
    const dataDir = tempDir();
    await fakeUpdate(dataDir);
    const db = openVulnDb(dataDir);
    const [vulnerable] = assessSoftware({ id: 'apache', name: 'Apache HTTP Server', version: '2.4.49', evidence: 'Server header: Apache/2.4.49', distro: false }, db);
    expect(vulnerable).toMatchObject({ ruleId: 'vulnerable-software', severity: 'High', title: expect.stringContaining('Apache HTTP Server 2.4.49') });
    expect(vulnerable.failureSummary).toMatch(/may be affected by 1 known vulnerability/);
    expect(vulnerable.failureSummary).toMatch(/CVE-2021-41773 is on CISA’s list of vulnerabilities known to be exploited/);
    expect(assessSoftware({ id: 'apache', name: 'Apache HTTP Server', version: '2.4.62', evidence: 'Server header', distro: false }, db)).toEqual([]);

    // A distribution's build may be patched: a prompt to check, at low severity.
    const [distro] = assessSoftware({ id: 'apache', name: 'Apache HTTP Server', version: '2.4.49', evidence: 'Server header: Apache/2.4.49 (Ubuntu)', distro: true }, db);
    expect(distro.severity).toBe('Low');
    expect(distro.failureSummary).toMatch(/may already be patched/);

    const eol = assessSoftware({ id: 'php', name: 'PHP', version: '7.4.3', evidence: 'X-Powered-By header: PHP/7.4.3', distro: false }, db);
    expect(eol).toMatchObject([{ ruleId: 'end-of-life-software', severity: 'Medium', failureSummary: expect.stringMatching(/PHP 7\.4 no longer gets security fixes.+2022-11-28/) }]);
  });

  it('adds OSV advisories, exploitation and end of life to a library Retire found', async () => {
    const dataDir = tempDir();
    await fakeUpdate(dataDir);
    const report = assessLibrary({ component: 'jquery', version: '1.8.1', vulnerabilities: [] }, openVulnDb(dataDir));
    expect(report.advisories.map((a) => a.id)).toEqual(['GHSA-1']);
    expect(report.exploited).toEqual(['CVE-2020-11023']);
    expect(report.endOfLife).toMatchObject({ cycle: '1', latest: '1.12.4' });
  });
});
