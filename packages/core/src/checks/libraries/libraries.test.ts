import { afterAll, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PregoDb } from '../../db/database.js';
import { runAudit } from '../../audit/run-audit.js';
import { scanScript } from './libraries.js';

const dataDir = mkdtempSync(join(tmpdir(), 'prego-libraries-'));
const db = new PregoDb(':memory:');

afterAll(() => {
  db.close();
  rmSync(dataDir, { recursive: true, force: true });
});

describe('outdated JavaScript libraries', () => {
  it('recognises libraries by file name and by content, and leaves current versions alone', () => {
    expect(scanScript('https://example.org/js/jquery-1.8.1.min.js', null).map((c) => `${c.component}@${c.version}`)).toEqual(['jquery@1.8.1']);
    expect(scanScript('https://example.org/js/vendor.js', '/*! jQuery v2.2.4 | (c) jQuery Foundation | jquery.org/license */').map((c) => c.version)).toEqual(['2.2.4']);
    // Current versions are recognised too, so newer advisories and end-of-life dates can be checked, but have no known vulnerabilities.
    expect(scanScript('https://example.org/js/jquery-3.7.1.min.js', null).flatMap((c) => c.vulnerabilities ?? [])).toEqual([]);
  });

  it('raises one site-wide ticket per vulnerable library, naming the version that fixes it', async () => {
    const { run } = await runAudit(db, { project: 'Old libs', target: 'fixtures/old-libs', checks: ['libraries'], delayMs: 0, dataDir });
    const tickets = db.getTickets(run.id);
    expect(tickets.map((t) => t.title).sort()).toEqual([
      'The site uses a JavaScript library with known security holes: jquery 1.8.1 (site-wide)',
      'The site uses a JavaScript library with known security holes: jquery 2.2.4 (site-wide)',
    ]);
    for (const t of tickets) {
      expect(t).toMatchObject({ category: 'SEC', engine: 'retire.js' });
      expect(t.actual).toMatch(/known vulnerabilit(y|ies) \(CVE-\d{4}-\d+.*\)\. Fixed in [\d.]+ or later\./);
      expect(t.recommendation).toMatch(/^Update the library/);
    }
  }, 60_000);
});
