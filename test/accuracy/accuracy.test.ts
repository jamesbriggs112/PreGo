import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PregoDb } from '../../packages/core/src/db/database.js';
import { runAudit } from '../../packages/core/src/audit/run-audit.js';
import type { Location, RawFinding, Run, Ticket } from '../../packages/core/src/types.js';

// Accuracy regressions: each false positive found by checking real reports against live sites
// (qa/QA-FINDINGS.md), rebuilt as a small page in fixtures/accuracy-site, and the right outcome for each.

const dataDir = mkdtempSync(join(tmpdir(), 'prego-accuracy-'));
let db: PregoDb;
let run: Run;
let tickets: Ticket[];
let findings: RawFinding[];
let locations: Location[];

beforeAll(async () => {
  db = new PregoDb(':memory:');
  ({ run } = await runAudit(db, {
    project: 'Riverside',
    target: 'fixtures/accuracy-site',
    checks: ['axe', 'a11y-custom', 'spelling', 'links'],
    auditAll: true,
    delayMs: 0,
    dataDir,
  }));
  run = db.getRun(run.id)!;
  tickets = db.getTickets(run.id);
  findings = db.getRawFindings(run.id);
  locations = db.getLocations(run.id);
}, 300_000);

afterAll(() => {
  db?.close();
  rmSync(dataDir, { recursive: true, force: true });
});

describe('accuracy: false positives from real reports stay fixed', () => {
  it('a file download is a document, not a broken link or a page', () => {
    expect(tickets.filter((t) => t.ruleId === 'broken-link')).toEqual([]);
    expect((run.summary.documents as { url: string }[]).map((d) => new URL(d.url).pathname)).toEqual(['/brochure.pdf']);
    expect(locations.some((l) => l.url.endsWith('.pdf'))).toBe(false);
  });

  it('an RSS feed isn’t audited as a page', () => {
    expect(locations.some((l) => l.url.endsWith('.rss'))).toBe(false);
  });

  it('a video player and an embedded form aren’t keyboard traps, and need no focus ring of their own', () => {
    const media = findings.filter((f) => /^<(video|iframe)/.test(f.html));
    expect(media.filter((f) => ['keyboard-trap', 'focus-not-visible'].includes(f.ruleId))).toEqual([]);
  });

  it('a site-wide header button and footer link are one ticket each, whatever the page type', () => {
    const button = tickets.filter((t) => t.ruleId === 'button-name');
    expect(button).toHaveLength(1);
    expect(button[0]).toMatchObject({ locationsAffected: 5, title: expect.stringMatching(/site header, every page/) });
    expect(tickets.filter((t) => t.ruleId === 'link-name')).toHaveLength(1);
  });

  it('spelling ignores joined lines, cookie names and Welsh, and still finds the real typo', () => {
    expect(tickets.filter((t) => t.ruleId === 'spelling').map((t) => /“(.+)”/.exec(t.title)![1])).toEqual(['accomodate']);
  });
});
