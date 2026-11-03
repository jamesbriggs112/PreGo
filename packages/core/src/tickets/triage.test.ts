import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PregoDb } from '../db/database.js';
import { runAudit } from '../audit/run-audit.js';
import { buildExportPlan } from '../export/plan.js';
import { ticketsCsv } from '../export/csv.js';
import { mergeTickets, TriageError, updateTicket } from './triage.js';
import type { Ticket } from '../types.js';

const dataDir = mkdtempSync(join(tmpdir(), 'prego-triage-'));
let db: PregoDb;
let runId: number;
let tickets: Ticket[];

const find = (rule: string, template?: string | null) =>
  tickets.find((t) => t.ruleId === rule && (template === undefined || t.templateKey === template))!;

beforeAll(async () => {
  db = new PregoDb(':memory:');
  const result = await runAudit(db, { project: 'Acme', target: 'fixtures/bad-site', dataDir, delayMs: 0 });
  runId = result.run.id;
  tickets = db.getTickets(runId);
}, 120_000);

afterAll(() => {
  db?.close();
  rmSync(dataDir, { recursive: true, force: true });
});

describe('ticket triage', () => {
  it('edits severity, title and notes; priority follows severity unless set', () => {
    const lang = find('html-has-lang');
    expect(lang).toMatchObject({ severity: 'High', priority: 'P2' });
    const edited = updateTicket(db, runId, lang.ticketId, { severity: 'Low', title: 'Missing lang on About', auditorNotes: 'Client CMS sets this; check with dev team' });
    expect(edited).toMatchObject({ severity: 'Low', priority: 'P4', title: 'Missing lang on About', auditorNotes: 'Client CMS sets this; check with dev team' });

    expect(updateTicket(db, runId, lang.ticketId, { priority: 'P1' }).priority).toBe('P1');
    // Earlier changes are kept when a later edit touches other fields.
    expect(db.getTicket(runId, lang.ticketId)).toMatchObject({ severity: 'Low', title: 'Missing lang on About' });
    // null resets to the computed value.
    expect(updateTicket(db, runId, lang.ticketId, { priority: null, title: null })).toMatchObject({ priority: 'P4', title: 'Page language is not set (/about.html)' });
  });

  it('dismisses a false positive and restores it', () => {
    const contrast = find('color-contrast', '/');
    expect(updateTicket(db, runId, contrast.ticketId, { dismissed: true }).status).toBe('Dismissed');
    expect(buildExportPlan(db, runId).tickets.map((t) => t.ticketId)).not.toContain(contrast.ticketId);
    expect(updateTicket(db, runId, contrast.ticketId, { dismissed: false }).status).toBe('Open');
    updateTicket(db, runId, contrast.ticketId, { dismissed: true });
  });

  it('merges tickets, moving every occurrence into the one kept', () => {
    const home = find('heading-order', '/');
    const news = find('heading-order', '/news/*');
    const merged = mergeTickets(db, runId, home.ticketId, [news.ticketId]);
    expect(merged).toMatchObject({ ticketId: home.ticketId, title: home.title, occurrences: home.occurrences + news.occurrences, locationsAffected: 3 });
    expect(db.getTicket(runId, news.ticketId)).toBeUndefined();
    expect(db.getOccurrences(runId, home.ticketId)).toHaveLength(home.occurrences + news.occurrences);
    expect(db.getOccurrences(runId, news.ticketId)).toHaveLength(0);
  });

  it('shows the changes in the next export', () => {
    const csv = ticketsCsv(buildExportPlan(db, runId));
    expect(csv).toContain('Client CMS sets this; check with dev team');
    expect(csv).not.toContain(find('color-contrast', '/').ticketId);
    expect(csv).not.toContain(find('heading-order', '/news/*').ticketId);
  });

  it('refuses impossible merges and unknown tickets', () => {
    const logo = find('image-alt', null);
    expect(() => mergeTickets(db, runId, logo.ticketId, [logo.ticketId])).toThrow(TriageError);
    expect(() => mergeTickets(db, runId, logo.ticketId, ['PRG-A11Y-999'])).toThrow(/not in this run/);
    expect(() => updateTicket(db, runId, 'PRG-A11Y-999', { dismissed: true })).toThrow(/not in this run/);
  });

  it('carries triage into the next audit of the project', async () => {
    const next = await runAudit(db, { project: 'Acme', target: 'fixtures/bad-site', dataDir, delayMs: 0 });
    const again = db.getTickets(next.run.id);
    const byId = (id: string) => again.find((t) => t.ticketId === id);
    expect(byId(find('html-has-lang').ticketId)).toMatchObject({ severity: 'Low', auditorNotes: 'Client CMS sets this; check with dev team', status: 'Open' });
    expect(byId(find('color-contrast', '/').ticketId)?.status).toBe('Dismissed');
    expect(byId(find('heading-order', '/news/*').ticketId)).toBeUndefined();
    expect(byId(find('heading-order', '/').ticketId)?.locationsAffected).toBe(3);
    // Untouched tickets keep their IDs.
    expect(byId(find('image-alt', null).ticketId)).toMatchObject({ occurrences: 5, status: 'Open' });
  }, 120_000);
});
