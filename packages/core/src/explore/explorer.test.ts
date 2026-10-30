import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { serveFolder, type StaticServer } from '../serve/static-server.js';
import { BrowserSession } from '../browser/session.js';
import { PregoDb } from '../db/database.js';
import { runAudit } from '../audit/run-audit.js';
import { exploreApp, openScreen, type ExploreResult } from './explorer.js';

let kiosk: StaticServer;
let session: BrowserSession;
let full: ExploreResult;
const dataDir = mkdtempSync(join(tmpdir(), 'prego-explore-'));

const KIOSK_SCREENS = [
  'Museum of Making', 'Gallery Guide', 'The Galleries', 'Our Collection', 'Plan Your Visit', 'Share Your Visit',
  'Ancient World', 'Industrial Age', 'Paintings', 'Sculpture', 'Opening Times', 'Access Information', 'Postcard Sent',
  'Egypt', 'Rome', 'Steam Power', 'Textile Mills',
];

beforeAll(async () => {
  kiosk = await serveFolder('fixtures/kiosk-app');
  session = await new BrowserSession().start();
  full = await exploreApp({ startUrl: kiosk.url, profile: 'kiosk-landscape', session });
}, 120_000);

afterAll(async () => {
  await session?.close();
  await kiosk?.close();
  rmSync(dataDir, { recursive: true, force: true });
});

const byTitle = (result: ExploreResult, title: string) => result.states.find((s) => s.title === title)!;

describe('exploreApp on kiosk-app', () => {
  it('finds every screen, breadth-first, without the URL ever changing', () => {
    expect(full.states.map((s) => s.title).sort()).toEqual([...KIOSK_SCREENS].sort());
    expect(new Set(full.states.map((s) => s.path))).toEqual(new Set(['/']));
    expect(full.states.map((s) => s.depth)).toEqual([...full.states.map((s) => s.depth)].sort((a, b) => a - b));
    expect(byTitle(full, 'Egypt')).toMatchObject({ depth: 4 });
    expect(byTitle(full, 'Egypt').steps.map((s) => s.label)).toEqual(['Museum of Making Touch anywhere to begin', 'Explore the galleries', 'Ancient world', 'Egypt']);
    expect(full.stoppedEarly).toBe(false);
  });

  it('records what every action did', () => {
    const edge = (from: string, label: string) => full.edges.find((e) => e.from === byTitle(full, from).id && e.action.label === label)!;
    expect(edge('Gallery Guide', 'Plan your visit')).toMatchObject({ outcome: 'navigated', to: byTitle(full, 'Plan Your Visit').id });
    expect(edge('Paintings', 'Zoom in')).toMatchObject({ outcome: 'unchanged', to: byTitle(full, 'Paintings').id });
    expect(edge('Egypt', 'Back')).toMatchObject({ outcome: 'navigated', to: byTitle(full, 'Ancient World').id });
    expect(edge('Rome', 'Home')).toMatchObject({ outcome: 'navigated', to: byTitle(full, 'Gallery Guide').id });
    // The dead end has nothing to press.
    expect(byTitle(full, 'Opening Times').actions).toEqual([]);
    expect(full.edges.filter((e) => e.from === byTitle(full, 'Opening Times').id)).toEqual([]);
  });

  it('gives each screen the same ID on every exploration', async () => {
    const again = await exploreApp({ startUrl: kiosk.url, profile: 'kiosk-landscape', session, maxStates: 6 });
    for (const state of again.states) expect(byTitle(full, state.title).id).toBe(state.id);
  }, 60_000);

  it('respects the state and depth limits', async () => {
    const few = await exploreApp({ startUrl: kiosk.url, profile: 'kiosk-landscape', session, maxStates: 5 });
    expect(few.states).toHaveLength(5);
    expect(few.stoppedEarly).toBe(true);
    expect(few.edges.some((e) => e.outcome === 'limit')).toBe(true);

    const shallow = await exploreApp({ startUrl: kiosk.url, profile: 'kiosk-landscape', session, maxDepth: 2 });
    expect(Math.max(...shallow.states.map((s) => s.depth))).toBe(2);
    expect(shallow.states).toHaveLength(6);
  }, 120_000);

  it('replays a path to reach a screen again', async () => {
    const egypt = byTitle(full, 'Egypt');
    const { opened } = await openScreen({ startUrl: kiosk.url, session }, egypt.steps, 'kiosk-landscape');
    await expect(opened.page.locator('h1').textContent()).resolves.toBe('Egypt');
    await opened.close();
  });
});

describe('runAudit in explore mode', () => {
  it('stores every screen with its path, the state map, and checks each screen', async () => {
    const db = new PregoDb(':memory:');
    const { run, runDir, locations } = await runAudit(db, {
      project: 'Museum of Making',
      target: 'fixtures/kiosk-app',
      mode: 'explore',
      viewports: ['kiosk-landscape'],
      dataDir,
    });
    expect(run).toMatchObject({ status: 'complete', mode: 'explore', summary: { statesFound: 17, statesAudited: 17 } });
    expect(locations).toHaveLength(17);
    const egypt = locations.find((l) => l.title === 'Egypt')!;
    expect(egypt).toMatchObject({ kind: 'state', depth: 4, audited: true, templateKey: `state:${egypt.stateId}` });
    expect(egypt.steps).toHaveLength(4);
    expect(Object.keys(egypt.screenshots)).toEqual(['kiosk-landscape']);
    const { readFileSync } = await import('node:fs');
    expect(readFileSync(join(runDir, egypt.screenshots['kiosk-landscape'])).subarray(1, 4).toString()).toBe('PNG');

    const edges = db.getEdges(run.id);
    const zoom = edges.find((e) => e.step.label === 'Zoom in')!;
    expect(zoom).toMatchObject({ outcome: 'unchanged', fromLocationId: zoom.toLocationId });
    expect(edges.filter((e) => e.outcome === 'navigated').length).toBeGreaterThan(30);
    db.close();
  }, 180_000);
});
