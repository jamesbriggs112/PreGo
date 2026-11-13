import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import JSZip from 'jszip';
import { PregoDb } from '../../db/database.js';
import { runAudit } from '../../audit/run-audit.js';
import { exportRun } from '../../export/bundle.js';
import { assessReadiness } from '../../export/readiness.js';
import { DEFAULT_REPORT_OPTIONS } from '../../export/report-options.js';
import { aiCrawlerAccess, sitemapDates, textOfHtml } from './future.js';
import { imageSize, type SharingMetrics } from '../sharing/sharing.js';
import type { FutureMetrics } from './future.js';

const dataDir = mkdtempSync(join(tmpdir(), 'prego-future-'));
const db = new PregoDb(':memory:');
let runId: number;

beforeAll(async () => {
  const { run } = await runAudit(db, { project: 'Riverside', target: 'fixtures/future-site', checks: ['content', 'sharing', 'future', 'structure'], delayMs: 0, dataDir });
  runId = run.id;
}, 120_000);

afterAll(() => {
  db.close();
  rmSync(dataDir, { recursive: true, force: true });
});

describe('reading what the site publishes', () => {
  it('measures image files from their headers', () => {
    expect(imageSize(readFileSync('fixtures/future-site/images/share.png'))).toEqual({ width: 1200, height: 630, type: 'png' });
    const jpeg = Buffer.from('ffd8ffe000104a46494600010100000100010000ffc00011080276049c03012200021101031101', 'hex');
    expect(imageSize(jpeg)).toEqual({ width: 1180, height: 630, type: 'jpeg' });
    const gif = Buffer.from('474946383961' + '4b00' + '3200' + '000000', 'hex');
    expect(imageSize(gif)).toEqual({ width: 75, height: 50, type: 'gif' });
    expect(imageSize(Buffer.from('not an image'))).toBeNull();
  });

  it('reads HTML as a crawler without JavaScript would, robots.txt rules per AI crawler, and sitemap dates', () => {
    expect(textOfHtml('<html><head><style>p{}</style><script>var x = "hidden";</script></head><body><p>Hello &amp; welcome</p><!-- note --></body></html>')).toBe('Hello welcome');
    const access = aiCrawlerAccess('https://example.org', 'User-agent: GPTBot\nDisallow: /\n\nUser-agent: *\nAllow: /\n');
    expect(access?.filter((c) => !c.allowed).map((c) => c.agent)).toEqual(['GPTBot']);
    expect(sitemapDates('<urlset><url><loc>a</loc><lastmod>2026-01-01</lastmod></url><url><loc>b</loc></url></urlset>')).toEqual({ urls: 2, withDates: 1 });
  });
});

describe('the checks on a fixture site', () => {
  const pageMetrics = (path: string) => db.getLocations(runId).find((l) => new URL(l.url).pathname === path)!.metrics;

  it('raises tickets for what needs fixing', () => {
    const rules = new Set(db.getTickets(runId).map((t) => t.ruleId));
    for (const rule of ['content-needs-javascript', 'structured-data-invalid', 'share-image-small', 'share-image-relative', 'canonical-missing', 'twitter-card-missing']) expect(rules).toContain(rule);
    // The home page does it all properly.
    for (const rule of ['organisation-data-missing', 'structured-data-missing', 'sitemap-no-dates', 'touch-icon-missing', 'share-image-broken']) expect(rules).not.toContain(rule);
  });

  it('records what each page shows to search, sharing and AI', () => {
    const home = pageMetrics('/').future as FutureMetrics;
    expect(home).toMatchObject({ schemaTypes: expect.arrayContaining(['Organization', 'FAQPage', 'ContactPoint']), questionHeadings: 1, summaryFirst: true, phones: ['442079460000'] });
    expect(home.textWithoutJs).toBeGreaterThan(0.8);
    expect((pageMetrics('/app.html').future as FutureMetrics).textWithoutJs).toBeLessThan(0.5);
    const sharing = pageMetrics('/').sharing as SharingMetrics;
    expect(sharing.image).toMatchObject({ ok: true, width: 1200, height: 630, file: expect.stringMatching(/^sharing\/[0-9a-f]{12}\.png$/) });
  });

  it('assesses readiness area by area, without counting deliberate crawler choices as failures', () => {
    const readiness = assessReadiness(db.getLocations(runId))!;
    const byId = Object.fromEntries(readiness.items.map((i) => [i.id, i]));
    expect(byId.crawlers).toMatchObject({ status: 'partly', found: expect.stringContaining('GPTBot, CCBot') });
    expect(byId.contact).toMatchObject({ status: 'partly', found: expect.stringContaining('2 different phone numbers') });
    expect(byId.sitemap.status).toBe('good');
    expect(byId.voice.status).toBe('good');
    expect(readiness.score).toBeGreaterThan(30);
    expect(readiness.score).toBeLessThan(100);
  });
});

describe('the Search, sharing and future readiness report', () => {
  it('is written into the pack with previews, no ticket IDs, and the share images deleted afterwards', async () => {
    db.saveReportOptions(runId, { ...DEFAULT_REPORT_OPTIONS, reports: { overview: true, audience: false, future: true }, text: { future: 'Start with the members page.' } });
    const exported = await exportRun(db, runId, { dataDir, outDir: join(dataDir, 'pack') });
    expect(exported.files.future).toBe(join(exported.dir, 'future.docx'));
    const zip = await JSZip.loadAsync(readFileSync(exported.files.future!));
    const text = (await zip.file('word/document.xml')!.async('string')).replace(/<\/w:p>/g, '\n').replace(/<[^>]+>/g, '');
    expect([...text.matchAll(/^(\d+)\. (.+)$/gm)].map((m) => m[2])).toEqual([
      'At a glance',
      'How the site looks in search and when shared',
      'AI assistants and answer engines',
      'Voice search and spoken answers',
      'What to do',
      'About these results',
    ]);
    expect(text).toMatch(/Future readiness: \d+ \/ 100/);
    expect(text).toMatch(/GPTBot\nOpenAI\nTraining\nBlocked\n/);
    expect(text).toContain('Start with the members page.');
    expect(text).toContain('It didn’t look for an llms.txt file');
    expect(text).not.toMatch(/PRG-[A-Z0-9]+-\d{3}/);
    // A preview picture per page chosen: the home page, then pages with a different share image.
    expect(Object.keys(zip.files).filter((f) => f.startsWith('word/media/')).length).toBe(3);
    // The Overview scores future readiness and lists the report in the pack.
    const overview = (await (await JSZip.loadAsync(readFileSync(exported.files.overview!))).file('word/document.xml')!.async('string')).replace(/<[^>]+>/g, ' ');
    expect(overview).toMatch(/Future readiness\s+(Good|Needs attention|Needs significant work)\s+\d+ \/ 100/);
    expect(overview).toContain('future.docx');
    expect(existsSync(join(dataDir, 'runs', String(runId), 'sharing'))).toBe(false);
  }, 120_000);
});
