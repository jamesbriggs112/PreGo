import { afterAll, describe, expect, it } from 'vitest';
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import JSZip from 'jszip';
import { PregoDb } from '../db/database.js';
import { runAudit } from '../audit/run-audit.js';
import { asFreshAudit, restoreRun, type RunJson } from './restore.js';
import { buildTickets } from '../tickets/build.js';
import { buildExportPlan } from './plan.js';
import { pageCount, reportDocument, reportDocx } from './docx.js';
import { overviewDocument } from './overview.js';
import { DEFAULT_WHY_IT_MATTERS } from '../settings.js';
import { DEFAULT_REPORT_OPTIONS } from './report-options.js';

// The client report is read by people who don't build websites: short sentences, and no technical
// words outside the glossary and the appendix at the back.

const JARGON = /\b(ARIA|landmarks?|viewports?|DOM|selectors?|axe|IBM|Lighthouse|globs?|CVE)\b/;
const dataDir = mkdtempSync(join(tmpdir(), 'prego-readability-'));
afterAll(() => rmSync(dataDir, { recursive: true, force: true }));

/** The client report's own prose, from At a glance up to the appendix: no tables, code or addresses. */
async function prose(db: PregoDb, runId: number): Promise<string[]> {
  db.saveReportOptions(runId, { ...DEFAULT_REPORT_OPTIONS, clientFacing: true });
  const xml = await (await JSZip.loadAsync(await reportDocx(buildExportPlan(db, runId), dataDir))).file('word/document.xml')!.async('string');
  const text = xml
    .replace(/<w:tbl>[\s\S]*?<\/w:tbl>/g, '')
    .replace(/<\/w:p>/g, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"');
  // From the second "At a glance" (the first is the contents page) to the appendix.
  const start = text.indexOf('\n1. At a glance\n', text.indexOf('\n1. At a glance\n') + 1);
  const end = text.search(/\n\d+\. Methodology\n(?![\s\S]*\n\d+\. Methodology\n)/);
  return text
    .slice(start, end)
    .split('\n')
    .map((l) => l.trim().replace(/https?:\/\/\S+/g, ''))
    .filter((l) => l && !l.startsWith('<'));
}

function measure(lines: string[]) {
  const sentences = lines
    .filter((l) => /[.!?]$/.test(l))
    .flatMap((l) => l.replace(/^[^:]{1,30}: /, '').split(/(?<=[.!?])\s+/))
    .filter((s) => /\w/.test(s));
  const words = sentences.map((s) => s.split(/\s+/).length);
  return { average: words.reduce((a, b) => a + b, 0) / Math.max(1, words.length), longest: Math.max(0, ...words), jargon: lines.filter((l) => JARGON.test(l)) };
}

describe('the client report reads plainly', () => {
  it('on a small site: sentences under 20 words on average, and no jargon before the appendix', async () => {
    const db = new PregoDb(':memory:');
    const { run } = await runAudit(db, { project: 'Acme', target: 'fixtures/bad-site', checks: ['axe', 'ibm', 'a11y-custom', 'security', 'content'], delayMs: 0, dataDir });
    const result = measure(await prose(db, run.id));
    db.close();
    expect(result.jargon).toEqual([]);
    expect(result.average).toBeLessThan(20);
  }, 180_000);

  const DIR = join(process.cwd(), 'fixtures', 'qa-2026-11');
  const files = existsSync(DIR) ? readdirSync(DIR).filter((f) => f.endsWith('.json')) : [];
  it.skipIf(!files.length).each(files)(
    'on the real audit %s',
    async (file) => {
      const db = new PregoDb(':memory:');
      const runId = restoreRun(db, asFreshAudit(JSON.parse(readFileSync(join(DIR, file), 'utf8')) as RunJson));
      buildTickets(db, runId);
      const result = measure(await prose(db, runId));
      // Short enough to read: the client report under 25 pages, the overview two at most.
      const plan = buildExportPlan(db, runId);
      const pages = { client: pageCount(reportDocument(plan, dataDir)), overview: pageCount(overviewDocument(plan, DEFAULT_WHY_IT_MATTERS)) };
      db.close();
      expect(result.jargon).toEqual([]);
      expect(result.average).toBeLessThan(20);
      expect(result.longest).toBeLessThanOrEqual(40);
      expect(pages.client).toBeLessThan(25);
      expect(pages.overview).toBeLessThanOrEqual(2);
    },
    120_000,
  );
});
