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

describe('AI review settings', () => {
  const put = (body: unknown) => fetch(`${base}/api/settings`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });

  it('is off by default, refuses audits that ask for it, and only accepts Ollama on this computer', async () => {
    const settings = await (await fetch(`${base}/api/settings`)).json();
    expect(settings.ai).toEqual({ enabled: false, url: 'http://127.0.0.1:11434', model: 'qwen2.5vl:7b' });
    const checks = await (await fetch(`${base}/api/checks`)).json();
    expect(checks.find((c: { id: string }) => c.id === 'ai')).toMatchObject({ available: false, defaultOn: false });

    const start = await fetch(`${base}/api/runs`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ project: 'AI', target: resolve('fixtures/bad-site'), checks: ['ai'] }) });
    expect(start.status).toBe(400);
    expect((await start.json()).error).toMatch(/AI review is switched off/);

    const { hasLogo: _h, exploreDefaults: _e, ...editable } = settings;
    const remote = await put({ ...editable, ai: { enabled: true, url: 'https://ollama.example.com', model: 'm' } });
    expect(remote.status).toBe(400);
    expect((await remote.json()).error).toMatch(/only talks to Ollama on this computer/);
    expect((await put({ ...editable, ai: { enabled: true, url: 'http://localhost:11434', model: 'llava' } })).status).toBe(200);
    expect((await (await fetch(`${base}/api/checks`)).json()).find((c: { id: string }) => c.id === 'ai').available).toBe(true);

    const test = await fetch(`${base}/api/settings/ai/test`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ url: 'http://127.0.0.1:9' }) });
    expect(test.status).toBe(502);
    expect((await test.json()).error).toMatch(/Nothing is answering/);
    await put({ ...editable });
  });
});

describe('setting up an audit from a typed request', () => {
  const plan = async (text: string) => (await fetch(`${base}/api/assistant/plan`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ text }) })).json();

  it('reads the request into settings to confirm, without starting anything', async () => {
    const runsBefore = db.listProjects().flatMap((p) => db.listRuns(p.id)).length;
    const body = await plan('run an accessibility audit on fcn.com, desktop and mobile');
    expect(body).toMatchObject({
      source: 'reader',
      problems: [],
      projectExists: false,
      checksLabel: 'Accessibility',
      estimate: expect.stringMatching(/minute|hour/),
      run: { project: 'fcn.com', target: 'https://fcn.com/', mode: 'crawl', checks: ['axe', 'a11y-custom', 'ibm', 'canvas'], viewports: ['desktop', 'mobile'], maxPages: 100, auditAll: false },
    });
    expect(db.listProjects().flatMap((p) => db.listRuns(p.id))).toHaveLength(runsBefore);
    expect(db.listProjects().some((p) => p.name === 'fcn.com')).toBe(false);
  });

  it('finds the existing project by name or by an earlier audit of the same site', async () => {
    const fcn = db.createProject('Football Club Network');
    db.createRun({ projectId: fcn.id, mode: 'crawl', target: 'https://www.fcn.com/' });
    expect(await plan('quick check of fcn.com')).toMatchObject({ projectExists: true, run: { project: 'Football Club Network', checks: ['axe', 'golive', 'links', 'security'] } });
    expect(await plan('security audit of staging.fcn.com for "football club network"')).toMatchObject({ projectExists: true, run: { project: 'Football Club Network' } });
  });

  it('asks for the site when the request doesn’t give one, and rejects empty requests', async () => {
    expect((await plan('run an accessibility audit')).problems).toEqual([expect.stringMatching(/^Say which site to audit/)]);
    const empty = await fetch(`${base}/api/assistant/plan`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ text: '' }) });
    expect(empty.status).toBe(400);
  });
});

describe('report contents and analytics', () => {
  const json = (method: string, body: unknown) => ({ method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });

  it('saves the report options per audit and imports Google Analytics exports for the project', async () => {
    const run = db.listProjects().flatMap((p) => db.listRuns(p.id)).find((r) => r.status === 'complete')!;
    const before = await (await fetch(`${base}/api/runs/${run.id}/report`)).json();
    expect(before).toMatchObject({ options: { clientFacing: false }, available: { analytics: false } });
    expect(before.suggestions.recommendations).toEqual(expect.any(String));

    const saved = await (await fetch(`${base}/api/runs/${run.id}/report`, json('PUT', { clientFacing: true, include: { analytics: true }, text: { summary: 'Hello' } }))).json();
    expect(saved.outline.map((o: { title: string }) => o.title).slice(0, 2)).toEqual(['Executive summary', 'Methodology']);
    expect(db.getReportOptions(run.id)).toMatchObject({ clientFacing: true, text: { summary: 'Hello' } });

    const ga = 'Device category,Active users\nmobile,10\ndesktop,5\n';
    const bad = await fetch(`${base}/api/projects/${run.projectId}/analytics`, json('PUT', { files: [{ name: 'x.csv', text: 'Name,Email\n' }] }));
    expect(bad.status).toBe(400);
    expect((await bad.json()).error).toMatch(/look like a Google Analytics report/);
    const imported = await fetch(`${base}/api/projects/${run.projectId}/analytics`, json('PUT', { files: [{ name: 'devices.csv', text: ga }] }));
    expect(imported.status).toBe(200);
    const after = await (await fetch(`${base}/api/runs/${run.id}/report`)).json();
    expect(after.available.analytics).toBe(true);
    expect(after.outline.map((o: { id: string }) => o.id)).toContain('analytics');

    await fetch(`${base}/api/projects/${run.projectId}/analytics`, { method: 'DELETE' });
    expect(db.getProject(run.projectId)!.settings.analytics).toBeUndefined();
  });
});
