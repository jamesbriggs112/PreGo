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
    const body = await plan('run an accessibility audit on example.org, desktop and mobile');
    expect(body).toMatchObject({
      source: 'reader',
      problems: [],
      projectExists: false,
      checksLabel: 'Accessibility',
      estimate: expect.stringMatching(/minute|hour/),
      run: { project: 'example.org', target: 'https://example.org/', mode: 'crawl', checks: ['axe', 'a11y-custom', 'ibm', 'canvas'], viewports: ['desktop', 'mobile'], maxPages: 100, auditAll: false },
    });
    expect(db.listProjects().flatMap((p) => db.listRuns(p.id))).toHaveLength(runsBefore);
    expect(db.listProjects().some((p) => p.name === 'example.org')).toBe(false);
  });

  it('finds the existing project by name or by an earlier audit of the same site', async () => {
    const example = db.createProject('Example Organisation');
    db.createRun({ projectId: example.id, mode: 'crawl', target: 'https://www.example.org/' });
    expect(await plan('quick check of example.org')).toMatchObject({ projectExists: true, run: { project: 'Example Organisation', checks: ['axe', 'golive', 'links', 'security'] } });
    expect(await plan('security audit of staging.example.org for "example organisation"')).toMatchObject({ projectExists: true, run: { project: 'Example Organisation' } });
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
  it('suggests and saves a project’s purposes, personas and tasks', async () => {
    const run = db.listProjects().flatMap((p) => db.listRuns(p.id)).find((r) => r.status === 'complete')!;
    const empty = await (await fetch(`${base}/api/projects/${run.projectId}/audience`)).json();
    expect(empty).toMatchObject({ profile: null, latestRunId: expect.any(Number), pages: expect.arrayContaining([expect.stringMatching(/^\//)]) });

    const suggestion = await (await fetch(`${base}/api/projects/${run.projectId}/audience/suggest`, json('POST', {}))).json();
    expect(suggestion.source).toBe('reader');
    expect(suggestion.profile.personas.length).toBeGreaterThan(0);
    // Suggesting doesn't save anything.
    expect(db.getProject(run.projectId)!.settings.audience).toBeUndefined();

    const saved = await (
      await fetch(`${base}/api/projects/${run.projectId}/audience`, json('PUT', { purposes: [{ id: 'x', title: 'Sell', intended: true }], personas: [{ id: 'p', name: 'Pat', purposeIds: ['x'] }], tasks: [{ personaId: 'p', goal: 'Buy' }] }))
    ).json();
    expect(saved.profile).toMatchObject({ purposes: [{ id: 'x', intended: true }], personas: [{ name: 'Pat', purposeIds: ['x'] }], tasks: [{ goal: 'Buy', success: { kind: 'described' } }] });
    expect((await (await fetch(`${base}/api/projects/${run.projectId}/audience`)).json()).profile.purposes[0].title).toBe('Sell');
    await fetch(`${base}/api/projects/${run.projectId}/audience`, { method: 'DELETE' });
    expect(db.getProject(run.projectId)!.settings.audience).toBeUndefined();

    const unaudited = db.createProject('Not audited yet');
    const refused = await fetch(`${base}/api/projects/${unaudited.id}/audience/suggest`, json('POST', {}));
    expect(refused.status).toBe(409);
    expect((await refused.json()).error).toMatch(/^Run an audit of this site first/);
    expect((await fetch(`${base}/api/projects/9999/audience`)).status).toBe(404);
  });

  it('keeps standard wording in Settings and previews the Overview', async () => {
    const run = db.listProjects().flatMap((p) => db.listRuns(p.id)).find((r) => r.status === 'complete')!;
    const settings = await (await fetch(`${base}/api/settings`)).json();
    expect(settings.report.whyItMatters).toMatch(/^A website is often the first place/);
    const { hasLogo: _logo, exploreDefaults: _explore, ...body } = settings;
    const saved = await (await fetch(`${base}/api/settings`, json('PUT', { ...body, report: { whyItMatters: 'Our standard words.' } }))).json();
    expect(saved.report.whyItMatters).toBe('Our standard words.');
    // Settings saved without the wording (an older screen) keep what's there.
    const { report: _report, ...withoutReport } = body;
    expect((await (await fetch(`${base}/api/settings`, json('PUT', withoutReport))).json()).report.whyItMatters).toBe('Our standard words.');

    const preview = await (await fetch(`${base}/api/runs/${run.id}/report-preview?report=overview`)).json();
    expect(preview.html).toContain('Website health overview');
    expect(preview.html).toContain('Our standard words.');
    await fetch(`${base}/api/settings`, json('PUT', { ...body, report: { whyItMatters: '' } }));
    expect((await (await fetch(`${base}/api/settings`)).json()).report.whyItMatters).toMatch(/^A website is often/);
  });
});
