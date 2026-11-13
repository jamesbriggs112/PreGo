import { describe, expect, it } from 'vitest';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { PregoDb } from '../db/database.js';
import { restoreRun, type RunJson } from '../export/restore.js';
import { buildTickets } from '../tickets/build.js';
import { buildExportPlan } from '../export/plan.js';
import { categoryScores } from '../export/docx.js';
import { looksLikeFeed } from '../crawl/crawler.js';

// Real audits kept on this computer only (fixtures/qa-*/ is git-ignored, as they hold client data).
// When they're here, rebuild their tickets and scores with the current rules and print them, so
// accuracy changes can be compared before and after. Elsewhere these tests are skipped.

const DIR = join(process.cwd(), 'fixtures', 'qa-2026-11');
const files = existsSync(DIR) ? readdirSync(DIR).filter((f) => f.endsWith('.json')) : [];

/**
 * Leave out what the crawl and checks no longer produce (file links reported as broken, feeds audited
 * as pages, keyboard traps on players and frames), to estimate a fresh audit. Spelling can't be
 * re-read from a saved run, so it's left as it was.
 */
function withoutFixedFalsePositives(json: RunJson): RunJson {
  const feeds = new Set(json.locations.filter((l) => looksLikeFeed(l.url)).map((l) => l.id));
  return {
    ...json,
    locations: json.locations.filter((l) => !feeds.has(l.id)),
    rawFindings: json.rawFindings.filter(
      (f) =>
        !feeds.has(f.locationId) &&
        !(f.ruleId === 'broken-link' && /download is starting/i.test(f.failureSummary ?? '')) &&
        !(['keyboard-trap', 'focus-not-visible'].includes(f.ruleId) && /^<(iframe|video|audio|object|embed)\b/i.test(f.html)),
    ),
  };
}

function rebuild(file: string, estimate = false) {
  const db = new PregoDb(':memory:');
  const json = JSON.parse(readFileSync(join(DIR, file), 'utf8')) as RunJson;
  const runId = restoreRun(db, estimate ? withoutFixedFalsePositives(json) : json);
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
});
