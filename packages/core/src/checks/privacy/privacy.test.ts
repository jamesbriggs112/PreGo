import { afterAll, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PregoDb } from '../../db/database.js';
import { runAudit } from '../../audit/run-audit.js';
import { isTrackingCookie, trackerName } from './privacy.js';

const dataDir = mkdtempSync(join(tmpdir(), 'prego-privacy-'));
const db = new PregoDb(':memory:');

afterAll(() => {
  db.close();
  rmSync(dataDir, { recursive: true, force: true });
});

describe('cookies and privacy', () => {
  it('flags trackers and tracking cookies before consent, without contacting the trackers', async () => {
    const requests: string[] = [];
    const { run } = await runAudit(db, { project: 'Privacy', target: 'fixtures/privacy-site', checks: ['privacy'], delayMs: 0, dataDir, onRequest: (url) => requests.push(url) });
    const tickets = db.getTickets(run.id);
    expect(tickets.map((t) => t.ruleId).sort()).toEqual(['trackers-before-consent', 'trackers-before-consent', 'tracking-cookies-before-consent']);
    expect(tickets.filter((t) => t.ruleId === 'trackers-before-consent').map((t) => t.actual).sort()).toEqual([
      'Google Tag Manager (www.googletagmanager.com) loads before the visitor has given consent.',
      'Meta (Facebook) Pixel (www.facebook.com) loads before the visitor has given consent.',
    ]);
    expect(tickets.find((t) => t.ruleId === 'tracking-cookies-before-consent')!.actual).toBe('Tracking cookies are set before consent: _ga, _fbp.');
    expect(tickets.every((t) => t.severity === 'High' && t.category === 'SEC')).toBe(true);
    // Trackers were blocked, not contacted: none of their requests reached a server.
    expect(requests.filter((u) => /facebook|googletagmanager/.test(u)).join(' ')).toBe('');
  }, 60_000);

  it('finds nothing on a site without trackers', async () => {
    const { run } = await runAudit(db, { project: 'Acme', target: 'fixtures/bad-site', checks: ['privacy'], delayMs: 0, dataDir });
    expect(db.getTickets(run.id)).toEqual([]);
  }, 60_000);

  it('knows common trackers and their cookies', () => {
    expect(trackerName('region1.google-analytics.com')).toBe('Google Analytics');
    expect(trackerName('connect.facebook.net')).toBe('Meta (Facebook) Pixel');
    expect(trackerName('fonts.googleapis.com')).toBeNull();
    expect(['_ga', '_ga_ABC123', '_gid', '_fbp', '_hjSessionUser_1', '_clck'].every(isTrackingCookie)).toBe(true);
    expect(['session', 'PHPSESSID', 'cookie_consent', 'csrftoken'].some(isTrackingCookie)).toBe(false);
  });
});
