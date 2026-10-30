import { beforeAll, describe, expect, it } from 'vitest';
import { parse } from 'csv-parse/sync';
import { PregoDb } from '../db/database.js';
import type { Ticket } from '../types.js';
import { buildExportPlan, type ExportPlan } from './plan.js';
import { occurrencesCsv, ticketsCsv, TICKET_COLUMNS } from './csv.js';

// Built from stored records rather than a browser run, so the edge cases are exact.
let plan: ExportPlan;

function ticket(runId: number, ticketId: string, overrides: Partial<Ticket> = {}): Ticket {
  return {
    runId, ticketId, fingerprint: ticketId, category: 'A11Y', title: 'Images have no text alternative (/)',
    severity: 'Critical', priority: 'P1', status: 'New', wcagCriterion: '1.1.1', wcagLevel: 'A', ruleId: 'image-alt',
    engine: 'axe-core', templateKey: '/', occurrences: 2, locationsAffected: 1, exampleLocation: 'https://example.org/',
    exampleSelector: 'img[src$="hero.svg"]', description: 'Images are missing an alt attribute.',
    whyItMatters: 'Screen reader users hear nothing.', stepsToReproduce: '1. Open the page.\n2. Find the image.',
    expected: 'Passes.', actual: 'Fix any of the following:\n  Element does not have an alt attribute',
    recommendation: 'Add alt text.', effort: 'Small', labels: ['prego', 'accessibility', 'wcag-1.1.1'], auditorNotes: '',
    firstSeen: '2026-10-30', lastSeen: '2026-10-30', ...overrides,
  };
}

beforeAll(() => {
  const db = new PregoDb(':memory:');
  const project = db.createProject('Musée de la Tapisserie');
  const run = db.createRun({ projectId: project.id, mode: 'crawl', target: 'https://example.org/' });
  const location = db.addLocation({
    runId: run.id, kind: 'page', url: 'https://example.org/', title: 'Home', statusCode: 200, depth: 0, templateKey: '/',
    structureHash: 'x', audited: true,
  });
  const addFinding = (ticketId: string, crop: string | null) => {
    const f = db.addRawFinding({
      runId: run.id, locationId: location.id, viewport: 'desktop', module: 'axe', engine: 'axe-core', ruleId: 'image-alt',
      category: 'A11Y', severity: 'Critical', title: 't', description: 'd', helpUrl: null, wcagCriteria: ['1.1.1'],
      wcagLevel: 'A', selector: 'img', html: '<img src="café.png" alt="">', failureSummary: null, crop,
    });
    db.addOccurrence({ runId: run.id, ticketId, locationId: location.id, rawFindingId: f.id, viewport: 'desktop', selector: 'img', html: f.html, crop });
  };
  db.saveTicket(ticket(run.id, 'PRG-A11Y-001', { auditorNotes: 'Client says "fix first", urgently — ça va' }));
  addFinding('PRG-A11Y-001', 'crops/1.png');
  addFinding('PRG-A11Y-001', 'crops/2.png');
  db.saveTicket(ticket(run.id, 'PRG-A11Y-002', { status: 'Dismissed' }));
  db.saveTicket(ticket(run.id, 'PRG-SEC-001', { category: 'SEC', title: 'No HSTS header', priority: 'P3', wcagCriterion: null, wcagLevel: null, labels: ['prego', 'security'] }));
  addFinding('PRG-SEC-001', null);
  plan = buildExportPlan(db, run.id);
});

const read = (csv: string) => parse(csv.replace(/^\uFEFF/, ''), { relax_column_count: false }) as string[][];

describe('tickets.csv', () => {
  it('is UTF-8 with a BOM, every field quoted, CRLF line endings', () => {
    const csv = ticketsCsv(plan);
    expect(csv.startsWith('\uFEFF"Ticket ID","Title",')).toBe(true);
    expect(csv).toContain('\r\n');
    expect(csv).toContain('"Client says ""fix first"", urgently — ça va"');
    expect(csv).toMatch(/"WCAG criterion","WCAG level"/);
  });

  it('has the spec columns in order and one row per exported ticket', () => {
    const [header, ...rows] = read(ticketsCsv(plan));
    expect(header).toEqual([...TICKET_COLUMNS]);
    // Dismissed tickets are left out.
    expect(rows.map((r) => r[0])).toEqual(['PRG-A11Y-001', 'PRG-SEC-001']);
    const a11y = Object.fromEntries(header.map((h, i) => [h, rows[0][i]]));
    expect(a11y).toMatchObject({ Screenshot: 'PRG-A11Y-001_01.png', 'Report section': '4.1', Labels: 'prego accessibility wcag-1.1.1' });
    expect(a11y['Steps to reproduce']).toBe('1. Open the page.\n2. Find the image.');
    const sec = Object.fromEntries(header.map((h, i) => [h, rows[1][i]]));
    expect(sec).toMatchObject({ 'Report section': '4.2', Screenshot: '', 'WCAG criterion': '' });
  });

  it('applies the Jira preset', () => {
    const [header, ...rows] = read(ticketsCsv(plan, 'jira'));
    expect(header).toContain('Summary');
    expect(header).not.toContain('Title');
    expect(header.filter((h) => h === 'Labels')).toHaveLength(3);
    expect(header.at(-1)).toBe('Issue Type');
    const row = Object.fromEntries(header.map((h, i) => [h, rows[0][i]]));
    expect(row).toMatchObject({ Summary: 'Images have no text alternative (/)', Priority: 'Highest', 'Issue Type': 'Bug' });
    expect(row.Description).toContain('Prego ticket: PRG-A11Y-001, report section 4.1');
    expect(rows[0].filter((_, i) => header[i] === 'Labels')).toEqual(['prego', 'accessibility', 'wcag-1.1.1']);
  });

  it('applies the Productive preset: exactly its seven template columns, no byte-order mark', () => {
    const csv = ticketsCsv(plan, 'productive');
    expect(csv.charCodeAt(0)).not.toBe(0xfeff);
    const [header, ...rows] = read(csv);
    expect(header).toEqual(['Title', 'Assignee', 'Description', 'Start Date', 'Due Date', 'Initial Estimate', 'Workflow Status']);
    const row = Object.fromEntries(header.map((h, i) => [h, rows[0][i]]));
    expect(row).toMatchObject({ Title: 'PRG-A11Y-001: Images have no text alternative (/)', Assignee: '', 'Start Date': '', 'Due Date': '', 'Initial Estimate': '', 'Workflow Status': 'Open' });
    expect(row.Description).toMatch(/^Severity: Critical · Priority: P1 · Category: A11Y · Effort: Small · Screenshot: screenshots\/PRG-A11Y-001_01\.png\n\nImages are missing/);
    expect(row.Description).toContain('Prego ticket: PRG-A11Y-001, report section 4.1');
    expect(rows).toHaveLength(plan.tickets.length);
  });

  it('applies the Linear and Trello presets and rejects unknown ones', () => {
    expect(read(ticketsCsv(plan, 'linear'))[1][4]).toBe('Urgent');
    expect(read(ticketsCsv(plan, 'trello'))[0][1]).toBe('Card Name');
    expect(() => ticketsCsv(plan, 'asana')).toThrow(/Unknown CSV preset/);
  });
});

describe('occurrences.csv', () => {
  it('has one row per occurrence with matching screenshot names', () => {
    const [header, ...rows] = read(occurrencesCsv(plan));
    expect(header).toEqual(['Ticket ID', 'Location (URL or state ID)', 'Viewport', 'Selector', 'HTML snippet', 'Screenshot crop']);
    expect(rows).toEqual([
      ['PRG-A11Y-001', 'https://example.org/', 'desktop', 'img', '<img src="café.png" alt="">', 'PRG-A11Y-001_01.png'],
      ['PRG-A11Y-001', 'https://example.org/', 'desktop', 'img', '<img src="café.png" alt="">', 'PRG-A11Y-001_02.png'],
      ['PRG-SEC-001', 'https://example.org/', 'desktop', 'img', '<img src="café.png" alt="">', ''],
    ]);
    expect([...plan.screenshots.entries()]).toEqual([
      ['PRG-A11Y-001_01.png', 'crops/1.png'],
      ['PRG-A11Y-001_02.png', 'crops/2.png'],
    ]);
  });
});
