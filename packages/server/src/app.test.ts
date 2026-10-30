import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { PregoDb } from '@prego/core';
import { buildApp, type PregoApp } from './app.js';
import type { JobEvent } from './jobs.js';

const dataDir = mkdtempSync(join(tmpdir(), 'prego-server-'));
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

const api = (path: string, init?: RequestInit) =>
  fetch(base + path, { ...init, headers: { 'Content-Type': 'application/json', ...init?.headers } });
const post = (path: string, body: unknown) => api(path, { method: 'POST', body: JSON.stringify(body) });

/** Read a run's event stream until the server ends it. */
async function readEvents(runId: number): Promise<JobEvent[]> {
  const response = await fetch(`${base}/api/runs/${runId}/events`);
  expect(response.headers.get('content-type')).toBe('text/event-stream');
  const text = await response.text();
  return text
    .split('\n\n')
    .filter((chunk) => chunk.startsWith('data: '))
    .map((chunk) => JSON.parse(chunk.slice(6)));
}

describe('local-only guard', () => {
  it('refuses requests addressed to another host name (DNS rebinding)', async () => {
    const res = await prego.app.inject({ method: 'GET', url: '/api/projects', headers: { host: 'evil.example:4310' } });
    expect(res.statusCode).toBe(403);
  });

  it('refuses cross-site requests from other origins', async () => {
    const res = await api('/api/projects', { method: 'POST', body: '{"name":"x"}', headers: { Origin: 'https://evil.example' } });
    expect(res.status).toBe(403);
  });

  it('refuses form-encoded posts, which browsers can send cross-site without a preflight', async () => {
    const res = await fetch(`${base}/api/projects`, { method: 'POST', body: 'name=x', headers: { 'Content-Type': 'application/x-www-form-urlencoded' } });
    expect(res.status).toBe(415);
  });
});

describe('projects', () => {
  it('creates and lists projects', async () => {
    const created = await post('/api/projects', { name: 'Museum of Making' });
    expect(created.status).toBe(201);
    expect(await created.json()).toMatchObject({ name: 'Museum of Making', slug: 'museum-of-making' });
    const list = await (await api('/api/projects')).json();
    expect(list).toContainEqual(expect.objectContaining({ name: 'Museum of Making', lastRun: null, scores: null }));
  });

  it('rejects an empty name', async () => {
    expect((await post('/api/projects', { name: '' })).status).toBe(400);
  });
});

describe('starting an audit', () => {
  it('rejects a target that is neither a URL nor a folder', async () => {
    const res = await post('/api/runs', { project: 'Acme', target: 'not a url' });
    expect(res.status).toBe(400);
    expect((await res.json()).error).toMatch(/web address/);
  });

  it('rejects unknown viewports and options', async () => {
    expect((await post('/api/runs', { project: 'Acme', target: fixture, viewports: ['watch'] })).status).toBe(400);
    expect((await post('/api/runs', { project: 'Acme', target: fixture, colour: 'red' })).status).toBe(400);
  });

  it('runs in the background, streams progress and refuses a second audit meanwhile', async () => {
    const res = await post('/api/runs', { project: 'Acme', target: fixture, delayMs: 0, viewports: ['desktop'] });
    expect(res.status).toBe(202);
    const { runId } = await res.json();
    expect(await (await api('/api/runs/active')).json()).toMatchObject({ runId });

    const busy = await post('/api/runs', { project: 'Acme', target: fixture });
    expect(busy.status).toBe(409);
    expect(await busy.json()).toMatchObject({ runId });

    const events = await readEvents(runId);
    expect(events[0]).toMatchObject({ type: 'started', runId });
    expect(events.filter((e) => e.type === 'page-found')).toHaveLength(5);
    const audited = events.filter((e) => e.type === 'location-audited');
    expect(audited).toHaveLength(5);
    expect(audited[0]).toMatchObject({ viewport: 'desktop', screenshot: expect.stringMatching(/^screenshots[/\\].+\.png$/) });
    expect(events.at(-1)).toEqual({ type: 'end', status: 'complete' });

    // A late subscriber gets the whole history replayed.
    const replay = await readEvents(runId);
    expect(replay).toEqual(events);

    const run = await (await api(`/api/runs/${runId}`)).json();
    expect(run).toMatchObject({ status: 'complete', project: { name: 'Acme' }, summary: { pagesFound: 5, pagesAudited: 5 } });
    expect(run.scores.A11Y).toBeGreaterThan(0);
    expect(run.scores.SEC).toBeUndefined();
    expect(run.settings).not.toHaveProperty('basicAuth.password');

    // Screenshots are served from the run folder.
    const shot = await fetch(`${base}/api/runs/${runId}/files/${(audited[0] as { screenshot: string }).screenshot}`);
    expect(shot.headers.get('content-type')).toBe('image/png');
    expect((await shot.arrayBuffer()).byteLength).toBeGreaterThan(1000);

    const projects = await (await api('/api/projects')).json();
    expect(projects.find((p: { name: string }) => p.name === 'Acme')).toMatchObject({ lastRun: { id: runId, status: 'complete' } });
  }, 120_000);

  it('stops a running audit', async () => {
    const { runId } = await (await post('/api/runs', { project: 'Acme', target: fixture, delayMs: 2000 })).json();
    expect((await post(`/api/runs/${runId}/stop`, {})).status).toBe(200);
    const events = await readEvents(runId);
    expect(events.at(-1)).toMatchObject({ type: 'end', status: 'stopped' });
    expect(await (await api(`/api/runs/${runId}`)).json()).toMatchObject({ status: 'stopped' });
    expect((await post(`/api/runs/${runId}/stop`, {})).status).toBe(409);
  }, 120_000);
});

describe('run files', () => {
  it("won't serve files outside the run folder or that aren't images", async () => {
    expect((await fetch(`${base}/api/runs/1/files/..%2F..%2Fprego.sqlite`)).status).toBe(404);
    expect((await fetch(`${base}/api/runs/1/files/../../prego.sqlite`)).status).toBe(404);
  });

  it('returns 404 for unknown runs', async () => {
    expect((await api('/api/runs/999')).status).toBe(404);
    expect((await api('/api/runs/999/events')).status).toBe(404);
  });
});
