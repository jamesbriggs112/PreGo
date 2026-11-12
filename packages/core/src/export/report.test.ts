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
import { parseAnalyticsCsv, mergeAnalytics, normalisePath, trafficByPath, AnalyticsImportError } from './analytics.js';
import { busiestPages } from './sections.js';
import { ticketsCsv } from './csv.js';
import { reportDocx, scopeSentence } from './docx.js';
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

async function reportText(dir: string, file = 'report.docx') {
  const zip = await JSZip.loadAsync(readFileSync(join(dir, file)));
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
      reports: { overview: false, audience: false, future: false },
      include: { client: false, analytics: false, content: false, ia: true, profile: false, competitors: false },
      text: { summary: ' Hello ' },
    });
    expect(parseReportOptions({ reports: { overview: true, other: true } }).reports).toEqual({ overview: true, audience: false, future: false });
    expect(listItems('- One\n2. Two\n\n• Three\n')).toEqual(['One', 'Two', 'Three']);
  });

  it('numbers sections from what is included, with findings after the scene-setting', () => {
    const all = { analytics: true, content: true, ia: true, competitors: true };
    expect(reportOutline({ mode: 'crawl' }, DEFAULT_REPORT_OPTIONS, all).map((o) => `${o.number} ${o.id}`)).toEqual(['2 summary', '3 method', '4 findings', '5 map', '6 limitations']);
    const client: ReportOptions = { clientFacing: true, reports: { overview: false, audience: false, future: false }, include: all, text: { conclusion: 'Done.' } };
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

const GA_LANDING = `Landing page + query string,Sessions,Active users,Key events
/,500,400,12
/contact.html?utm_source=x,120,100,30
`;
const GA_EVENTS = `Event name,Event count,Key events
page_view,5000,0
form_submit,80,80
`;
const GA_PAGES = `Page path and screen class,Views,Active users
/,600,500
/index.html,100,80
/about.html,200,150
/news/post-1.html,50,40
/contact.html,50,30
`;
const GSC_QUERIES = `Top queries,Clicks,Impressions,CTR,Position
acme widgets,120,800,15%,1.2
widget opening times,3,600,0.5%,4.1
contact acme,20,150,13.3%,2
`;
const GSC_COUNTRIES = `Country,Clicks,Impressions,CTR,Position
United Kingdom,140,1400,10%,2.5
`;

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

  it('reads landing pages, key events and Search Console, telling Search Console’s countries from GA’s', () => {
    const a = parseAnalyticsCsv([
      { name: 'landing.csv', text: GA_LANDING },
      { name: 'events.csv', text: GA_EVENTS },
      { name: 'Queries.csv', text: GSC_QUERIES },
      { name: 'Countries.csv', text: GSC_COUNTRIES },
    ]);
    expect(a.tables.map((t) => [t.id, t.measure])).toEqual([
      ['landing', 'Active users'],
      ['events', 'Key events'],
    ]);
    expect(a.search!.queries[0]).toEqual({ label: 'acme widgets', clicks: 120, impressions: 800, ctr: 15, position: 1.2 });
    expect(a.search!.countries).toHaveLength(1);
    expect(a.tables.some((t) => t.id === 'countries')).toBe(false);
  });

  it('adds a new import to the last, a report replacing the same report', () => {
    const first = parseAnalyticsCsv([{ name: 'traffic.csv', text: GA_CHANNELS }, { name: 'devices.csv', text: GA_DEVICES }]);
    const merged = mergeAnalytics(first, parseAnalyticsCsv([{ name: 'Queries.csv', text: GSC_QUERIES }, { name: 'devices2.csv', text: 'Device category,Active users\nmobile,5\n' }]));
    expect(merged.tables.map((t) => t.id)).toEqual(['channels', 'devices']);
    expect(merged.tables[1].rows).toEqual([{ label: 'mobile', value: 5, engagementSeconds: undefined }]);
    expect(merged.search!.queries).toHaveLength(3);
    expect(merged.files).toEqual(['traffic.csv', 'devices.csv', 'Queries.csv', 'devices2.csv']);
  });

  it('works out each page’s share of visits, matching addresses however they’re written', () => {
    expect(['https://acme.example/about.html?x=1', '/news/', '/index.html', 'Home page', ''].map(normalisePath)).toEqual(['/about.html', '/news', '/', null, null]);
    const shares = trafficByPath(parseAnalyticsCsv([{ name: 'pages.csv', text: GA_PAGES }]))!;
    // Active users: (500 + 80) of 800, with / and /index.html counted as one page.
    expect(shares.get('/')).toBeCloseTo(0.725, 3);
    expect(shares.get('/about.html')).toBeCloseTo(0.1875, 4);
    // Without GA page figures, Search Console's pages are used.
    expect(trafficByPath(parseAnalyticsCsv([{ name: 'Pages.csv', text: 'Top pages,Clicks,Impressions,CTR,Position\nhttps://acme.example/,30,90,33%,1\nhttps://acme.example/about.html,10,50,20%,3\n' }]))!.get('/')).toBe(0.75);
  });

  it('raises the priority of issues on busy pages, and shows the traffic in the CSV and report', async () => {
    const projectId = db.getRun(runId)!.projectId;
    db.saveProjectSettings(projectId, { analytics: parseAnalyticsCsv([{ name: 'pages.csv', text: GA_PAGES }, { name: 'Queries.csv', text: GSC_QUERIES }]) });
    db.saveReportOptions(runId, { ...DEFAULT_REPORT_OPTIONS, include: { analytics: true, content: false, ia: false, competitors: false } });
    const plan = buildExportPlan(db, runId);
    const before = new Map(db.getTickets(runId).map((t) => [t.ticketId, t.priority]));
    const home = plan.tickets.filter((t) => t.occurrenceList.some((o) => normalisePath(o.location.url) === '/'));
    expect(home.length).toBeGreaterThan(0);
    for (const t of home) {
      expect(t.traffic).toBeGreaterThanOrEqual(0.7);
      expect(t.priorityRaised).toBe(before.get(t.ticketId) !== 'P1');
      if (t.priorityRaised) expect(t.priority < before.get(t.ticketId)!).toBe(true);
    }
    expect(busiestPages(plan)[0]).toMatchObject({ path: '/', share: expect.closeTo(0.725, 3), issues: expect.any(Number) });

    // Built directly rather than exported: exporting deletes the screenshots later tests use.
    const [header, ...rows] = parse(ticketsCsv(plan).replace(/^\uFEFF/, '')) as string[][];
    const traffic = header.indexOf('Traffic share');
    expect(header.slice(-2)).toEqual(['Traffic share', 'Affects']);
    expect(rows.some((r) => /^\d+% of visits \(priority raised\)$/.test(r[traffic]))).toBe(true);
    const zip = await JSZip.loadAsync(await reportDocx(plan, join(dataDir, 'runs', String(runId))));
    const text = (await zip.file('word/document.xml')!.async('string')).replace(/<\/w:p>/g, '\n').replace(/<[^>]+>/g, '');
    expect(text).toContain('What people search for');
    expect(text).toMatch(/widget opening times\n3\n600\n0\.5%\n4\.1/);
    expect(text).toContain('show the site on the first page of results but are rarely clicked: “widget opening times”');
    expect(text).toContain('Issues on the busiest pages');
    expect(text).toMatch(/raised: pages with \d+% of visits/);
    db.saveProjectSettings(projectId, { analytics: undefined });
  }, 120_000);
});

describe('the client report', () => {
  it('is its own file, with a contents page, the written sections and every optional section, numbered in order', async () => {
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
    const { zip, text } = await reportText(exported.dir, 'client-report.docx');
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

    // report.docx is still the developer report, with ticket IDs, and tickets.csv points to its sections.
    const developer = (await reportText(exported.dir)).text;
    expect(developer).toMatch(/PRG-[A-Z0-9]+-\d{3}/);
    expect(developer).toContain('5. Findings by category');
    const [header, ...rows] = parse(readFileSync(exported.files.tickets, 'utf8').replace(/^\uFEFF/, '')) as string[][];
    const section = header.indexOf('Report section');
    expect(rows.every((r) => /^5\.\d+$/.test(r[section]))).toBe(true);
    expect(JSON.parse(readFileSync(exported.files.runJson, 'utf8')).reports).toEqual(['report.docx', 'client-report.docx']);
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
    db.saveReportOptions(runId, { ...DEFAULT_REPORT_OPTIONS, reports: { overview: true, audience: false, future: false } });
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

  it('lists Future readiness once, and says when the crawl stopped early or only a sample was audited', async () => {
    const { run } = await runAudit(db, { project: 'Future', target: 'fixtures/future-site', checks: ['future', 'axe'], delayMs: 0, dataDir });
    const plan = buildExportPlan(db, run.id);
    const text = await textOf(await overviewDocx(plan, DEFAULT_WHY_IT_MATTERS));
    expect(text.match(/^Future readiness$/gm)).toHaveLength(1);
    expect(text).not.toMatch(/stopped|were audited: up to/);

    const found = plan.locations.filter((l) => l.statusCode !== null && l.statusCode < 400).length;
    const partial = {
      ...plan,
      run: { ...plan.run, summary: { ...plan.run.summary, stoppedEarly: true, stopReason: 'time limit' }, settings: { ...plan.run.settings, auditAll: false, perTemplate: 3 } },
      locations: plan.locations.map((l, i) => (i === 0 ? l : { ...l, audited: false })),
    };
    expect(scopeSentence(partial)).toContain(`. The crawl stopped after ${found} ${found === 1 ? 'page' : 'pages'} (time limit reached), so some pages weren’t checked`);
    expect(scopeSentence(partial)).toContain(`. 1 of ${found} pages were audited: up to 3 of each page template.`);
  }, 120_000);

  it('uses the audit’s own wording when it has some', async () => {
    db.saveReportOptions(runId, { ...DEFAULT_REPORT_OPTIONS, reports: { overview: true, audience: false, future: false }, text: { whyItMatters: 'Acme’s site is how members renew.', keyFindings: '- Forms lack labels' } });
    const text = await textOf(await overviewDocx(buildExportPlan(db, runId), DEFAULT_WHY_IT_MATTERS));
    expect(text).toContain('Acme’s site is how members renew.');
    expect(text).not.toContain('Regular checks like this one');
    expect(text).toMatch(/Key findings\nForms lack labels\n/);
  });

  it('says what the site is for, with gaps and who it serves, when the project has purposes', async () => {
    const projectId = db.getRun(runId)!.projectId;
    db.saveProjectSettings(projectId, {
      audience: {
        updatedAt: '',
        purposes: [
          { id: 'sell', title: 'Show and sell products', description: '', current: true, intended: true, priority: 'primary', evidence: [] },
          { id: 'book', title: 'Help people book a demo', description: '', current: false, intended: true, priority: 'secondary', evidence: [] },
        ],
        personas: [{ id: 'p1', name: 'Member of staff', summary: 'Works at Acme.', context: '', device: 'desktop', accessNeeds: '', internal: true, purposeIds: ['sell'] }],
        tasks: [{ id: 't1', personaId: 'p1', goal: 'Find the Mark IV price', doneWhen: '', success: { kind: 'described' } }],
      },
    });
    db.saveReportOptions(runId, { ...DEFAULT_REPORT_OPTIONS, reports: { overview: true, audience: false, future: false } });
    const text = await textOf(await overviewDocx(buildExportPlan(db, runId), DEFAULT_WHY_IT_MATTERS));
    expect(text).toMatch(/\d\. Where to focus\n(.|\n)*\d\. What the site is for\n/);
    expect(text).toMatch(/Show and sell products\nMain\nYes\nYes\n/);
    expect(text).toContain('Gaps: the site doesn’t yet help people book a demo.');
    expect(text).toContain('Member of staff (internal): Works at Acme. Comes to find the Mark IV price.');
    db.saveProjectSettings(projectId, { audience: undefined });
  });

  it('is written into the export only when chosen', async () => {
    db.saveReportOptions(runId, { ...DEFAULT_REPORT_OPTIONS, reports: { overview: true, audience: false, future: false } });
    const withOverview = await exportRun(db, runId, { dataDir, outDir: join(dataDir, 'with-overview') });
    expect(withOverview.files.overview).toBe(join(withOverview.dir, 'overview.docx'));
    expect(JSON.parse(readFileSync(withOverview.files.runJson, 'utf8')).reports).toEqual(['report.docx', 'overview.docx']);
    db.saveReportOptions(runId, DEFAULT_REPORT_OPTIONS);
    const without = await exportRun(db, runId, { dataDir, outDir: join(dataDir, 'without-overview') });
    expect(without.files.overview).toBeUndefined();
    expect(existsSync(join(without.dir, 'overview.docx'))).toBe(false);
  }, 120_000);
});
