import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PregoDb } from '../../db/database.js';
import { runAudit } from '../../audit/run-audit.js';
import { serveFolder } from '../../serve/static-server.js';
import type { Ticket } from '../../types.js';
import { analyseHeaders } from './security.js';

const dataDir = mkdtempSync(join(tmpdir(), 'prego-t27-'));
let db: PregoDb;
let runId: number;
let tickets: Ticket[];

beforeAll(async () => {
  db = new PregoDb(':memory:');
  const { run } = await runAudit(db, { project: 'Acme', target: 'fixtures/bad-site', checks: ['security', 'html', 'links'], delayMs: 0, dataDir });
  runId = run.id;
  tickets = db.getTickets(run.id);
}, 120_000);

afterAll(() => {
  db?.close();
  rmSync(dataDir, { recursive: true, force: true });
});

const rules = (category: string) => tickets.filter((t) => t.category === category).map((t) => t.ruleId).sort();

describe('security headers on bad-site', () => {
  it('raises one site-wide ticket per missing header', () => {
    expect(rules('SEC')).toEqual(['missing-csp', 'missing-frame-protection', 'missing-nosniff', 'missing-permissions-policy', 'missing-referrer-policy']);
    for (const t of tickets.filter((t) => t.category === 'SEC')) expect(t).toMatchObject({ locationsAffected: 5, templateKey: null, title: expect.stringMatching(/\(site-wide\)$/) });
  });

  it('does not call a local development server insecure for using HTTP', () => {
    expect(tickets.some((t) => t.ruleId === 'no-https')).toBe(false);
  });

  it('raises nothing for a site that sends good headers', async () => {
    const secure = await serveFolder('fixtures/bad-site', {
      substituteOrigin: true,
      headers: {
        'Content-Security-Policy': "default-src 'self'; frame-ancestors 'self'",
        'Referrer-Policy': 'strict-origin-when-cross-origin',
        'Permissions-Policy': 'camera=(), microphone=(), geolocation=()',
        'X-Content-Type-Options': 'nosniff',
      },
    });
    try {
      const db2 = new PregoDb(':memory:');
      const { run } = await runAudit(db2, { project: 'Secure', target: secure.url, checks: ['security'], delayMs: 0, dataDir, maxPages: 2 });
      expect(db2.getTickets(run.id)).toEqual([]);
      db2.close();
    } finally {
      await secure.close();
    }
  }, 60_000);
});

describe('analyseHeaders (HTTPS cases the local fixtures cannot serve)', () => {
  const ids = (report: Parameters<typeof analyseHeaders>[0]) => analyseHeaders(report).map((r) => r.ruleId).sort();
  const good = {
    'content-security-policy': "default-src 'self'; frame-ancestors 'none'",
    'strict-transport-security': 'max-age=31536000',
    'referrer-policy': 'no-referrer',
    'permissions-policy': 'camera=()',
    'x-content-type-options': 'nosniff',
  };

  it('accepts a well-configured HTTPS site', () => {
    expect(ids({ url: 'https://example.org/', headers: good, cookies: ['sid=1; Secure; HttpOnly; SameSite=Lax'], resources: ['https://example.org/a.css'] })).toEqual([]);
  });

  it('flags plain HTTP on a public site, missing HSTS and mixed content', () => {
    expect(ids({ url: 'http://example.org/', headers: good, cookies: [], resources: [] })).toEqual(['no-https']);
    const { 'strict-transport-security': _hsts, ...noHsts } = good;
    expect(ids({ url: 'https://example.org/', headers: noHsts, cookies: [], resources: ['http://cdn.example.org/a.js'] })).toEqual(['missing-hsts', 'mixed-content']);
  });

  it('flags weak policies, insecure cookies and version numbers', () => {
    const report = analyseHeaders({
      url: 'https://example.org/',
      headers: { ...good, 'content-security-policy': "default-src 'self' 'unsafe-inline'", server: 'Apache/2.4.41', 'x-frame-options': 'DENY' },
      cookies: ['session=abc; Path=/'],
      resources: [],
    });
    expect(report).toEqual([
      { ruleId: 'weak-csp', detail: "The policy allows 'unsafe-inline' for scripts: default-src 'self' 'unsafe-inline'." },
      { ruleId: 'insecure-cookie', detail: 'Cookie “session” is set without Secure, HttpOnly, SameSite.' },
      { ruleId: 'server-version-disclosed', detail: 'Headers reveal software versions: Apache/2.4.41.' },
    ]);
  });
});

describe('HTML validity on bad-site', () => {
  it('reports the deprecated <center> element', () => {
    const center = tickets.find((t) => t.ruleId === 'deprecated')!;
    expect(center).toMatchObject({ category: 'TECH', engine: 'html-validate', exampleSelector: 'html > body > main > center' });
    expect(center.title).toMatch(/^Invalid HTML: <center> is deprecated/);
    expect(new URL(center.exampleLocation!).pathname).toBe('/');
  });
});

describe('broken links on bad-site', () => {
  it('raises one ticket for the broken link, on the page that links to it, with the link outlined', () => {
    const broken = tickets.filter((t) => t.ruleId === 'broken-link');
    expect(broken).toHaveLength(1);
    expect(broken[0]).toMatchObject({ category: 'UX', exampleSelector: expect.stringMatching(/a$/), templateKey: null });
    expect(broken[0].actual).toMatch(/^The link “See the Mark IV” goes to http:\/\/127\.0\.0\.1:\d+\/products\/mark-iv\.html, which returns HTTP 404\.$/);
    expect(db.getOccurrences(runId, broken[0].ticketId)[0].crop).toMatch(/^crops/);
  });
});
