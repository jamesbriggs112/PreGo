import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import JSZip from 'jszip';
import { PNG } from 'pngjs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { PregoDb, serveFolder } from '@prego/core';
import { buildApp, type PregoApp } from './app.js';
import type { JobEvent } from './jobs.js';

const dataDir = mkdtempSync(join(tmpdir(), 'prego-server-'));
const fixture = resolve('fixtures/bad-site');
let db: PregoDb;
let prego: PregoApp;
let base: string;
let completedRunId: number;

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

describe('health', () => {
  it('answers once the server is up (the dev GUI waits for this before opening)', async () => {
    expect(await (await api('/api/health')).json()).toEqual({ ok: true });
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

  it('runs in the background, streams progress and queues a second audit meanwhile', async () => {
    const res = await post('/api/runs', { project: 'Acme', target: fixture, delayMs: 0, viewports: ['desktop'] });
    expect(res.status).toBe(202);
    const { runId } = await res.json();
    completedRunId = runId;
    expect(await (await api('/api/runs/active')).json()).toMatchObject({ runId });

    // A second audit waits its turn; taking it out of the queue means it never starts.
    const busy = await post('/api/runs', { project: 'Acme', target: fixture });
    expect(busy.status).toBe(202);
    const queued = await busy.json();
    expect(queued).toMatchObject({ runId, queued: { project: 'Acme', target: fixture, position: 1 } });
    expect(await (await api('/api/queue')).json()).toMatchObject([{ id: queued.queued.id, position: 1 }]);
    expect((await fetch(`${base}/api/queue/${queued.queued.id}`, { method: 'DELETE' })).status).toBe(204);
    expect(await (await api('/api/queue')).json()).toEqual([]);
    expect((await fetch(`${base}/api/queue/${queued.queued.id}`, { method: 'DELETE' })).status).toBe(404);

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
    // Audits started through the API use the defaults in Settings, which include Lighthouse.
    expect(run.scores.SEC).toBeGreaterThan(0);
    expect(run.scores.PERF).toBeGreaterThanOrEqual(0);
    expect(run.settings).not.toHaveProperty('basicAuth.password');

    // Screenshots are served from the run folder.
    const shot = await fetch(`${base}/api/runs/${runId}/files/${(audited[0] as { screenshot: string }).screenshot}`);
    expect(shot.headers.get('content-type')).toBe('image/png');
    expect((await shot.arrayBuffer()).byteLength).toBeGreaterThan(1000);

    const projects = await (await api('/api/projects')).json();
    expect(projects.find((p: { name: string }) => p.name === 'Acme')).toMatchObject({ lastRun: { id: runId, status: 'complete' } });
  }, 120_000);

  it('audits a web address, not just a local folder', async () => {
    // Regression: with a URL target the audit announced itself synchronously, which crashed the job
    // runner and left the run stuck at "running".
    const site = await serveFolder(fixture, { substituteOrigin: true });
    try {
      const res = await post('/api/runs', { project: 'Web target', target: site.url, delayMs: 0 });
      expect(res.status).toBe(202);
      const { runId } = await res.json();
      const events = await readEvents(runId);
      expect(events[0]).toMatchObject({ type: 'started', runId });
      expect(events.at(-1)).toEqual({ type: 'end', status: 'complete' });
      expect(await (await api(`/api/runs/${runId}`)).json()).toMatchObject({ status: 'complete', target: site.url, summary: { pagesFound: 5 } });
    } finally {
      await site.close();
    }
  }, 120_000);

  it('explores an interactive and remembers its denylist and masks for the project', async () => {
    const kioskDir = resolve('fixtures/kiosk-app');
    const res = await post('/api/runs', {
      project: 'Museum',
      target: kioskDir,
      mode: 'explore',
      viewports: ['kiosk-landscape'],
      maxStates: 4,
      denyLabels: ['send', ' delete ', ''],
      maskSelectors: ['.attract-hint'],
    });
    expect(res.status).toBe(202);
    const { runId, projectId } = await res.json();
    const events = await readEvents(runId);
    expect(events.filter((e) => e.type === 'state-found')).toHaveLength(4);
    expect(events.at(-1)).toEqual({ type: 'end', status: 'complete' });
    expect(await (await api(`/api/runs/${runId}`)).json()).toMatchObject({ mode: 'explore', summary: { statesFound: 4 } });
    expect(await (await api(`/api/projects/${projectId}`)).json()).toMatchObject({
      settings: { denyLabels: ['send', 'delete'], maskSelectors: ['.attract-hint'] },
    });
    expect((await post('/api/runs', { project: 'Museum', target: kioskDir, mode: 'teleport' })).status).toBe(400);
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

describe('tickets', () => {
  const patch = (ticketId: string, body: unknown) => api(`/api/runs/${completedRunId}/tickets/${ticketId}`, { method: 'PATCH', body: JSON.stringify(body) });
  type ApiTicket = { ticketId: string; ruleId: string; templateKey: string | null; pages: string[]; occurrences: number };
  const list = async (): Promise<ApiTicket[]> => (await api(`/api/runs/${completedRunId}/tickets`)).json();

  it('lists tickets with the pages they affect', async () => {
    const tickets = await list();
    expect(tickets.length).toBeGreaterThan(5);
    const logo = tickets.find((t) => t.ruleId === 'image-alt' && t.templateKey === null)!;
    expect(logo.pages).toHaveLength(5);
  });

  it('returns a ticket with every occurrence and its crop', async () => {
    const [first] = await list();
    const detail = await (await api(`/api/runs/${completedRunId}/tickets/${first.ticketId}`)).json();
    expect(detail.occurrenceList).toHaveLength(first.occurrences);
    expect(detail.occurrenceList[0]).toMatchObject({ url: expect.stringMatching(/^http/), crop: expect.stringMatching(/^crops/) });
    expect(detail.helpUrl).toMatch(/dequeuniversity/);
    expect((await api(`/api/runs/${completedRunId}/tickets/PRG-A11Y-999`)).status).toBe(404);
  });

  it('validates and applies edits', async () => {
    const [first] = await list();
    expect((await patch(first.ticketId, { severity: 'Huge' })).status).toBe(400);
    expect((await patch(first.ticketId, { colour: 'red' })).status).toBe(400);
    expect((await patch(first.ticketId, {})).status).toBe(400);
    expect((await patch('PRG-A11Y-999', { dismissed: true })).status).toBe(404);
    const edited = await (await patch(first.ticketId, { severity: 'Low', auditorNotes: 'Checked with client' })).json();
    expect(edited).toMatchObject({ severity: 'Low', auditorNotes: 'Checked with client' });
  });

  it('merges tickets', async () => {
    const headings = (await list()).filter((t) => t.ruleId === 'heading-order');
    expect(headings).toHaveLength(2);
    const merge = (body: unknown) => api(`/api/runs/${completedRunId}/tickets/merge`, { method: 'POST', body: JSON.stringify(body) });
    expect((await merge({ into: headings[0].ticketId, from: [headings[0].ticketId] })).status).toBe(400);
    const merged = await (await merge({ into: headings[0].ticketId, from: [headings[1].ticketId] })).json();
    expect(merged.occurrences).toBe(headings[0].occurrences + headings[1].occurrences);
    expect((await list()).filter((t) => t.ruleId === 'heading-order')).toHaveLength(1);
  });
});

describe('settings', () => {
  const put = (path: string, body: unknown) => api(path, { method: 'PUT', body: JSON.stringify(body) });

  it('returns defaults, then saves and validates changes', async () => {
    const defaults = await (await api('/api/settings')).json();
    expect(defaults).toMatchObject({ branding: { companyName: 'Four' }, defaults: { viewports: ['desktop'], csvPreset: 'prego' }, hasLogo: false });
    const changed = { ...defaults, branding: { companyName: 'Four Agency', accentColour: '#7a1f5c' }, defaults: { ...defaults.defaults, csvPreset: 'jira' } };
    delete changed.hasLogo;
    delete changed.exploreDefaults;
    expect(await (await put('/api/settings', changed)).json()).toMatchObject({ branding: { companyName: 'Four Agency', accentColour: '7A1F5C' } });
    expect((await put('/api/settings', { ...changed, branding: { companyName: 'x', accentColour: 'purple' } })).status).toBe(400);
    expect((await put('/api/settings', { ...changed, defaults: { ...changed.defaults, csvPreset: 'asana' } })).status).toBe(400);
    expect((await put('/api/settings', { ...changed, defaults: { ...changed.defaults, viewports: ['watch'] } })).status).toBe(400);
  });

  it('accepts a PNG logo and refuses anything else', async () => {
    const png = readFileSync('packages/web/public/favicon.svg');
    expect((await put('/api/settings/logo', { png: png.toString('base64') })).status).toBe(400);
    const logo = new PNG({ width: 200, height: 60 });
    logo.data.fill(90);
    expect((await put('/api/settings/logo', { png: PNG.sync.write(logo).toString('base64') })).status).toBe(200);
    expect((await api('/api/settings/logo')).headers.get('content-type')).toBe('image/png');
    await expect((await api('/api/settings')).json()).resolves.toMatchObject({ hasLogo: true });
  });
});

describe('exports', () => {
  it('creates an export with the saved branding and preset, and lists it', async () => {
    const res = await post(`/api/runs/${completedRunId}/exports`, {});
    expect(res.status).toBe(201);
    const created = await res.json();
    expect(created).toMatchObject({ preset: 'jira', files: ['report.docx', 'tickets.csv', 'occurrences.csv', 'qa-checklist.csv', 'run.json'] });
    expect(await (await api(`/api/runs/${completedRunId}/exports`)).json()).toContainEqual(expect.objectContaining({ id: created.id }));

    const csv = await (await api(`/api/exports/${created.id}/files/tickets.csv`)).text();
    expect(csv).toContain('"Summary"');

    const docx = await (await api(`/api/exports/${created.id}/files/report.docx`)).arrayBuffer();
    const zip = await JSZip.loadAsync(docx);
    expect(await zip.file('word/document.xml')!.async('string')).toContain('Four Agency');
    expect(Object.keys(zip.files).filter((f) => f.startsWith('word/media/')).length).toBeGreaterThan(1);

    // The screenshots are in the report now, so Prego deletes its own copies.
    expect(await (await api(`/api/runs/${completedRunId}`)).json()).toMatchObject({ screenshotsDeleted: true });
    expect(readdirSync(join(dataDir, 'runs', String(completedRunId)))).not.toContain('crops');
    const [ticket] = await (await api(`/api/runs/${completedRunId}/tickets`)).json();
    const detail = await (await api(`/api/runs/${completedRunId}/tickets/${ticket.ticketId}`)).json();
    expect(detail.screenshotsDeleted).toBe(true);
    expect(detail.occurrenceList.every((o: { crop: string | null }) => o.crop === null)).toBe(true);
  });

  it('downloads the whole bundle as a zip', async () => {
    const [latest] = await (await api(`/api/runs/${completedRunId}/exports`)).json();
    const res = await api(`/api/exports/${latest.id}/zip`);
    expect(res.headers.get('content-disposition')).toMatch(/attachment; filename=".+\.zip"/);
    const zip = await JSZip.loadAsync(await res.arrayBuffer());
    const names = Object.keys(zip.files);
    expect(names).toContainEqual(expect.stringMatching(/\/report\.docx$/));
    expect(names).toContainEqual(expect.stringMatching(/\/tickets\.csv$/));
    expect(names.filter((n) => n.includes('/screenshots/'))).toEqual([]);
  });

  it('refuses unknown presets, files and runs that are not finished', async () => {
    expect((await post(`/api/runs/${completedRunId}/exports`, { preset: 'asana' })).status).toBe(400);
    expect((await api('/api/exports/1/files/..%2F..%2Fprego.sqlite')).status).toBe(404);
    expect((await api('/api/exports/999/zip')).status).toBe(404);
    const stopped = db.listRuns(db.getProjectBySlug('acme')!.id).find((r) => r.status === 'stopped')!;
    expect((await post(`/api/runs/${stopped.id}/exports`, {})).status).toBe(409);
  });

  it('previews the report as HTML', async () => {
    const { html } = await (await api(`/api/runs/${completedRunId}/report-preview`)).json();
    expect(html).toContain('Executive summary');
    expect(html).toContain('<img');
  });
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
