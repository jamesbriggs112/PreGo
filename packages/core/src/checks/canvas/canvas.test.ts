import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { serveFolder, type StaticServer } from '../../serve/static-server.js';
import { BrowserSession } from '../../browser/session.js';
import { PregoDb } from '../../db/database.js';
import { runAudit } from '../../audit/run-audit.js';
import type { Location } from '../../types.js';
import { canvasModule } from './canvas.js';

let cases: StaticServer;
let session: BrowserSession;
const dataDir = mkdtempSync(join(tmpdir(), 'prego-canvas-'));

beforeAll(async () => {
  cases = await serveFolder('fixtures/explore-cases');
  session = await new BrowserSession().start();
});
afterAll(async () => {
  await session?.close();
  await cases?.close();
  rmSync(dataDir, { recursive: true, force: true });
});

async function check(path: string) {
  const opened = await session.newPage('desktop');
  await opened.page.goto(cases.url + path);
  const findings = await canvasModule().run({ page: opened.page, location: { id: 1 } as Location, viewport: 'desktop' });
  await opened.close();
  return findings;
}

describe('canvas detection', () => {
  it('flags a WebGL canvas covering most of the screen for manual review', async () => {
    const [finding, ...rest] = await check('canvas.html');
    expect(rest).toEqual([]);
    expect(finding).toMatchObject({ ruleId: 'canvas-content', category: 'A11Y', selector: '#map', title: 'Content drawn in a canvas needs manual review' });
    expect(finding.failureSummary).toMatch(/^A canvas covers 100% of the screen\. It has no accessible name\. It has no fallback content\. Manual review required\.$/);
  });

  it('leaves small canvases alone', async () => {
    expect(await check('canvas-small.html')).toEqual([]);
  });

  it('raises a manual-review ticket with an outlined screenshot in a full audit', async () => {
    const db = new PregoDb(':memory:');
    const { run } = await runAudit(db, { project: 'Gallery', target: cases.url + 'canvas.html', dataDir, delayMs: 0, maxDepth: 0, useSitemap: false });
    const ticket = db.getTickets(run.id).find((t) => t.ruleId === 'canvas-content')!;
    expect(ticket).toMatchObject({ labels: expect.arrayContaining(['manual-review']), status: 'New' });
    expect(db.getOccurrences(run.id, ticket.ticketId)[0].crop).toMatch(/^crops/);
    expect(run.settings.modules).toContainEqual({ id: 'canvas', name: 'Canvas and WebGL detection' });
    db.close();
  }, 120_000);
});
