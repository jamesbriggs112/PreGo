import { afterAll, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PregoDb } from '../../db/database.js';
import { runAudit } from '../../audit/run-audit.js';
import { misspelledWords, suggestions } from './spelling.js';

const dataDir = mkdtempSync(join(tmpdir(), 'prego-spelling-'));
const db = new PregoDb(':memory:');

afterAll(() => {
  db.close();
  rmSync(dataDir, { recursive: true, force: true });
});

describe('spelling', () => {
  it('finds typos and American spellings, and skips names, acronyms, codes and addresses', () => {
    const text = 'We recieve your organisation’s feedback. The color of the Museum of Making’s new BSL tours, for 3D printers, is on www.example.org and hello@example.org. Don’t sign-up, log in and checkout.';
    expect(misspelledWords(text)).toEqual(['recieve', 'color']);
    expect(suggestions('recieve')[0]).toBe('receive');
  });

  it('raises one ticket per word, with suggestions, and nothing on a well-spelt site', async () => {
    const { run } = await runAudit(db, { project: 'Typos', target: 'fixtures/typos-site', checks: ['spelling'], delayMs: 0, dataDir });
    const tickets = db.getTickets(run.id);
    expect(tickets.map((t) => t.title).sort()).toEqual(['Possible spelling mistake: “exept” (site-wide)', 'Possible spelling mistake: “seperately” (site-wide)']);
    expect(tickets.find((t) => t.title.includes('seperately'))!.actual).toMatch(/^“seperately” isn’t in the British English dictionary\. Did you mean “separately”.*In: “….*Book your tickets seperately for the Derby Silk Mill tour.*…”$/);
    expect(tickets.every((t) => t.category === 'CONT' && t.severity === 'Low')).toBe(true);

    const clean = await runAudit(db, { project: 'Acme', target: 'fixtures/bad-site', checks: ['spelling'], delayMs: 0, dataDir });
    expect(db.getTickets(clean.run.id).map((t) => t.title)).toEqual([]);
  }, 60_000);

  it('reads the page as laid out, and leaves out code, cookie names and Welsh, but still finds real typos', async () => {
    const { run } = await runAudit(db, { project: 'Spelling', target: 'fixtures/spelling-cases', checks: ['spelling'], delayMs: 0, dataDir });
    const words = db
      .getTickets(run.id)
      .map((t) => /“(.+)”/.exec(t.title)![1])
      .sort();
    expect(words).toEqual(['accessbility', 'accomodate', 'devcies', 'techinique']);
  }, 60_000);
});
