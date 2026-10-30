// Acceptance criterion 9: during an audit, the only outbound requests go to the target site and its
// own assets (and, only if AI review is on, localhost for Ollama). Checked with Playwright's request
// log for every browser Prego opens, in crawl and explore modes.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PregoDb, runAudit, serveFolder, type AuditOptions, type StaticServer } from '@prego/core';

const dataDir = mkdtempSync(join(tmpdir(), 'prego-network-'));
const servers: StaticServer[] = [];

afterAll(async () => {
  await Promise.all(servers.map((s) => s.close()));
  rmSync(dataDir, { recursive: true, force: true });
});

/** Run an audit and return every distinct origin its browsers requested. */
async function originsRequested(options: Omit<AuditOptions, 'onRequest' | 'dataDir'>): Promise<{ origins: Set<string>; count: number }> {
  const origins = new Set<string>();
  let count = 0;
  const db = new PregoDb(':memory:');
  try {
    const { run } = await runAudit(db, {
      ...options,
      dataDir,
      onRequest: (url) => {
        count++;
        const parsed = new URL(url);
        // data: and blob: URLs are in-page content, not network requests.
        if (parsed.protocol === 'http:' || parsed.protocol === 'https:') origins.add(parsed.origin);
      },
    });
    expect(run.status).toBe('complete');
  } finally {
    db.close();
  }
  return { origins, count };
}

let badSite: StaticServer;
let kiosk: StaticServer;
let cases: StaticServer;

beforeAll(async () => {
  badSite = await serveFolder('fixtures/bad-site', { substituteOrigin: true });
  kiosk = await serveFolder('fixtures/kiosk-app');
  cases = await serveFolder('fixtures/explore-cases');
  servers.push(badSite, kiosk, cases);
});

describe('outbound network requests', () => {
  it('a site crawl only requests the target site', async () => {
    const { origins, count } = await originsRequested({ project: 'Acme', target: badSite.url, delayMs: 0, viewports: ['desktop', 'mobile'] });
    expect(count).toBeGreaterThan(20);
    expect([...origins]).toEqual([badSite.origin]);
  }, 120_000);

  it('an interactive exploration only requests the target, even with links to other sites on screen', async () => {
    const kioskRun = await originsRequested({ project: 'Museum', target: kiosk.url, mode: 'explore', viewports: ['kiosk-landscape'] });
    expect([...kioskRun.origins]).toEqual([kiosk.origin]);
    // form.html links to https://example.org; it must never be fetched.
    const formRun = await originsRequested({ project: 'Account', target: cases.url + 'form.html', mode: 'explore' });
    expect([...formRun.origins]).toEqual([cases.origin]);
  }, 180_000);
});
