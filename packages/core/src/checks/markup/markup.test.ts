import { afterAll, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PregoDb } from '../../db/database.js';
import { runAudit } from '../../audit/run-audit.js';

const dataDir = mkdtempSync(join(tmpdir(), 'prego-markup-'));
afterAll(() => rmSync(dataDir, { recursive: true, force: true }));

describe('HTML validity', () => {
  it('reports invalid HTML, but not a missing title on an iframe, which the standard doesn’t require', async () => {
    const db = new PregoDb(':memory:');
    const bad = await runAudit(db, { project: 'Bad', target: 'fixtures/bad-site', checks: ['html'], delayMs: 0, dataDir });
    expect(db.getRawFindings(bad.run.id).some((f) => f.ruleId === 'deprecated')).toBe(true);
    const frames = await runAudit(db, { project: 'Frames', target: 'fixtures/frame-cases', checks: ['html'], delayMs: 0, dataDir });
    expect(db.getRawFindings(frames.run.id).filter((f) => /iframe/.test(f.title))).toEqual([]);
    db.close();
  }, 120_000);
});
