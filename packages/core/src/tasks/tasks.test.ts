import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import JSZip from 'jszip';
import { PregoDb } from '../db/database.js';
import { runAudit } from '../audit/run-audit.js';
import { serveFolder, type StaticServer } from '../serve/static-server.js';
import { exportRun } from '../export/bundle.js';
import { DEFAULT_REPORT_OPTIONS } from '../export/report-options.js';
import type { AudienceProfile } from '../audience/types.js';
import type { Location } from '../types.js';
import { labelMatches, treeTest } from './tree.js';
import { walkTasks } from './walkthrough.js';

const dataDir = mkdtempSync(join(tmpdir(), 'prego-tasks-'));
const db = new PregoDb(':memory:');
let site: StaticServer;
let runId: number;

const profile: AudienceProfile = {
  updatedAt: '',
  purposes: [{ id: 'contact', title: 'Help people get in touch', description: '', current: true, intended: true, priority: 'primary', evidence: [] }],
  personas: [
    { id: 'phone', name: 'On their phone', summary: 'In a hurry.', context: 'On a bus.', device: 'mobile', accessNeeds: '', internal: false, purposeIds: ['contact'] },
    { id: 'staff', name: 'Member of staff', summary: 'Works at Acme.', context: '', device: 'desktop', accessNeeds: '', internal: true, purposeIds: [] },
  ],
  tasks: [
    { id: 'contact', personaId: 'phone', goal: 'Find a way to get in touch', doneWhen: 'They can see a contact form', success: { kind: 'contact' } },
    { id: 'staff', personaId: 'staff', goal: 'Find the staff area', doneWhen: 'They reach the staff area', success: { kind: 'page', path: '/private/admin.html' } },
    { id: 'missing', personaId: 'phone', goal: 'Find the price list', doneWhen: 'On the prices page', success: { kind: 'page', path: '/prices.html' } },
    { id: 'vague', personaId: 'phone', goal: 'Feel welcome', doneWhen: '', success: { kind: 'described' } },
  ],
};

beforeAll(async () => {
  site = await serveFolder('fixtures/bad-site', { substituteOrigin: true });
  const { run } = await runAudit(db, { project: 'Acme', target: site.url, checks: ['structure'], delayMs: 0, dataDir });
  runId = run.id;
  db.saveProjectSettings(run.projectId, { audience: profile });
}, 120_000);

afterAll(async () => {
  db.close();
  await site?.close();
  rmSync(dataDir, { recursive: true, force: true });
});

describe('the navigation test', () => {
  it('finds the shortest route to each task through the links found', () => {
    const results = Object.fromEntries(treeTest(profile, db.getLocations(runId)).map((r) => [r.taskId, r]));
    expect(results.contact).toMatchObject({ outcome: 'success', clicks: 1, route: [{ label: 'Contact', path: '/contact.html' }] });
    // The staff area isn't audited (robots.txt) but the footer links to it.
    expect(results.staff).toMatchObject({ outcome: 'success', clicks: 1, route: [{ label: 'Staff area' }] });
    expect(results.missing).toMatchObject({ outcome: 'failed', clicks: null, note: expect.stringMatching(/didn’t find anywhere/) });
    expect(results.vague.outcome).toBe('unchecked');
  });

  it('counts deep pages and unclear first links as partly done', () => {
    const page = (id: number, path: string, links: { label: string; path: string }[]): Location =>
      ({ id, kind: 'page', url: `https://example.org${path}`, depth: id, statusCode: 200, title: path, metrics: { signals: { tel: 0, mailto: 0, phoneText: false, forms: [], headings: [], links } } }) as unknown as Location;
    const locations = [
      page(0, '/', [{ label: 'Our work', path: '/a' }]),
      page(1, '/a', [{ label: 'More', path: '/b' }]),
      page(2, '/b', [{ label: 'Even more', path: '/c' }]),
      page(3, '/c', [{ label: 'Prices', path: '/prices' }]),
      page(4, '/prices', []),
    ];
    const deep = treeTest({ ...profile, tasks: [{ id: 't', personaId: 'phone', goal: 'Find prices', doneWhen: '', success: { kind: 'page', path: '/prices' } }] }, locations)[0];
    expect(deep).toMatchObject({ outcome: 'partial', clicks: 4, note: expect.stringMatching(/deeper than people tend to go.*“Our work”, doesn’t obviously relate/) });
    expect(labelMatches('Contact us', { goal: 'Get in touch', doneWhen: 'They see the contact page' })).toBe(true);
    expect(labelMatches('About', { goal: 'Find the opening times', doneWhen: '' })).toBe(false);
  });
});

describe('the AI walkthrough', () => {
  // A stand-in for Ollama: it reads the numbered options in the prompt and picks by label.
  const fakeOllama = (pick: (task: string) => string | null) =>
    (async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      if (!url.endsWith('/api/chat')) return fetch(input, init);
      const { messages } = JSON.parse(String(init!.body)) as { messages: { content: string; images: string[] }[] };
      expect(messages[0].images[0].length).toBeGreaterThan(100);
      const text = messages[0].content;
      const wanted = pick(/What you're trying to do: (.+)/.exec(text)![1]);
      const choice = wanted === null ? -1 : Number(new RegExp(`^(\\d+)\\. “${wanted}”`, 'm').exec(text)?.[1] ?? -1);
      return new Response(JSON.stringify({ message: { content: JSON.stringify({ choice, reason: wanted ? `${wanted} looks right` : 'I can’t see it' }) } }));
    }) as typeof fetch;

  it('plays each persona, checks the result itself, and never goes where robots.txt says not to', async () => {
    const picks: Record<string, string | null> = { 'Find a way to get in touch': 'Contact', 'Find the staff area': 'Staff area', 'Find the price list': null };
    const results = await walkTasks(
      { ...profile, tasks: profile.tasks.filter((t) => t.id !== 'vague') },
      { startUrl: site.url, ai: { url: 'http://127.0.0.1:11434', model: 'm' }, runDir: join(dataDir, 'walk'), fetchImpl: fakeOllama((task) => picks[task] ?? null) },
    );
    const byId = Object.fromEntries(results.map((r) => [r.taskId, r]));
    expect(byId.contact).toMatchObject({ outcome: 'success', steps: [{ action: 'Chose “Contact”', reason: 'Contact looks right' }], screenshot: null });
    expect(byId.staff).toMatchObject({ outcome: 'unchecked', note: expect.stringMatching(/robots\.txt/) });
    expect(byId.missing).toMatchObject({ outcome: 'failed', note: 'Gave up.', screenshot: 'tasks/missing.jpg' });
    expect(existsSync(join(dataDir, 'walk', 'tasks', 'missing.jpg'))).toBe(true);
  }, 120_000);

  it('only talks to Ollama on this computer', async () => {
    await expect(walkTasks(profile, { startUrl: site.url, ai: { url: 'https://ollama.example.com', model: 'm' }, runDir: dataDir })).rejects.toThrow(/only talks to Ollama on this computer/);
  });
});

describe('the Audience and tasks report', () => {
  it('shows every task’s results, each persona, and how it was tested, without ticket IDs', async () => {
    const run = db.getRun(runId)!;
    db.finishRun(runId, 'complete', {
      ...run.summary,
      walkthrough: [{ taskId: 'contact', personaId: 'phone', outcome: 'success', steps: [{ url: site.url, title: 'Home', action: 'Chose “Contact”', reason: 'Obvious' }], note: 'Done in 1 step.', screenshot: null }],
    });
    db.saveReportOptions(runId, { ...DEFAULT_REPORT_OPTIONS, reports: { overview: true, audience: true, future: false }, text: { audience: 'Staff rely on the footer.' } });
    const exported = await exportRun(db, runId, { dataDir, outDir: join(dataDir, 'pack') });
    const text = (await (await JSZip.loadAsync(readFileSync(exported.files.audience!))).file('word/document.xml')!.async('string')).replace(/<\/w:p>/g, '\n').replace(/<[^>]+>/g, '');
    expect([...text.matchAll(/^(\d+)\. (.+)$/gm)].map((m) => m[2])).toEqual(['At a glance', 'What the site is for', 'People and their tasks', 'How this was tested']);
    expect(text).toMatch(/On their phone\nFind a way to get in touch\nDone \(1 click\)\nDone \(1 steps?\)\n/);
    expect(text).toContain('Shortest route: Home › Contact.');
    expect(text).toContain('Member of staff (internal)');
    expect(text).toContain('Staff rely on the footer.');
    expect(text).toContain('not real users');
    expect(text).not.toMatch(/PRG-[A-Z0-9]+-\d{3}/);
    expect(JSON.parse(readFileSync(exported.files.runJson, 'utf8')).reports).toEqual(['report.docx', 'overview.docx', 'audience.docx']);
  }, 120_000);
});
