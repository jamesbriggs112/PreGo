import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { PregoDb } from '@prego/core';
import { buildApp, type PregoApp } from './app.js';

const dataDir = mkdtempSync(join(tmpdir(), 'prego-groups-'));
let db: PregoDb;
let prego: PregoApp;
let base: string;

beforeAll(async () => {
  db = new PregoDb(join(dataDir, 'prego.sqlite'));
  prego = await buildApp({ db, dataDir });
  base = await prego.app.listen({ host: '127.0.0.1', port: 0 });
});

afterAll(async () => {
  await prego?.app.close();
  db?.close();
  rmSync(dataDir, { recursive: true, force: true });
});

describe('test groups and time estimates', () => {
  it('lists the groups, with no timings until an audit has run', async () => {
    const body = await (await fetch(`${base}/api/check-groups`)).json();
    expect(body.groups.map((g: { id: string }) => g.id)).toEqual(['quick', 'accessibility', 'content', 'design', 'performance', 'security', 'full']);
    expect(body.calibration).toBeNull();
    const checks = await (await fetch(`${base}/api/checks`)).json();
    expect(checks.find((c: { id: string }) => c.id === 'lighthouse').cost).toMatchObject({ id: 'lighthouse', perPage: true, serial: true });
  });

  it('records where an audit’s time went and learns from it', async () => {
    const res = await fetch(`${base}/api/runs`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ project: 'Timed', target: resolve('fixtures/bad-site'), checks: ['axe', 'content'], delayMs: 0, maxPages: 3 }),
    });
    const { runId } = await res.json();
    await prego.jobs.get(runId)!.done;
    const timings = db.getRun(runId)!.summary.timings as Record<string, unknown>;
    expect(timings).toMatchObject({ pageViews: expect.any(Number), openMs: expect.any(Number), totalMs: expect.any(Number), checks: { axe: expect.any(Number), content: expect.any(Number) } });
    const { calibration } = await (await fetch(`${base}/api/check-groups`)).json();
    expect(calibration).toMatchObject({ runs: 1, openSeconds: expect.any(Number), checks: { axe: expect.any(Number) } });
  }, 120_000);
});

describe('comparing two audits', () => {
  it('returns fixed, new, back-again and still-present tickets, earlier audit first', async () => {
    const start = async () => {
      const res = await fetch(`${base}/api/runs`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ project: 'Compared', target: resolve('fixtures/bad-site'), checks: ['axe'], delayMs: 0, maxPages: 3 }),
      });
      const { runId } = await res.json();
      await prego.jobs.get(runId)!.done;
      return runId as number;
    };
    const first = await start();
    expect((await fetch(`${base}/api/runs/${first}/compare`)).status).toBe(404);
    const second = await start();
    const run = await (await fetch(`${base}/api/runs/${second}`)).json();
    expect(run.hasPrevious).toBe(true);
    const body = await (await fetch(`${base}/api/runs/${first}/compare?with=${second}`)).json();
    expect(body).toMatchObject({ base: { id: first }, target: { id: second }, added: [], fixed: [], regressed: [], notChecked: [] });
    expect(body.recurring.length).toBeGreaterThan(0);
    expect(body.runs.map((r: { id: number }) => r.id)).toEqual(expect.arrayContaining([first, second]));
  }, 120_000);
});
