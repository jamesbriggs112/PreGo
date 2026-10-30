import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PregoDb, slugify } from './database.js';
import type { Ticket } from '../types.js';

let db: PregoDb;

beforeEach(() => {
  db = new PregoDb(':memory:');
});
afterEach(() => db.close());

function seedRun() {
  const project = db.createProject('Make UK');
  const run = db.createRun({ projectId: project.id, mode: 'crawl', target: 'https://makeuk.org/', settings: { maxPages: 10 } });
  const location = db.addLocation({
    runId: run.id, kind: 'page', url: 'https://makeuk.org/', title: 'Home', statusCode: 200, depth: 0,
    templateKey: '/', structureHash: 'abc', audited: true,
  });
  return { project, run, location };
}

function ticketFor(runId: number, ticketId: string): Ticket {
  return {
    runId, ticketId, fingerprint: 'fp1', category: 'A11Y', title: 'Images have no text alternative', severity: 'High',
    priority: 'P2', status: 'New', wcagCriterion: '1.1.1', wcagLevel: 'A', ruleId: 'image-alt', engine: 'axe-core',
    templateKey: '/', occurrences: 1, locationsAffected: 1, exampleLocation: 'https://makeuk.org/', exampleSelector: 'img',
    description: 'd', whyItMatters: 'w', stepsToReproduce: 's', expected: 'e', actual: 'a', recommendation: 'r',
    effort: 'Small', labels: ['accessibility', 'wcag-1.1.1'], auditorNotes: '', firstSeen: 'x', lastSeen: 'y',
  };
}

describe('PregoDb', () => {
  it('creates and reads projects with unique slugs', () => {
    const a = db.createProject('Make UK');
    const b = db.createProject('Make UK');
    expect(a.slug).toBe('make-uk');
    expect(b.slug).toBe('make-uk-2');
    expect(db.getProject(a.id)?.name).toBe('Make UK');
    expect(db.ensureProject('make uk').id).toBe(a.id);
    expect(db.listProjects()).toHaveLength(2);
    expect(slugify('Musée d’Orsay!')).toBe('musee-d-orsay');
  });

  it('creates, reads and finishes runs, and finds the previous run', () => {
    const { project, run } = seedRun();
    expect(run.status).toBe('running');
    expect(run.settings).toEqual({ maxPages: 10 });
    db.finishRun(run.id, 'complete', { tickets: 3 });
    expect(db.getRun(run.id)).toMatchObject({ status: 'complete', summary: { tickets: 3 } });
    const second = db.createRun({ projectId: project.id, mode: 'crawl', target: 'https://makeuk.org/' });
    expect(db.previousRun(second.id)?.id).toBe(run.id);
    expect(db.previousRun(run.id)).toBeUndefined();
    expect(db.listRuns(project.id).map((r) => r.id)).toEqual([run.id, second.id]);
  });

  it('marks runs left running by a crash or restart as failed', () => {
    const { run } = seedRun();
    expect(db.failInterruptedRuns('Prego stopped')).toBe(1);
    expect(db.getRun(run.id)).toMatchObject({ status: 'failed', error: 'Prego stopped' });
    expect(db.getRun(run.id)!.finishedAt).not.toBeNull();
    expect(db.failInterruptedRuns('Prego stopped')).toBe(0);
  });

  it('creates, reads and updates locations', () => {
    const { run, location } = seedRun();
    expect(location).toMatchObject({ audited: true, screenshots: {}, stateId: null });
    db.updateLocation(location.id, { audited: false, notAuditedReason: 'Same template', screenshots: { desktop: 'a.png' } });
    expect(db.getLocations(run.id)[0]).toMatchObject({
      audited: false, notAuditedReason: 'Same template', screenshots: { desktop: 'a.png' },
    });
    expect(() => db.updateLocation(location.id, { ['nope' as 'url']: 'x' })).toThrow(/Unknown location column/);
  });

  it('creates and reads raw findings', () => {
    const { run, location } = seedRun();
    const finding = db.addRawFinding({
      runId: run.id, locationId: location.id, viewport: 'desktop', module: 'axe', engine: 'axe-core', ruleId: 'image-alt',
      category: 'A11Y', severity: 'Critical', title: 'Images must have alternate text', description: 'd', helpUrl: null,
      wcagCriteria: ['1.1.1'], wcagLevel: 'A', selector: 'img', html: '<img src="a.png">', failureSummary: null,
    });
    expect(finding.wcagCriteria).toEqual(['1.1.1']);
    db.setRawFindingTicket(finding.id, 'fp1', 'PRG-A11Y-001');
    expect(db.getRawFindings(run.id)[0]).toMatchObject({ fingerprint: 'fp1', ticketId: 'PRG-A11Y-001' });
  });

  it('allocates stable, per-category ticket IDs that are never reused', () => {
    const { project, run } = seedRun();
    expect(db.ticketIdFor(project.id, 'fp1', 'A11Y', run.id)).toEqual({ ticketId: 'PRG-A11Y-001', isNew: true });
    expect(db.ticketIdFor(project.id, 'fp2', 'A11Y', run.id).ticketId).toBe('PRG-A11Y-002');
    expect(db.ticketIdFor(project.id, 'fp3', 'SEC', run.id).ticketId).toBe('PRG-SEC-001');
    expect(db.ticketIdFor(project.id, 'fp1', 'A11Y', run.id + 1)).toEqual({ ticketId: 'PRG-A11Y-001', isNew: false });
    expect(db.ticketFirstSeenRun(project.id, 'PRG-A11Y-001')).toBe(run.id);
    // Another project numbers independently.
    const other = db.createProject('Other');
    expect(db.ticketIdFor(other.id, 'fp1', 'A11Y', run.id).ticketId).toBe('PRG-A11Y-001');
  });

  it('creates and reads tickets and occurrences', () => {
    const { run, location } = seedRun();
    db.saveTicket(ticketFor(run.id, 'PRG-A11Y-001'));
    expect(db.getTicket(run.id, 'PRG-A11Y-001')?.labels).toEqual(['accessibility', 'wcag-1.1.1']);
    const finding = db.addRawFinding({
      runId: run.id, locationId: location.id, viewport: 'desktop', module: 'axe', engine: 'axe-core', ruleId: 'image-alt',
      category: 'A11Y', severity: 'Critical', title: 't', description: 'd', helpUrl: null, wcagCriteria: [],
      wcagLevel: null, selector: 'img', html: '<img>', failureSummary: null,
    });
    db.addOccurrence({
      runId: run.id, ticketId: 'PRG-A11Y-001', locationId: location.id, rawFindingId: finding.id, viewport: 'desktop',
      selector: 'img', html: '<img>', crop: 'crops/1.png',
    });
    expect(db.getOccurrences(run.id, 'PRG-A11Y-001')).toHaveLength(1);
    expect(db.getTickets(run.id)).toHaveLength(1);
  });

  it('persists to a file and re-opens without re-running migrations', () => {
    const dir = mkdtempSync(join(tmpdir(), 'prego-db-'));
    try {
      const path = join(dir, 'nested', 'prego.sqlite');
      const first = new PregoDb(path);
      first.createProject('Persisted');
      first.close();
      const second = new PregoDb(path);
      expect(second.listProjects().map((p) => p.name)).toEqual(['Persisted']);
      second.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
