import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { serveFolder, type StaticServer } from '../serve/static-server.js';
import { PregoDb } from '../db/database.js';
import { runAudit, type AuditEvent } from '../audit/run-audit.js';
import { parseJourney, type Journey } from './journey.js';

const dataDir = mkdtempSync(join(tmpdir(), 'prego-journey-'));
let site: StaticServer;

const journey = (source: string, name = 'contact'): Journey => ({ name, file: '', recordedAt: '', ...parseJourney(source) });
const recorded = () => readFileSync('fixtures/journeys/bad-site-contact.js', 'utf8').replace('{{ORIGIN}}', site.origin);

beforeAll(async () => {
  site = await serveFolder('fixtures/bad-site', { substituteOrigin: true });
});
afterAll(async () => {
  await site?.close();
  rmSync(dataDir, { recursive: true, force: true });
});

describe('journey mode', () => {
  it('replays a recorded journey and produces findings for each step (criterion 4)', async () => {
    const db = new PregoDb(':memory:');
    const events: AuditEvent[] = [];
    const { run, locations } = await runAudit(db, {
      project: 'Acme',
      target: site.url,
      mode: 'journey',
      journey: journey(recorded()),
      viewports: ['desktop', 'mobile'],
      dataDir,
      onEvent: (e) => events.push(e),
    });
    expect(run).toMatchObject({ status: 'complete', mode: 'journey', summary: { stepsRecorded: 4, stepsReplayed: 4, completed: true } });
    expect(locations.map((l) => l.title)).toEqual([
      `Step 1: Open ${site.origin}/index.html`,
      'Step 2: Click the “About” link',
      'Step 3: Click the “Contact” link',
      'Step 4: Type “prego.test@example.com” into “Email address”',
    ]);
    expect(new URL(locations[2].url).pathname).toBe('/contact.html');
    // Every step was checked at both viewports and has findings.
    for (const location of locations) {
      expect(Object.keys(location.screenshots).sort()).toEqual(['desktop', 'mobile']);
      expect(db.getRawFindings(run.id).filter((f) => f.locationId === location.id).length).toBeGreaterThan(0);
    }
    expect(events.filter((e) => e.type === 'journey-step' && e.ok)).toHaveLength(4);
    const label = db.getTickets(run.id).find((t) => t.ruleId === 'label')!;
    expect(label.stepsToReproduce).toContain('Click the “Contact” link.');
    db.close();
  }, 180_000);

  it('raises a ticket on the last good step when a step can no longer be replayed', async () => {
    const db = new PregoDb(':memory:');
    const broken = recorded().replace("name: 'Contact'", "name: 'Book a demo'");
    const { run, locations } = await runAudit(db, { project: 'Acme', target: site.url, mode: 'journey', journey: journey(broken, 'broken'), dataDir });
    expect(run.summary).toMatchObject({ stepsReplayed: 2, completed: false });
    expect(locations).toHaveLength(2);
    const failed = db.getTickets(run.id).find((t) => t.ruleId === 'journey-step-failed')!;
    expect(failed).toMatchObject({ category: 'UX', severity: 'High', title: expect.stringMatching(/^Journey could not be completed/) });
    expect(failed.actual).toMatch(/^Step 3 \(Click the “Book a demo” link\) failed/);
    db.close();
  }, 120_000);

  it('logs in with a journey before crawling, and keeps the session in data/', async () => {
    const db = new PregoDb(':memory:');
    const login = journey(`await page.goto('${site.origin}/index.html');\nawait page.evaluate(() => 1);\n`, 'login');
    // A journey that only opens the page still saves a session file for the crawl to use.
    const { run } = await runAudit(db, { project: 'Login test', target: site.url, loginJourney: login, dataDir, delayMs: 0, maxPages: 2 });
    expect(run.status).toBe('complete');
    const { existsSync } = await import('node:fs');
    expect(existsSync(join(dataDir, 'sessions', 'login-test.json'))).toBe(true);
    db.close();
  }, 120_000);
});
