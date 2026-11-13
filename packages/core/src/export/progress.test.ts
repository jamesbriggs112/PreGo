import { describe, expect, it } from 'vitest';
import { parse } from 'csv-parse/sync';
import { PregoDb } from '../db/database.js';
import { restoreRun, type RunJson } from './restore.js';
import { buildTickets } from '../tickets/build.js';
import { buildExportPlan } from './plan.js';
import { ticketsCsv } from './csv.js';
import { progress } from './progress.js';
import type { Location, RawFinding } from '../types.js';

const location = {
  id: 1,
  runId: 1,
  kind: 'page',
  url: 'https://example.org/',
  stateId: null,
  title: 'Home',
  statusCode: 200,
  depth: 0,
  templateKey: '/',
  structureHash: '/',
  audited: true,
  notAuditedReason: null,
  screenshots: [],
  steps: null,
  metrics: {},
} as Location;
const finding = (id: number, ruleId: string, component: string): RawFinding =>
  ({
    id,
    runId: 1,
    locationId: 1,
    viewport: 'desktop',
    module: 'axe',
    engine: 'axe-core',
    ruleId,
    category: 'A11Y',
    severity: 'High',
    title: ruleId,
    description: '',
    helpUrl: null,
    wcagCriteria: ['4.1.2'],
    wcagLevel: 'A',
    selector: 'x',
    html: '<button>',
    failureSummary: '',
    crop: null,
    fingerprint: null,
    ticketId: null,
    component,
    componentShared: true,
  }) as RawFinding;
const run = (findings: RawFinding[]): RunJson => ({
  project: { name: 'Example' },
  run: { mode: 'crawl', target: 'https://example.org/', settings: { modules: [{ id: 'axe', name: 'Accessibility' }] }, summary: {} },
  locations: [location],
  rawFindings: findings,
});

describe('progress since the last audit', () => {
  it('counts what was fixed, what’s new and what’s still open, and marks tickets.csv', () => {
    const db = new PregoDb(':memory:');
    const first = restoreRun(db, run([finding(1, 'button-name', 'body>header'), finding(2, 'link-name', 'body>footer')]));
    buildTickets(db, first);
    expect(buildExportPlan(db, first).previous).toBeNull();

    const second = restoreRun(db, run([finding(1, 'button-name', 'body>header'), finding(3, 'image-alt', 'body>main')]));
    buildTickets(db, second);
    db.saveReportOptions(second, { clientFacing: true, reports: { overview: false, audience: false, future: false }, include: {}, text: {} } as never);
    const plan = buildExportPlan(db, second);
    expect(plan.outline.map((o) => o.id)).toContain('progress');
    const p = progress(plan)!;
    expect(p).toMatchObject({ added: 1, stillOpen: 1, fixed: [expect.objectContaining({ title: expect.stringMatching(/^Links have no text/) })] });
    expect(p.scores.find((s) => s.name === 'Accessibility')).toMatchObject({ before: expect.any(Number), now: expect.any(Number) });

    const [header, ...rows] = parse(ticketsCsv(plan).replace(/^\uFEFF/, '')) as string[][];
    const since = header.indexOf('Since last audit');
    expect(rows.map((r) => r[since]).sort()).toEqual(['New', 'Still open']);
    db.close();
  });
});
