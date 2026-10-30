import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PregoDb } from '../../db/database.js';
import { runAudit } from '../../audit/run-audit.js';
import type { RawFinding, Ticket } from '../../types.js';
import { deltaE, hex, lab, parseColour } from './ui.js';

const dataDir = mkdtempSync(join(tmpdir(), 'prego-ui-'));
let findings: RawFinding[];
let tickets: Ticket[];

beforeAll(async () => {
  const db = new PregoDb(':memory:');
  const { run } = await runAudit(db, { project: 'Acme', target: 'fixtures/bad-site', checks: ['ui'], viewports: ['desktop', 'mobile'], delayMs: 0, dataDir });
  findings = db.getRawFindings(run.id);
  tickets = db.getTickets(run.id);
}, 120_000);

afterAll(() => rmSync(dataDir, { recursive: true, force: true }));

describe('UI consistency on bad-site', () => {
  it('reports the near-duplicate greys and blues as colour drift', () => {
    const colours = findings.filter((f) => f.ruleId === 'colour-near-duplicates').map((f) => f.failureSummary!);
    expect(colours.some((s) => s.includes('#aaaaaa') && s.includes('#b0b0b0'))).toBe(true);
    expect(colours.some((s) => s.includes('#1a4d8f') && s.includes('#1b4f91'))).toBe(true);
  });

  it('reports 15px beside 16px as type drift', () => {
    const sizes = findings.find((f) => f.ruleId === 'font-size-near-duplicates')!;
    expect(sizes.failureSummary).toMatch(/2 text sizes a pixel or less apart: 16px \(used \d+ times.*15px \(used \d+ times?, e\.g\. \//);
    // Reported where the odd one out is used.
    expect(sizes.html).toMatch(/^<p/);
  });

  it('makes one site-wide UI ticket per drift, not one per page', () => {
    expect(tickets.every((t) => t.category === 'UI')).toBe(true);
    expect(tickets.every((t) => t.templateKey === null)).toBe(true);
    const fingerprints = new Set(tickets.map((t) => t.fingerprint));
    expect(fingerprints.size).toBe(tickets.length);
    expect(new Set(findings.map((f) => f.viewport))).toEqual(new Set(['desktop']));
  });

  it('explains the values, how often each is used and where', () => {
    const colour = tickets.find((t) => t.ruleId === 'colour-near-duplicates')!;
    expect(colour.title).toBe('Colours that are almost, but not quite, the same (site-wide)');
    expect(colour.actual).toMatch(/^2 colours that look almost the same: #[0-9a-f]{6} \(used \d+ times, e\.g\. \//);
  });
});

describe('colour maths', () => {
  it('parses computed colours and measures how different they look', () => {
    expect(parseColour('rgb(170, 170, 170)')).toEqual([170, 170, 170]);
    expect(parseColour('rgba(0, 0, 0, 0)')).toBeNull();
    expect(hex([26, 77, 143])).toBe('#1a4d8f');
    expect(deltaE(lab([170, 170, 170]), lab([176, 176, 176]))).toBeLessThan(5);
    expect(deltaE(lab([170, 170, 170]), lab([34, 34, 34]))).toBeGreaterThan(40);
    expect(deltaE(lab([255, 0, 0]), lab([255, 0, 0]))).toBe(0);
  });
});
