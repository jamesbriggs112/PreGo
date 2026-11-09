import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import JSZip from 'jszip';
import { parse } from 'csv-parse/sync';
import { PregoDb } from '../db/database.js';
import { runAudit } from '../audit/run-audit.js';
import { serveFolder, type StaticServer } from '../serve/static-server.js';
import { buildExportPlan, reportOutline } from './plan.js';
import { exportRun } from './bundle.js';
import { parseAnalyticsCsv, AnalyticsImportError } from './analytics.js';
import { DEFAULT_REPORT_OPTIONS, listItems, parseReportOptions, type ReportOptions } from './report-options.js';
import { measureCopy } from './sections.js';
import { overviewDocx, scoreRating } from './overview.js';
import { verifyExport } from './verify.js';
import { DEFAULT_WHY_IT_MATTERS } from '../settings.js';
import { competitorUrls } from '../audit/competitors.js';

const dataDir = mkdtempSync(join(tmpdir(), 'prego-report-'));
const db = new PregoDb(':memory:');
let competitor: StaticServer;
let blocked: StaticServer;
let runId: number;

const GA_CHANNELS = `# ----------------------------------------
# Traffic acquisition: Session primary channel group (Default channel group)
# Account: Acme
# Property: Acme website
# ----------------------------------------
#
# All Users
# Start date: 20240714
# End date: 20250713
Session primary channel group (Default channel group),Active users,Sessions,Average engagement time per active user
Organic Search,"1,200",1800,90
Direct,600,700,60
Referral,200,240,30
`;
const GA_DEVICES = `# Start date: 20240714
# End date: 20250713
Device category,Active users
mobile,1100
desktop,900
tablet,40
Grand total,2040
`;

async function reportText(dir: string) {
  const zip = await JSZip.loadAsync(readFileSync(join(dir, 'report.docx')));
  return { zip, text: (await zip.file('word/document.xml')!.async('string')).replace(/<\/w:p>/g, '\n').replace(/<[^>]+>/g, '') };
}

beforeAll(async () => {
  competitor = await serveFolder('fixtures/typos-site');
  const blockedDir = join(dataDir, 'blocked-site');
  mkdirSync(blockedDir, { recursive: true });
  writeFileSync(join(blockedDir, 'index.html'), '<!doctype html><html lang="en"><title>Blocked</title><h1>Blocked</h1></html>');
  writeFileSync(join(blockedDir, 'robots.txt'), 'User-agent: *\nDisallow: /\n');
  blocked = await serveFolder(blockedDir);
  const { run } = await runAudit(db, {
    project: 'Acme',
    target: 'fixtures/bad-site',
    checks: ['axe', 'structure'],
    delayMs: 0,
    dataDir,
    competitors: [competitor.url, blocked.url, 'not an address !!'],
  });
  runId = run.id;
}, 400_000);

afterAll(async () => {
  db.close();
  await competitor?.close();
  await blocked?.close();
  rmSync(dataDir, { recursive: true, force: true });
});

describe('report options', () => {
  it('keeps only known fields, and reads written lists as items', () => {
    expect(parseReportOptions({ clientFacing: true, include: { ia: true, bogus: true }, text: { summary: ' Hello ', keyFindings: '', other: 'x' } })).toEqual({
      clientFacing: true,
      reports: { overview: false },
      include: { analytics: false, content: false, ia: true, competitors: false },
      text: { summary: ' Hello ' },
    });
    expect(parseReportOptions({ reports: { overview: true, other: true } }).reports).toEqual({ overview: true });
    expect(listItems('- One\n2. Two\n\n• Three\n')).toEqual(['One', 'Two', 'Three']);
  });

  it('numbers sections from what is included, with findings after the scene-setting', () => {
    const all = { analytics: true, content: true, ia: true, competitors: true };
    expect(reportOutline({ mode: 'crawl' }, DEFAULT_REPORT_OPTIONS, all).map((o) => `${o.number} ${o.id}`)).toEqual(['2 summary', '3 method', '4 findings', '5 map', '6 limitations']);
    const client: ReportOptions = { clientFacing: true, reports: { overview: false }, include: all, text: { conclusion: 'Done.' } };
    expect(reportOutline({ mode: 'crawl' }, client, all).map((o) => o.title)).toEqual([
      'Executive summary',
      'Methodology',
      'Analytics',
      'Findings by category',
      'Content and tone',
      'Information architecture',
      'Site map summary',
      'Competitor analysis',
      'Conclusion',
      'Limitations and manual testing',
    ]);
    // A section that's switched on but has nothing to show is left out.
    expect(reportOutline({ mode: 'crawl' }, client, { ...all, analytics: false }).map((o) => o.id)).not.toContain('analytics');
  });
});

describe('measurements for the optional sections', () => {
  it('measures reading ease, sentence length and who the copy talks to', () => {
    const easy = measureCopy('We make widgets. You can buy them here. They are cheap and they last.');
    expect(easy).toMatchObject({ words: 14, sentences: 3, longSentences: 0 });
    expect(easy.readingEase).toBeGreaterThan(80);
    expect(easy.youPer100).toBeCloseTo(7.1, 1);
    const hard = measureCopy('The organisation’s comprehensive pharmaceutical manufacturing capabilities facilitate the development of innovative formulations addressing unmet therapeutic requirements across multiple international jurisdictions simultaneously.');
    expect(hard.readingEase).toBeLessThan(10);
    expect(hard.longSentences).toBe(0);
  });

  it('records each audited page’s copy and the home page navigation', () => {
    const locations = db.getLocations(runId).filter((l) => l.audited);
    expect(locations.every((l) => l.metrics.content)).toBe(true);
    const home = locations.find((l) => l.depth === 0)!;
    expect((home.metrics.navigation as { items: { label: string }[] }).items.map((i) => i.label)).toEqual(['Home', 'About', 'News', 'Contact']);
  });

  it('scores this site and each competitor’s home page, skipping sites whose robots.txt says no', () => {
    const results = db.getRun(runId)!.summary.competitors as { url: string; own: boolean; desktop: { performance: number } | null; mobile: unknown; screenshot: string | null; error?: string }[];
    expect(results.map((r) => [r.own, r.url])).toEqual([
      [true, expect.stringMatching(/^http:\/\/127\.0\.0\.1:\d+\/$/)],
      [false, competitor.url],
      [false, blocked.url],
    ]);
    for (const r of results.slice(0, 2)) {
      expect(r.desktop?.performance).toBeGreaterThan(0);
      expect(r.mobile).not.toBeNull();
      expect(r.screenshot).toMatch(/^competitors\/\d\.jpg$/);
    }
    expect(results[2]).toMatchObject({ desktop: null, error: expect.stringMatching(/robots\.txt/) });
    expect(competitorUrls(['example.org', 'https://example.org/about', ' ', 'ftp://x.org', 'b.co.uk'])).toEqual(['https://example.org/', 'https://b.co.uk/']);
  });
});

describe('Google Analytics import', () => {
  it('reads GA4 CSV exports into figures, dropping account details and totals', () => {
    const a = parseAnalyticsCsv([
      { name: 'traffic.csv', text: GA_CHANNELS },
      { name: 'devices.csv', text: GA_DEVICES },
    ]);
    expect(a).toMatchObject({ files: ['traffic.csv', 'devices.csv'], period: '14 July 2024 to 13 July 2025', engagementSeconds: 75 });
    expect(a.tables.map((t) => [t.id, t.measure, t.rows.map((r) => [r.label, r.value])])).toEqual([
      ['channels', 'Active users', [['Organic Search', 1200], ['Direct', 600], ['Referral', 200]]],
      ['devices', 'Active users', [['mobile', 1100], ['desktop', 900], ['tablet', 40]]],
    ]);
    expect(JSON.stringify(a)).not.toMatch(/Acme website/);
    expect(() => parseAnalyticsCsv([{ name: 'other.csv', text: 'Name,Email\nA,b@c.d\n' }])).toThrow(AnalyticsImportError);
  });
});

describe('the client-facing report', () => {
  it('has a contents page, the written sections and every optional section, numbered in order', async () => {
    db.saveProjectSettings(db.getRun(runId)!.projectId, { analytics: parseAnalyticsCsv([{ name: 'traffic.csv', text: GA_CHANNELS }]) });
    db.saveReportOptions(runId, {
      clientFacing: true,
      include: { analytics: true, content: true, ia: true, competitors: true },
      text: {
        summary: 'Acme makes widgets.\n\nThis audit looks at the new site before launch.',
        keyFindings: '- Images are missing alt text\n- Some text is hard to read',
        conclusion: 'Fix the accessibility issues first.',
        competitors: 'Acme is faster than its rival.',
      },
    });
    const exported = await exportRun(db, runId, { dataDir, outDir: join(dataDir, 'client') });
    const { zip, text } = await reportText(exported.dir);
    const headings = [...text.matchAll(/^(\d+)\. (.+)$/gm)].map((m) => `${m[1]}. ${m[2]}`);
    const expected = [
      '1. Executive summary',
      '2. Methodology',
      '3. Analytics',
      '4. Findings by category',
      '5. Content and tone',
      '6. Information architecture',
      '7. Site map summary',
      '8. Competitor analysis',
      '9. Conclusion',
      '10. Limitations and manual testing',
    ];
    // Listed once on the contents page, then as the section headings.
    expect(headings).toEqual([...expected, ...expected]);
    expect(text).toContain('Website UX audit');
    expect(text).toMatch(/Acme makes widgets\.\nThis audit looks at the new site before launch\./);
    expect(text).toMatch(/Key findings\nImages are missing alt text\nSome text is hard to read/);
    expect(text).toMatch(/Top recommendations\n1\./);
    expect(text).toContain('We crawled the site through its links and sitemap');
    expect(text).toContain('How people find the site');
    expect(text).toContain('Average reading ease');
    expect(text).toContain('Main navigation');
    expect(text).toMatch(/\(this site\)/);
    expect(text).toContain('Acme is faster than its rival.');
    // No compliance claims: the only mention of meeting WCAG is the disclaimer that it doesn't show it.
    expect(text).not.toMatch(/\b(complies with|is compliant|are compliant|legally compliant)\b/i);
    expect(text.match(/meets WCAG/g)).toHaveLength(1);
    expect(text).toContain('It does not show that the product meets WCAG');
    // Charts for analytics and competitors, and competitor home page screenshots.
    expect(Object.keys(zip.files).filter((f) => /^word\/media\/.+\.jpe?g$/.test(f)).length).toBeGreaterThanOrEqual(2);

    // A client-facing report persuades; ticket IDs are for the team, in tickets.csv only.
    expect(text).not.toMatch(/PRG-[A-Z0-9]+-\d{3}/);
    expect(text).not.toContain('Ticket index');
    expect(text).toMatch(/Where: .+\. (Critical|High|Medium|Low) severity at worst\./);
    expect(await verifyExport(exported.dir)).toMatchObject({ ok: true, problems: [] });

    // Ticket report sections follow the findings section's number.
    const [header, ...rows] = parse(readFileSync(exported.files.tickets, 'utf8').replace(/^\uFEFF/, '')) as string[][];
    const section = header.indexOf('Report section');
    expect(rows.every((r) => /^4\.\d+$/.test(r[section]))).toBe(true);
  }, 120_000);

  it('the technical report leaves the written sections and empty optional sections out', () => {
    db.saveReportOptions(runId, { ...DEFAULT_REPORT_OPTIONS, include: { analytics: false, content: true, ia: false, competitors: false } });
    const plan = buildExportPlan(db, runId);
    expect(plan.outline.map((o) => o.title)).toEqual(['Executive summary', 'Scope and method', 'Findings by category', 'Content and tone', 'Site map summary', 'Limitations and manual testing']);
    expect(plan.tickets.every((t) => t.reportSection.startsWith('4.'))).toBe(true);
  });
});

describe('the Overview report', () => {
  const textOf = async (docx: Buffer) =>
    (await (await JSZip.loadAsync(docx)).file('word/document.xml')!.async('string')).replace(/<\/w:p>/g, '\n').replace(/<[^>]+>/g, '');

  it('rates scores in plain English', () => {
    expect([95, 90, 75, 55, 20].map(scoreRating)).toEqual(['In good shape', 'In good shape', 'A few things to fix', 'Needs attention', 'Needs significant work']);
  });

  it('opens with scores at a glance, then why it matters, findings, recommendations and the pack', async () => {
    db.saveReportOptions(runId, { ...DEFAULT_REPORT_OPTIONS, reports: { overview: true } });
    const text = await textOf(await overviewDocx(buildExportPlan(db, runId), DEFAULT_WHY_IT_MATTERS));
    expect([...text.matchAll(/^(\d+)\. (.+)$/gm)].map((m) => m[2])).toEqual([
      'At a glance',
      'Why a healthy website matters',
      'Key findings',
      'Top recommendations',
      'What’s in this pack',
      'About these results',
    ]);
    expect(text).toContain('Website health overview');
    expect(text).toMatch(/Accessibility\n\d+ \/ 100\n(In good shape|A few things to fix|Needs attention|Needs significant work)\n/);
    expect(text).toContain('Regular checks like this one catch problems while they’re small.');
    expect(text).not.toMatch(/\b(complies with|is compliant|are compliant|legally compliant)\b/i);
  });

  it('uses the audit’s own wording when it has some', async () => {
    db.saveReportOptions(runId, { ...DEFAULT_REPORT_OPTIONS, reports: { overview: true }, text: { whyItMatters: 'Acme’s site is how members renew.', keyFindings: '- Forms lack labels' } });
    const text = await textOf(await overviewDocx(buildExportPlan(db, runId), DEFAULT_WHY_IT_MATTERS));
    expect(text).toContain('Acme’s site is how members renew.');
    expect(text).not.toContain('Regular checks like this one');
    expect(text).toMatch(/Key findings\nForms lack labels\n/);
  });

  it('is written into the export only when chosen', async () => {
    db.saveReportOptions(runId, { ...DEFAULT_REPORT_OPTIONS, reports: { overview: true } });
    const withOverview = await exportRun(db, runId, { dataDir, outDir: join(dataDir, 'with-overview') });
    expect(withOverview.files.overview).toBe(join(withOverview.dir, 'overview.docx'));
    expect(JSON.parse(readFileSync(withOverview.files.runJson, 'utf8')).reports).toEqual(['report.docx', 'overview.docx']);
    db.saveReportOptions(runId, DEFAULT_REPORT_OPTIONS);
    const without = await exportRun(db, runId, { dataDir, outDir: join(dataDir, 'without-overview') });
    expect(without.files.overview).toBeUndefined();
    expect(existsSync(join(without.dir, 'overview.docx'))).toBe(false);
  }, 120_000);
});
