import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PregoDb } from '../db/database.js';
import { runAudit } from '../audit/run-audit.js';
import { calculatePriority } from './build.js';
import type { Ticket } from '../types.js';

const dataDir = mkdtempSync(join(tmpdir(), 'prego-tickets-'));
let db: PregoDb;
let first: Ticket[];
let second: Ticket[];
let firstRunId: number;

beforeAll(async () => {
  db = new PregoDb(join(dataDir, 'prego.sqlite'));
  const a = await runAudit(db, { project: 'Acme', target: 'fixtures/bad-site', dataDir, delayMs: 0 });
  const b = await runAudit(db, { project: 'Acme', target: 'fixtures/bad-site', dataDir, delayMs: 0 });
  firstRunId = a.run.id;
  first = db.getTickets(a.run.id);
  second = db.getTickets(b.run.id);
}, 120_000);

afterAll(() => {
  db?.close();
  rmSync(dataDir, { recursive: true, force: true });
});

const byRule = (tickets: Ticket[], rule: string) => tickets.filter((t) => t.ruleId === rule);

describe('ticket grouping', () => {
  it('gives identical ticket IDs on two runs of an unchanged site', () => {
    expect(first.length).toBeGreaterThan(5);
    expect(second.map((t) => [t.ticketId, t.fingerprint])).toEqual(first.map((t) => [t.ticketId, t.fingerprint]));
    expect(first.every((t) => t.status === 'New')).toBe(true);
    expect(second.every((t) => t.status === 'Recurring')).toBe(true);
    expect(second.every((t) => t.firstSeen === first[0].firstSeen)).toBe(true);
  });

  it('numbers tickets PRG-{CATEGORY}-{NNN} without gaps', () => {
    expect(first.map((t) => t.ticketId)).toEqual(first.map((_, i) => `PRG-A11Y-${String(i + 1).padStart(3, '0')}`));
  });

  it('makes one site-wide ticket for the header logo across every template', () => {
    const logo = byRule(first, 'image-alt').find((t) => t.title.includes('site header'))!;
    expect(logo).toMatchObject({ occurrences: 5, locationsAffected: 5, templateKey: null, severity: 'Critical', priority: 'P1' });
    expect(db.getOccurrences(firstRunId, logo.ticketId)).toHaveLength(5);
  });

  it('groups the two news posts into one ticket per problem', () => {
    const photo = byRule(first, 'image-alt').find((t) => t.templateKey === '/news/*')!;
    expect(photo).toMatchObject({ occurrences: 2, locationsAffected: 2 });
    expect(byRule(first, 'heading-order').map((t) => t.templateKey).sort()).toEqual(['/', '/news/*']);
  });

  it('groups the unlabelled contact fields into one ticket', () => {
    const label = byRule(first, 'label');
    expect(label).toHaveLength(1);
    expect(label[0]).toMatchObject({ occurrences: 2, title: 'Form fields have no label (form on /contact.html)' });
  });

  it('fills in every field a developer needs', () => {
    const lang = byRule(first, 'html-has-lang')[0];
    expect(lang).toMatchObject({
      category: 'A11Y',
      wcagCriterion: '3.1.1',
      wcagLevel: 'A',
      engine: 'axe-core',
      effort: 'Small',
      labels: ['prego', 'accessibility', 'wcag-3.1.1'],
    });
    expect(lang.exampleLocation).toMatch(/about\.html$/);
    expect(lang.stepsToReproduce).toMatch(/^1\. Open .*about\.html at the desktop viewport\./);
    expect(lang.actual).toMatch(/lang attribute/);
  });
});

describe('calculatePriority', () => {
  it('starts from severity and rises with reach or a key journey', () => {
    expect(calculatePriority('Critical', 0.1, false)).toBe('P1');
    expect(calculatePriority('High', 0.1, false)).toBe('P2');
    expect(calculatePriority('High', 0.6, false)).toBe('P1');
    expect(calculatePriority('Medium', 0.1, true)).toBe('P2');
    expect(calculatePriority('Low', 1, true)).toBe('P3');
    expect(calculatePriority('Low', 0, false)).toBe('P4');
  });
});

describe('ticket numbering', () => {
  it('numbers a fresh project in page order, starting with the home page', () => {
    const ordered = [...first].sort((a, b) => a.ticketId.localeCompare(b.ticketId));
    expect(new URL(ordered[0].exampleLocation!).pathname).toBe('/');
  });
});
