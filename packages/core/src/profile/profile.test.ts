import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { gzipSync } from 'node:zlib';
import { PregoDb } from '../db/database.js';
import { runAudit } from '../audit/run-audit.js';
import { buildSiteProfile, type PageProfile } from './profile.js';
import { carbonFor } from './carbon.js';
import { detectTechnologies } from './technologies.js';
import { createIpLookup, ipv6ToBigInt, isPrivateAddress, saveIpTable } from './ip-lookup.js';
import { sameSite, siteBase } from './site.js';
import { datesIn, readStatement } from '../checks/statement/statement.js';
import { parseClientInfo } from './client.js';
import type { Location } from '../types.js';

describe('same site', () => {
  it('treats subdomains as the site, and other .co.uk sites as other sites', () => {
    expect(siteBase('www.shop.example.co.uk')).toBe('example.co.uk');
    expect(sameSite('cdn.example.com', 'www.example.com')).toBe(true);
    expect(sameSite('other.co.uk', 'example.co.uk')).toBe(false);
    expect(sameSite('fonts.googleapis.com', 'example.org')).toBe(false);
  });
});

describe('carbon', () => {
  it('rates light pages better than heavy ones, and green hosting lower', () => {
    const light = carbonFor(200_000);
    const heavy = carbonFor(4_000_000);
    expect(light.rating).toBe('A+');
    expect(heavy.grams).toBeGreaterThan(light.grams);
    expect(carbonFor(4_000_000, true).grams).toBeLessThan(heavy.grams);
  });
});

describe('technologies', () => {
  it('says why it recognised each one', () => {
    const found = detectTechnologies({
      headers: { server: 'nginx/1.24.0', 'cf-ray': '8a1b', 'X-Powered-By': 'PHP/8.2.1' },
      cookies: ['_ga', 'PHPSESSID'],
      urls: ['https://example.org/wp-content/themes/x/style.css', 'https://fonts.googleapis.com/css2?family=Inter'],
      generator: 'WordPress 6.6.2',
      markers: [],
      network: 'AMAZON-02 - Amazon.com, Inc.',
    });
    const by = Object.fromEntries(found.map((t) => [t.name, t]));
    expect(by.WordPress).toMatchObject({ version: '6.6.2', category: 'Content management', evidence: 'generator tag “WordPress 6.6.2”' });
    expect(by.nginx.version).toBe('1.24.0');
    expect(by.PHP.version).toBe('8.2.1');
    expect(by.Cloudflare.evidence).toContain('cf-ray');
    expect(by['Google Fonts'].category).toBe('Fonts');
    expect(by['Google Analytics'].evidence).toBe('_ga cookie');
    expect(by['Amazon Web Services'].evidence).toContain('AMAZON-02');
    expect(by.Shopify).toBeUndefined();
  });
});

describe('server location', () => {
  const dir = mkdtempSync(join(tmpdir(), 'prego-ip-'));
  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  it('looks addresses up in the local table, IPv4 and IPv6, and skips private ones', () => {
    const rows = [
      '1.0.0.0\t1.0.0.255\t13335\tUS\tCLOUDFLARENET - Cloudflare, Inc.',
      '81.2.69.0\t81.2.69.255\t20712\tGB\tANDREWS-ARNOLD Andrews & Arnold Ltd',
      '2a00:1098::\t2a00:1098:ffff:ffff:ffff:ffff:ffff:ffff\t44684\tGB\tMYTHIC Mythic Beasts Ltd',
    ];
    const filler = Array.from({ length: 1000 }, (_, i) => `10.${Math.floor(i / 256)}.${i % 256}.0\t10.${Math.floor(i / 256)}.${i % 256}.255\t0\tNone\tNot routed`);
    expect(saveIpTable(dir, gzipSync([rows[1], ...filler, rows[2], rows[0]].join('\n')))).toBe(1003);
    const lookup = createIpLookup(dir);
    expect(lookup('81.2.69.142')).toMatchObject({ country: 'GB', countryName: 'United Kingdom', asn: 20712 });
    expect(lookup('2a00:1098:0:80::1')).toMatchObject({ country: 'GB', network: 'MYTHIC Mythic Beasts Ltd' });
    expect(lookup('127.0.0.1')).toBeNull();
    expect(lookup('9.9.9.9')).toBeNull();
    expect(isPrivateAddress('192.168.1.4')).toBe(true);
    expect(ipv6ToBigInt('::ffff:1.2.3.4')).toBe(0xffff01020304n);
  });

  it('refuses a table that looks cut short', () => {
    expect(() => saveIpTable(dir, gzipSync('1.0.0.0\t1.0.0.255\t13335\tUS\tX'))).toThrow(/incomplete/);
  });
});

describe('accessibility statement', () => {
  it('finds the review date, WCAG version and compliance', () => {
    const text =
      'Accessibility statement for Riverside. This website is partially compliant with the Web Content Accessibility Guidelines version 2.2 AA standard. ' +
      'This statement was prepared on 3 March 2023. It was last reviewed on 14/02/2024. The site was last tested on January 9, 2024.';
    expect(readStatement(text)).toEqual({ updated: '2024-02-14', wcag: '2.2', compliance: 'partial' });
    expect(datesIn('Updated: 2025-06-01, reviewed Sept 2024')).toEqual(['2025-06-01', '2024-09-01']);
    expect(datesIn('Our marketing 2024 plan')).toEqual([]);
  });
});

describe('client details', () => {
  it('keeps typed text and drops anything else', () => {
    expect(parseClientInfo({ about: '  A charity  ', goals: '', greenHosting: 'maybe', notes: 'Call first', extra: 'x' })).toEqual({ about: 'A charity', notes: 'Call first' });
    expect(parseClientInfo({ greenHosting: 'yes' })).toEqual({ greenHosting: 'yes' });
  });
});

describe('site profile', () => {
  const location = (id: number, depth: number, profile: Partial<PageProfile> | null, extra: Record<string, unknown> = {}): Location =>
    ({
      id,
      depth,
      kind: 'page',
      url: `https://example.org/${id}`,
      title: `Page ${id}`,
      metrics: {
        ...(profile
          ? {
              profile: {
                url: `https://example.org/${id}`,
                bytes: 0,
                requests: 0,
                byGroup: {},
                firstPartyBytes: 0,
                thirdParties: [],
                technologies: [],
                server: null,
                certificate: null,
                status: 200,
                ...profile,
              },
            }
          : {}),
        ...extra,
      },
    }) as unknown as Location;

  it('puts pages together: carbon, technologies, outside services and the start page’s certificate', () => {
    const now = new Date('2026-01-01T00:00:00Z');
    const site = buildSiteProfile(
      [
        location(2, 1, {
          bytes: 3_000_000,
          firstPartyBytes: 2_000_000,
          byGroup: { Images: 2_500_000, Scripts: 500_000 },
          technologies: [{ name: 'WordPress', category: 'Content management', version: null, evidence: 'x' }],
          thirdParties: [{ host: 'fonts.gstatic.com', service: 'Google Fonts', category: 'Fonts', requests: 2, bytes: 1_000_000, blocked: false }],
        }),
        location(1, 0, {
          bytes: 1_000_000,
          firstPartyBytes: 1_000_000,
          byGroup: { Images: 600_000, HTML: 400_000 },
          technologies: [{ name: 'WordPress', category: 'Content management', version: '6.6', evidence: 'generator' }],
          certificate: { issuer: 'R11', protocol: 'TLS 1.3', validFrom: null, validTo: '2026-01-21T00:00:00Z' },
          server: { ip: '81.2.69.142', location: { country: 'GB', countryName: 'United Kingdom', asn: 1, network: 'X' } },
        }),
        location(3, 1, null),
      ],
      { now },
    )!;
    expect(site.pages).toBe(2);
    expect(site.start?.certificate?.daysLeft).toBe(20);
    expect(site.countries).toEqual(['United Kingdom']);
    expect(site.carbon?.pages.map((p) => p.locationId)).toEqual([2, 1]);
    expect(site.carbon?.averageBytes).toBe(2_000_000);
    expect(site.carbon?.thirdPartyShare).toBe(0.25);
    expect(site.carbon?.byGroup[0]).toEqual({ group: 'Images', bytes: 3_100_000 });
    expect(site.technologies).toEqual([expect.objectContaining({ name: 'WordPress', pages: 2, version: '6.6' })]);
    expect(site.thirdParties[0]).toMatchObject({ host: 'fonts.gstatic.com', pages: 1 });
  });

  it('is null when nothing was profiled', () => {
    expect(buildSiteProfile([location(1, 0, null)])).toBeNull();
  });
});

describe('profiling a real audit', () => {
  let server: Server;
  let origin: string;
  const requested: string[] = [];
  const dataDir = mkdtempSync(join(tmpdir(), 'prego-profile-'));
  const db = new PregoDb(':memory:');
  const html = (body: string) =>
    `<!doctype html><html lang="en"><head><title>Riverside</title><meta name="generator" content="WordPress 6.5"><link rel="stylesheet" href="/wp-content/themes/r/style.css"></head><body><main><h1>Hi</h1>${body}</main><footer><a href="/accessibility">Accessibility</a></footer></body></html>`;

  beforeAll(async () => {
    server = createServer((req, res) => {
      requested.push(req.url ?? '');
      if (req.url?.startsWith('/wp-content/')) return res.writeHead(200, { 'Content-Type': 'text/css' }).end('body{color:#111}'.repeat(500));
      if (req.url === '/robots.txt' || req.url === '/sitemap.xml') return res.writeHead(404).end();
      if (req.url === '/accessibility')
        return res
          .writeHead(200, { 'Content-Type': 'text/html' })
          .end(html('<h2>Accessibility statement</h2><p>This website is fully compliant with WCAG 2.1 AA. This statement was last reviewed on 2 January 2020.</p>'));
      res.writeHead(200, { 'Content-Type': 'text/html', Server: 'nginx/1.25.3' }).end(html('<p>Welcome.</p>'));
    });
    await new Promise<void>((done) => server.listen(0, '127.0.0.1', done));
    origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });
  afterAll(async () => {
    db.close();
    await new Promise((done) => server.close(done));
    rmSync(dataDir, { recursive: true, force: true });
  });

  it('records weight and technologies, reads the statement and flags it as out of date', async () => {
    const { run } = await runAudit(db, { project: 'Riverside', target: origin, checks: ['statement'], delayMs: 0, dataDir, maxPages: 1 });
    const locations = db.getLocations(run.id);
    const site = buildSiteProfile(locations)!;
    expect(site.pages).toBeGreaterThan(0);
    expect(site.carbon!.averageBytes).toBeGreaterThan(8_000);
    expect(site.technologies.map((t) => t.name)).toEqual(expect.arrayContaining(['WordPress', 'nginx']));
    expect(site.start?.server?.ip).toBe('127.0.0.1');
    expect(site.start?.server?.location).toBeNull();
    expect(site.statement).toMatchObject({ url: `${origin}/accessibility`, updated: '2020-01-02', wcag: '2.1', compliance: 'full', read: true });
    expect(db.getTickets(run.id).map((t) => t.ruleId)).toContain('accessibility-statement-outdated');
  }, 120_000);
});
