import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PregoDb } from '../../db/database.js';
import { runAudit } from '../../audit/run-audit.js';
import type { EdgeOutcome, Location, PathStep, StateEdge, Ticket } from '../../types.js';
import { analyseStateMap } from './state-map.js';

// A small hand-built map: Home (start) → Menu → Detail, plus extra screens per test.
const step = (label: string): PathStep => ({ key: `button|${label}|0`, label, role: 'button', kind: 'click', selector: `#${label.replace(/\W/g, '')}` });
let nextId = 1;
function screen(title: string, steps: string[]): Location {
  return {
    id: nextId++, runId: 1, kind: 'state', url: 'http://app/', stateId: title, title, statusCode: null, depth: steps.length,
    templateKey: null, structureHash: null, audited: true, notAuditedReason: null, screenshots: {}, steps: steps.map(step),
  };
}
const edge = (from: Location, label: string, to: Location | null, outcome: EdgeOutcome = 'navigated'): StateEdge => ({
  id: 0, runId: 1, fromLocationId: from.id, toLocationId: to?.id ?? null, step: step(label), outcome, reason: outcome === 'skipped' ? 'Matches denylisted label "send"' : null,
});
const rules = (result: Map<number, { ruleId: string }[]>, location: Location) => (result.get(location.id) ?? []).map((f) => f.ruleId);

describe('analyseStateMap', () => {
  const home = screen('Home', []);
  const menu = screen('Menu', ['Menu']);
  const detail = screen('Detail', ['Menu', 'Detail']);
  const base = [edge(home, 'Menu', menu), edge(home, 'Home', home, 'unchanged'), edge(menu, 'Detail', detail), edge(menu, 'Home', home), edge(menu, 'Back', home), edge(detail, 'Home', home), edge(detail, 'Back', menu)];

  it('raises nothing for a well-behaved map, including Home pressed on the home screen', () => {
    const result = analyseStateMap({ locations: [home, menu, detail], edges: base });
    expect([...result.values()].flat()).toEqual([]);
  });

  it('flags dead ends, saying when only denylisted actions were left', () => {
    const stuck = screen('Stuck', ['Menu', 'Stuck']);
    const send = screen('Send', ['Menu', 'Send']);
    const result = analyseStateMap({ locations: [home, menu, detail, stuck, send], edges: [...base, edge(send, 'Send now', null, 'skipped')] });
    expect(rules(result, stuck)).toEqual(['dead-end']);
    expect(result.get(send.id)![0]).toMatchObject({ ruleId: 'dead-end', severity: 'High', failureSummary: expect.stringMatching(/"Send now".*doesn't press/) });
  });

  it('does not call a screen a dead end when an action hit a limit or failed', () => {
    const unsure = screen('Unsure', ['Menu', 'Unsure']);
    const result = analyseStateMap({ locations: [home, menu, unsure], edges: [...base, edge(unsure, 'Next', null, 'limit')] });
    expect(rules(result, unsure)).toEqual([]);
  });

  it('flags actions that do nothing', () => {
    const result = analyseStateMap({ locations: [home, menu, detail], edges: [...base, edge(detail, 'Zoom in', detail, 'unchanged')] });
    expect(result.get(detail.id)).toEqual([expect.objectContaining({ ruleId: 'no-op-action', selector: '#Zoomin', category: 'UX' })]);
  });

  it('flags content more than the tap limit from the start', () => {
    const deep = screen('Deep', ['Menu', 'Detail', 'More', 'Even more', 'Deepest']);
    const result = analyseStateMap({ locations: [home, menu, detail, deep], edges: [...base, edge(deep, 'Home', home)] }, { maxTaps: 4 });
    expect(rules(result, deep)).toEqual(['deep-content']);
  });

  it('flags Home that goes somewhere unusual, and Back that does not return', () => {
    const odd = screen('Odd', ['Menu', 'Odd']);
    const result = analyseStateMap({
      locations: [home, menu, detail, odd],
      edges: [...base, edge(menu, 'Odd', odd), edge(odd, 'Home', menu), edge(odd, 'Back', home)],
    });
    expect(result.get(odd.id)!.map((f) => f.failureSummary)).toEqual([
      '"Home" here goes to "Menu", but from most screens it goes to "Home".',
      '"Back" goes to "Home", not back to "Menu", the screen it was reached from.',
    ]);
  });
});

describe('state map tickets on kiosk-app (criterion 3)', () => {
  const dataDir = mkdtempSync(join(tmpdir(), 'prego-statemap-'));
  let tickets: Ticket[];
  let db: PregoDb;
  let runId: number;

  beforeAll(async () => {
    db = new PregoDb(':memory:');
    const { run } = await runAudit(db, { project: 'Museum', target: 'fixtures/kiosk-app', mode: 'explore', viewports: ['kiosk-landscape', 'kiosk-portrait'], dataDir });
    runId = run.id;
    tickets = db.getTickets(run.id);
  }, 240_000);

  afterAll(() => {
    db?.close();
    rmSync(dataDir, { recursive: true, force: true });
  });

  it('raises a ticket for the dead-end screen and for the button that does nothing', () => {
    expect(tickets.filter((t) => t.category === 'UX').map((t) => [t.ruleId, t.title, t.occurrences])).toEqual([
      ['dead-end', 'Screen has no way back or home (“Opening Times” screen)', 1],
      ['no-op-action', 'Button does nothing (“Paintings” screen)', 1],
    ]);
  });

  it('reports state map findings once, not once per viewport', () => {
    const findings = db.getRawFindings(runId).filter((f) => f.module === 'state-map');
    expect(findings.map((f) => f.viewport)).toEqual(['kiosk-landscape', 'kiosk-landscape']);
  });

  it('outlines the button that does nothing, and explains how to reach it', () => {
    const noop = tickets.find((t) => t.ruleId === 'no-op-action')!;
    expect(db.getOccurrences(runId, noop.ticketId)[0].crop).toMatch(/^crops/);
    expect(noop.stepsToReproduce).toContain('Press “Paintings”.');
    expect(noop.actual).toBe('Pressing "Zoom in" changed nothing on the screen.');
  });

  it('groups a problem in the shared app shell into one ticket across screens', () => {
    const main = tickets.find((t) => t.ruleId === 'landmark-one-main')!;
    expect(main).toMatchObject({ locationsAffected: 16, title: 'Page has no main content landmark (16 screens)' });
    expect(tickets.filter((t) => t.engine === 'axe-core').length).toBeLessThan(6);
  });
});
