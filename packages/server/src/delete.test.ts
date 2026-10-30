import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { PregoDb, journeysDir, runDirectory, sessionPath } from '@prego/core';
import { buildApp, type PregoApp } from './app.js';

const dataDir = mkdtempSync(join(tmpdir(), 'prego-delete-'));
const fixture = resolve('fixtures/bad-site');
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

const call = (method: string, path: string, body?: unknown) =>
  fetch(base + path, { method, body: body === undefined ? undefined : JSON.stringify(body), headers: body === undefined ? {} : { 'Content-Type': 'application/json' } });

async function audit(project: string) {
  const { runId, projectId } = await (await call('POST', '/api/runs', { project, target: fixture, checks: ['axe'], delayMs: 0, maxPages: 2 })).json();
  await prego.jobs.get(runId)!.done;
  return { runId, projectId };
}

describe('deleting a project', () => {
  it('removes the project, its audits, screenshots, exports, journeys and saved session', async () => {
    const { runId, projectId } = await audit('Delete me');
    const keep = await audit('Keep me');
    const exported = await (await call('POST', `/api/runs/${runId}/exports`, {})).json();
    const journeys = journeysDir(dataDir, 'delete-me');
    mkdirSync(journeys, { recursive: true });
    writeFileSync(join(journeys, 'contact.js'), "await page.goto('https://example.org');\n");
    const session = sessionPath(dataDir, 'delete-me');
    mkdirSync(join(dataDir, 'sessions'), { recursive: true });
    writeFileSync(session, '{}');
    expect([runDirectory(dataDir, runId), exported.folder, journeys, session].every(existsSync)).toBe(true);

    const projects = await (await call('GET', '/api/projects')).json();
    expect(projects.find((p: { id: number }) => p.id === projectId)).toMatchObject({ runCount: 1 });

    const res = await call('DELETE', `/api/projects/${projectId}`);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ deleted: { project: 'Delete me', audits: 1, exports: 1 } });
    expect([runDirectory(dataDir, runId), exported.folder, journeys, session].some(existsSync)).toBe(false);
    expect((await call('GET', `/api/runs/${runId}`)).status).toBe(404);
    expect((await call('GET', `/api/projects/${projectId}`)).status).toBe(404);

    // The other project is untouched.
    expect(existsSync(runDirectory(dataDir, keep.runId))).toBe(true);
    expect((await call('GET', `/api/runs/${keep.runId}`)).status).toBe(200);
    expect((await call('DELETE', `/api/projects/${projectId}`)).status).toBe(404);
  }, 120_000);

  it('refuses while the project has an audit running', async () => {
    const { runId, projectId } = await (await call('POST', '/api/runs', { project: 'Busy', target: fixture, checks: ['axe'], delayMs: 2000 })).json();
    const res = await call('DELETE', `/api/projects/${projectId}`);
    expect(res.status).toBe(409);
    expect((await res.json()).error).toMatch(/Stop the running audit/);
    await call('POST', `/api/runs/${runId}/stop`, {});
    await prego.jobs.get(runId)!.done;
    expect((await call('DELETE', `/api/projects/${projectId}`)).status).toBe(200);
  }, 120_000);
});
