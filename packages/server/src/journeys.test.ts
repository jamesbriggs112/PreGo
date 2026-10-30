import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { EventEmitter } from 'node:events';
import type { ChildProcess } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PregoDb, serveFolder, type StaticServer } from '@prego/core';
import { buildApp, type PregoApp } from './app.js';
import type { RecordRequest } from './recorder.js';

const dataDir = mkdtempSync(join(tmpdir(), 'prego-server-journeys-'));
let db: PregoDb;
let prego: PregoApp;
let base: string;
let site: StaticServer;
const requests: RecordRequest[] = [];

/** Stands in for Playwright's code generator: "records" the fixture journey, then closes. */
function fakeRecorder(request: RecordRequest): ChildProcess {
  requests.push(request);
  const child = new EventEmitter() as ChildProcess;
  setTimeout(() => {
    if (!request.url.includes('nothing')) {
      writeFileSync(request.outputFile, readFileSync('fixtures/journeys/bad-site-contact.js', 'utf8').replace('{{ORIGIN}}', site.origin));
    }
    child.emit('exit', 0);
  }, 100);
  return child;
}

beforeAll(async () => {
  site = await serveFolder('fixtures/bad-site', { substituteOrigin: true });
  db = new PregoDb(join(dataDir, 'prego.sqlite'));
  prego = await buildApp({ db, dataDir, recorder: fakeRecorder });
  base = await prego.app.listen({ host: '127.0.0.1', port: 0 });
});

afterAll(async () => {
  await prego?.app.close();
  db?.close();
  await site?.close();
  rmSync(dataDir, { recursive: true, force: true });
});

const post = (path: string, body: unknown) => fetch(base + path, { method: 'POST', body: JSON.stringify(body), headers: { 'Content-Type': 'application/json' } });
const get = async (path: string) => (await fetch(base + path)).json();
const until = async (check: () => Promise<boolean>) => {
  for (let i = 0; i < 50 && !(await check()); i++) await new Promise((r) => setTimeout(r, 100));
};

describe('journeys', () => {
  let projectId: number;

  it('records a journey with the code generator and lists its steps', async () => {
    projectId = (await (await post('/api/projects', { name: 'Acme' })).json()).id;
    const res = await post(`/api/projects/${projectId}/journeys/record`, { name: 'Contact form', url: site.url });
    expect(res.status).toBe(202);
    expect(await res.json()).toEqual({ name: 'contact-form', status: 'recording' });
    expect(requests.at(-1)).toMatchObject({ url: site.url, outputFile: join(dataDir, 'journeys', 'acme', 'contact-form.js') });

    await until(async () => (await get(`/api/projects/${projectId}/journeys`)).recordings[0]?.status === 'saved');
    const { journeys, recordings } = await get(`/api/projects/${projectId}/journeys`);
    expect(recordings).toEqual([{ projectId, name: 'contact-form', status: 'saved' }]);
    expect(journeys).toEqual([
      expect.objectContaining({ name: 'contact-form', startUrl: `${site.origin}/index.html`, steps: expect.arrayContaining([{ index: 3, description: 'Click the “Contact” link' }]) }),
    ]);
    expect(journeys[0].unsupported).toHaveLength(2);
  });

  it('reports a recording that saved nothing', async () => {
    await post(`/api/projects/${projectId}/journeys/record`, { name: 'Empty', url: `${site.url}nothing` });
    await until(async () => (await get(`/api/projects/${projectId}/journeys`)).recordings.some((r: { name: string; status: string }) => r.name === 'empty' && r.status !== 'recording'));
    const { recordings } = await get(`/api/projects/${projectId}/journeys`);
    expect(recordings.find((r: { name: string }) => r.name === 'empty')).toMatchObject({ status: 'failed', error: 'Nothing was recorded' });
  });

  it('validates recording requests', async () => {
    expect((await post(`/api/projects/${projectId}/journeys/record`, { name: 'x', url: 'file:///etc' })).status).toBe(400);
    expect((await post('/api/projects/999/journeys/record', { name: 'x', url: site.url })).status).toBe(404);
  });

  it('replays the recorded journey as an audit, with findings for each step', async () => {
    const res = await post('/api/runs', { project: 'Acme', target: `${site.origin}/index.html`, mode: 'journey', journey: 'contact-form', delayMs: 0 });
    expect(res.status).toBe(202);
    const { runId } = await res.json();
    await prego.jobs.get(runId)!.done;
    const run = await get(`/api/runs/${runId}`);
    expect(run).toMatchObject({ status: 'complete', mode: 'journey', summary: { stepsReplayed: 4, completed: true } });
    expect(run.locations.map((l: { title: string }) => l.title)[2]).toBe('Step 3: Click the “Contact” link');
    for (const location of run.locations) expect(db.getRawFindings(runId).some((f) => f.locationId === location.id)).toBe(true);
  }, 120_000);

  it('refuses journey audits without a recorded journey', async () => {
    expect((await post('/api/runs', { project: 'Acme', target: site.url, mode: 'journey', journey: 'missing' })).status).toBe(400);
    expect((await post('/api/runs', { project: 'Acme', target: site.url, loginJourney: 'missing' })).status).toBe(400);
  });
});
