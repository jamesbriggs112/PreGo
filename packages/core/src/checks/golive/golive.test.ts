import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createServer, type Server } from 'node:http';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AddressInfo } from 'node:net';
import { PregoDb } from '../../db/database.js';
import { runAudit } from '../../audit/run-audit.js';
import { analysePage, robotsBlocksAll } from './golive.js';

const dataDir = mkdtempSync(join(tmpdir(), 'prego-golive-'));
let db: PregoDb;
let staging: Server;
let origin: string;
const unlinked: string[] = [];

// A site with every staging leftover. Unknown paths return the home page with 200, like a misconfigured CMS.
const HOME = `<!doctype html><html lang="en"><head><title>Home</title>
<meta name="robots" content="noindex, nofollow">
<link rel="canonical" href="https://staging.example.org/">
</head><body><main><h1>Welcome</h1><p>Lorem ipsum dolor sit amet, consectetur.</p>
<a href="https://staging.example.org/about">About</a> <a href="/contact">Contact</a>
<img src="http://localhost:8080/hero.jpg" alt="Hero"></main></body></html>`;

beforeAll(async () => {
  db = new PregoDb(':memory:');
  staging = createServer((req, res) => {
    if (req.url === '/robots.txt') return res.writeHead(200, { 'Content-Type': 'text/plain' }).end('User-agent: *\nDisallow: /\n');
    if (req.url === '/sitemap.xml') return res.writeHead(404).end();
    // Prego shouldn't ask for anything the site doesn't link to, beyond robots.txt and the sitemap.
    if (req.url !== '/' && !['/contact'].includes(req.url ?? '')) unlinked.push(req.url ?? '');
    res.writeHead(200, { 'Content-Type': 'text/html', 'X-Robots-Tag': 'noindex' }).end(HOME);
  });
  await new Promise<void>((done) => staging.listen(0, '127.0.0.1', done));
  origin = `http://127.0.0.1:${(staging.address() as AddressInfo).port}`;
});

afterAll(async () => {
  db?.close();
  await new Promise((done) => staging?.close(done));
  rmSync(dataDir, { recursive: true, force: true });
});

describe('go-live mistakes', () => {
  it('finds every staging leftover on a site that has them', async () => {
    const { run } = await runAudit(db, { project: 'Staging', target: origin, checks: ['golive'], delayMs: 0, dataDir, respectRobots: false, maxPages: 3 });
    const tickets = db.getTickets(run.id);
    expect(tickets.map((t) => t.ruleId).sort()).toEqual(['no-analytics', 'no-favicon', 'no-sitemap', 'noindex', 'placeholder-text', 'robots-blocks-all', 'staging-canonical', 'staging-links', 'staging-links']);
    const hosts = tickets.filter((t) => t.ruleId === 'staging-links').map((t) => t.actual);
    expect(hosts.some((f) => f.includes('localhost:8080'))).toBe(true);
    expect(hosts.some((f) => f.includes('staging.example.org'))).toBe(true);
    expect(unlinked).toEqual([]);
    expect(tickets.find((t) => t.ruleId === 'noindex')).toMatchObject({ severity: 'High', category: 'TECH' });
  }, 120_000);

  it('raises only the missing favicon and analytics on the plain fixture site', async () => {
    const { run } = await runAudit(db, { project: 'Acme', target: 'fixtures/bad-site', checks: ['golive'], delayMs: 0, dataDir });
    expect(db.getTickets(run.id).map((t) => t.ruleId).sort()).toEqual(['no-analytics', 'no-favicon']);
  }, 120_000);

  it('reads robots.txt rules per user agent', () => {
    expect(robotsBlocksAll('User-agent: *\nDisallow: /')).toBe(true);
    expect(robotsBlocksAll('User-agent: *\nDisallow: /private/')).toBe(false);
    expect(robotsBlocksAll('User-agent: BadBot\nDisallow: /\n\nUser-agent: *\nAllow: /')).toBe(false);
    expect(robotsBlocksAll('User-agent: Googlebot\nUser-agent: *\nDisallow: /  # staging')).toBe(true);
  });

  it('leaves production links and real content alone', () => {
    const facts = { url: 'https://www.example.org/', robotsMeta: ['index, follow'], robotsHeader: null, canonical: 'https://www.example.org/', urls: ['https://www.example.org/a', '/b', 'https://developer.mozilla.org/', 'https://www.contest.com/'], text: 'Our latest testing results.' };
    expect(analysePage(facts)).toEqual([]);
    expect(analysePage({ ...facts, urls: ['https://dev.example.org/a', 'https://example-staging.herokuapp.com/x'] }).map((f) => f.component)).toEqual([
      'golive:staging-links:dev.example.org',
      'golive:staging-links:example-staging.herokuapp.com',
    ]);
    // Auditing staging itself: its own absolute address will be wrong once live.
    expect(analysePage({ ...facts, url: 'https://staging.example.org/', urls: ['https://staging.example.org/about', '/contact'] }).map((f) => f.ruleId)).toEqual(['staging-links']);
  });
});
