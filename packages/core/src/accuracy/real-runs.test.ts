import { describe, expect, it } from 'vitest';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { PregoDb } from '../db/database.js';
import { asFreshAudit, restoreRun, type RunJson } from '../export/restore.js';
import { buildTickets } from '../tickets/build.js';
import { buildExportPlan } from '../export/plan.js';
import { categoryScores } from '../export/docx.js';
import { actionPlan } from '../export/action-plan.js';

// Real audits kept on this computer only (fixtures/qa-*/ is git-ignored, as they hold client data).
// When they're here, rebuild their tickets and scores with the current rules and print them, so
// accuracy changes can be compared before and after. Elsewhere these tests are skipped.

const DIR = join(process.cwd(), 'fixtures', 'qa-2026-11');
const files = existsSync(DIR) ? readdirSync(DIR).filter((f) => f.endsWith('.json')) : [];

function rebuild(file: string, estimate = false) {
  const db = new PregoDb(':memory:');
  const json = JSON.parse(readFileSync(join(DIR, file), 'utf8')) as RunJson;
  const runId = restoreRun(db, estimate ? asFreshAudit(json) : json);
  buildTickets(db, runId);
  const plan = buildExportPlan(db, runId);
  const scores = Object.fromEntries(
    categoryScores(plan)
      .filter((c) => c.score !== null)
      .map((c) => [c.category, c.score]),
  );
  const tickets = db.getTickets(runId);
  db.close();
  return { tickets, scores };
}

describe.skipIf(!files.length)('real audits, rebuilt with the current rules', () => {
  it.each(files)(
    '%s',
    (file) => {
      const { tickets, scores } = rebuild(file);
      const count = (rule: string) => tickets.filter((t) => t.ruleId === rule).length;
      console.log(file, { tickets: tickets.length, scores, 'button-name': count('button-name'), 'link-name': count('link-name'), 'target-size-touch': count('target-size-touch') });
      expect(tickets.length).toBeGreaterThan(0);
      const fresh = rebuild(file, true);
      console.log(file, 'as a fresh audit would be (estimate)', { tickets: fresh.tickets.length, scores: fresh.scores });
    },
    120_000,
  );

  it('merges copies of a page and leaves later list pages unaudited (QA-09)', () => {
    const four = files.find((f) => f.startsWith('four-agency'));
    const fcn = files.find((f) => f.startsWith('fcn-police'));
    if (four) {
      const fresh = asFreshAudit(JSON.parse(readFileSync(join(DIR, four), 'utf8')) as RunJson);
      expect(fresh.locations.filter((l) => /\/node\/1385$/.test(l.url))).toHaveLength(1);
    }
    if (fcn) {
      const fresh = asFreshAudit(JSON.parse(readFileSync(join(DIR, fcn), 'utf8')) as RunJson);
      expect(fresh.locations.filter((l) => l.audited && /latest\/news\?page=[12]/.test(l.url))).toEqual([]);
    }
  });

  it('puts real, high-impact quick wins first in the action plan, each with who, effort and impact (R-03)', () => {
    const fcn = files.find((f) => f.startsWith('fcn-police'));
    if (!fcn) return;
    const db = new PregoDb(':memory:');
    const runId = restoreRun(db, asFreshAudit(JSON.parse(readFileSync(join(DIR, fcn), 'utf8')) as RunJson));
    buildTickets(db, runId);
    const rows = actionPlan(buildExportPlan(db, runId));
    db.close();
    expect(rows[0]).toMatchObject({ group: 'Quick wins', impact: 'High', fix: expect.stringMatching(/^Give buttons a name/), where: expect.stringMatching(/^Site header, every page/) });
    const quick = rows.filter((r) => r.group === 'Quick wins');
    expect(quick.slice(0, 5).some((r) => /^Give icon links/.test(r.fix) && /^Site footer/.test(r.where))).toBe(true);
    for (const r of rows) expect([r.who, r.effort, r.impact].every(Boolean)).toBe(true);
    expect(rows.some((r) => r.fix.startsWith('Fix: '))).toBe(false);
  });
});
