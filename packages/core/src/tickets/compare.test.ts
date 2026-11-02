import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parse } from 'csv-parse/sync';
import mammoth from 'mammoth';
import { PregoDb } from '../db/database.js';
import { runAudit } from '../audit/run-audit.js';
import { exportRun } from '../export/bundle.js';
import { verifyExport } from '../export/verify.js';
import type { Ticket } from '../types.js';

// Acceptance criterion 7: the same audit twice gives the same ticket IDs; after fixing one issue,
// that ticket shows as Fixed and the rest as Recurring.
const dataDir = mkdtempSync(join(tmpdir(), 'prego-compare-'));
const site = join(dataDir, 'site');
const about = join(site, 'about.html');
const db = new PregoDb(join(dataDir, 'prego.sqlite'));
const audit = async (checks = ['axe']) => (await runAudit(db, { project: 'Compare', target: site, checks, delayMs: 0, dataDir })).run.id;
const byId = (runId: number) => new Map(db.getTickets(runId).map((t) => [t.ticketId, t]));
let first: Map<string, Ticket>;
let langTicket: Ticket;

beforeAll(async () => {
  cpSync('fixtures/bad-site', site, { recursive: true });
  first = byId(await audit());
  langTicket = [...first.values()].find((t) => t.ruleId === 'html-has-lang')!;
}, 120_000);

afterAll(() => {
  db.close();
  rmSync(dataDir, { recursive: true, force: true });
});

describe('comparing audits (criterion 7)', () => {
  it('marks everything New on the first audit, and gives identical IDs, all Recurring, on an unchanged re-run', async () => {
    expect([...first.values()].every((t) => t.status === 'New')).toBe(true);
    const second = byId(await audit());
    expect([...second.keys()].sort()).toEqual([...first.keys()].sort());
    expect([...second.values()].every((t) => t.status === 'Recurring')).toBe(true);
  }, 120_000);

  it('shows a fixed issue as Fixed and the rest as Recurring, in the export too', async () => {
    expect(langTicket).toMatchObject({ locationsAffected: 1 });
    writeFileSync(about, readFileSync(about, 'utf8').replace(/^<html>$/m, '<html lang="en">'));
    const runId = await audit();
    const third = byId(runId);
    expect(third.get(langTicket.ticketId)).toMatchObject({ status: 'Fixed', occurrences: 0, lastSeen: langTicket.lastSeen });
    expect([...third.values()].filter((t) => t.ticketId !== langTicket.ticketId).every((t) => t.status === 'Recurring')).toBe(true);
    expect([...third.keys()].sort()).toEqual([...first.keys()].sort());

    const { dir } = await exportRun(db, runId, { dataDir });
    expect((await verifyExport(dir)).problems).toEqual([]);
    const rows = parse(readFileSync(join(dir, 'tickets.csv'), 'utf8').replace(/^\uFEFF/, ''), { columns: true }) as Record<string, string>[];
    expect(rows.find((r) => r['Ticket ID'] === langTicket.ticketId)).toMatchObject({ Status: 'Fixed', 'Report section': '6', Occurrences: '0' });
    const { value: text } = await mammoth.extractRawText({ path: join(dir, 'report.docx') });
    expect(text).toMatch(/1 issue fixed/);
    expect(text).toContain(`Fixed since the last audit`);
    expect(text.slice(text.indexOf('Fixed since the last audit'))).toContain(langTicket.ticketId);
  }, 120_000);

  it('shows a problem that comes back as Regressed', async () => {
    writeFileSync(about, readFileSync(about, 'utf8').replace(/^<html lang="en">$/m, '<html>'));
    const fourth = byId(await audit());
    expect(fourth.get(langTicket.ticketId)!.status).toBe('Regressed');
  }, 120_000);

  it('doesn’t call problems fixed when the audit didn’t check for them', async () => {
    const htmlOnly = byId(await audit(['html']));
    expect([...htmlOnly.values()].filter((t) => t.status === 'Fixed')).toEqual([]);
  }, 120_000);
});
