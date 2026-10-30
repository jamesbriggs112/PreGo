import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import JSZip from 'jszip';
import { PregoDb } from '../../db/database.js';
import { runAudit, type AuditResult } from '../../audit/run-audit.js';
import { serveFolder, type StaticServer } from '../../serve/static-server.js';
import { exportRun } from '../../export/bundle.js';
import { unhelpfulAlt } from '../content/content.js';
import type { LighthouseScores } from './lighthouse.js';

const dataDir = mkdtempSync(join(tmpdir(), 'prego-lighthouse-'));
let site: StaticServer;
let db: PregoDb;
let result: AuditResult;
const requested = new Set<string>();

/** Chrome processes started by this test process (Lighthouse's browser). */
function childChromes(): number {
  try {
    return execFileSync('pgrep', ['-P', String(process.pid), '-f', 'Chrome for Testing'], { encoding: 'utf8' }).trim().split('\n').filter(Boolean).length;
  } catch {
    return 0;
  }
}

beforeAll(async () => {
  site = await serveFolder('fixtures/bad-site', { substituteOrigin: true });
  db = new PregoDb(':memory:');
  result = await runAudit(db, {
    project: 'Acme',
    target: site.url,
    checks: ['lighthouse', 'content'],
    delayMs: 0,
    dataDir,
    onRequest: (url) => requested.add(new URL(url).origin),
  });
}, 240_000);

afterAll(async () => {
  db?.close();
  await site?.close();
  rmSync(dataDir, { recursive: true, force: true });
});

describe('Lighthouse module', () => {
  it('records scores for one page per template', () => {
    expect(result.run.status).toBe('complete');
    const withScores = result.locations.filter((l) => l.metrics.lighthouse);
    expect(withScores.map((l) => new URL(l.url).pathname).sort()).toEqual(['/', '/about.html', '/contact.html', '/news/post-1.html']);
    for (const l of withScores) {
      const s = l.metrics.lighthouse as LighthouseScores;
      for (const value of [s.performance, s.bestPractices, s.seo]) expect(value).toBeGreaterThanOrEqual(0);
      expect(s.formFactor).toBe('desktop');
    }
  });

  it('turns failing audits into site-wide tickets, without repeating what other checks cover', () => {
    const tickets = db.getTickets(result.run.id);
    const lighthouse = tickets.filter((t) => t.engine === 'lighthouse');
    expect(lighthouse.every((t) => t.templateKey === null && t.title.endsWith('(site-wide)'))).toBe(true);
    expect(lighthouse.some((t) => t.ruleId === 'meta-description')).toBe(false);
    expect(tickets.find((t) => t.ruleId === 'meta-description-missing')).toMatchObject({ engine: 'prego', category: 'CONT', locationsAffected: 2 });
  });

  it('puts the scores in the report', async () => {
    const exported = await exportRun(db, result.run.id, { dataDir });
    const zip = await JSZip.loadAsync(readFileSync(exported.files.report));
    const text = (await zip.file('word/document.xml')!.async('string')).replace(/<\/w:p>/g, '\n').replace(/<[^>]+>/g, '');
    expect(text).toContain('Lighthouse scores');
    expect(text).toMatch(/Page\s*Performance\s*Best practices\s*SEO\s*\/\s*\d+\s*\d+\s*\d+/);
    expect(text).toMatch(/Performance\s*\d+/);
  });

  it('only requests the target site, and shuts its browser down afterwards', () => {
    expect([...requested]).toEqual([site.origin]);
    expect(childChromes()).toBe(0);
  });
});

describe('alt text quality', () => {
  it('recognises alt text that describes nothing', () => {
    expect(unhelpfulAlt('IMG_4021.jpg')).toBe('it is a file name');
    expect(unhelpfulAlt('DSC_0042')).toBe('it looks like a camera or file reference');
    expect(unhelpfulAlt('image')).toBe('it only says what kind of thing it is');
    expect(unhelpfulAlt('Photo of')).toBe('it only says what kind of thing it is');
    expect(unhelpfulAlt('')).toBeNull();
    expect(unhelpfulAlt('Visitors at the Mark IV widget launch')).toBeNull();
  });
});
