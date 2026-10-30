import { afterAll, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PregoDb } from '../../db/database.js';
import { runAudit } from '../../audit/run-audit.js';
import { compareLayouts } from './browsers.js';

const dataDir = mkdtempSync(join(tmpdir(), 'prego-browsers-'));
const db = new PregoDb(':memory:');

afterAll(() => {
  db.close();
  rmSync(dataDir, { recursive: true, force: true });
});

describe('Firefox and Safari', () => {
  it('finds script errors, sideways scrolling and missing controls in the other engines', async () => {
    const { run } = await runAudit(db, { project: 'Quirks', target: 'fixtures/browser-quirks', checks: ['browsers'], delayMs: 0, dataDir });
    const tickets = db.getTickets(run.id);
    const titles = tickets.map((t) => t.title.replace(/ \([^()]*\)$/, '')).sort();
    expect(titles).toEqual(['A script fails in Firefox', 'Content or controls disappear in Firefox', 'The page scrolls sideways in Safari (WebKit)']);
    expect(tickets.find((t) => t.title.startsWith('A script fails'))!.actual).toMatch(/missingFunction/);
    expect(tickets.find((t) => t.title.startsWith('Content or controls'))!.actual).toMatch(/“Book tickets” \(#book\)/);
    expect(tickets.every((t) => t.category === 'UX')).toBe(true);
  }, 120_000);

  it('raises nothing when the engines agree', async () => {
    const { run } = await runAudit(db, { project: 'Acme', target: 'fixtures/bad-site', checks: ['browsers'], delayMs: 0, dataDir, maxPages: 3 });
    expect(db.getTickets(run.id).map((t) => `${t.title}: ${t.actual}`)).toEqual([]);
  }, 120_000);

  it('ignores small shifts and reports large ones', () => {
    const base = { scrollWidth: 1280, clientWidth: 1280, elements: { h1: { x: 20, w: 600, visible: true, label: 'Title' } } };
    expect(compareLayouts(base, { ...base, elements: { h1: { x: 30, w: 610, visible: true, label: 'Title' } } })).toEqual([]);
    expect(compareLayouts(base, { ...base, elements: { h1: { x: 400, w: 600, visible: true, label: 'Title' } } }).map((d) => d.ruleId)).toEqual(['browser-layout-differs']);
  });
});
