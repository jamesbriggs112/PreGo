import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PregoDb } from '../db/database.js';
import { runAudit } from '../audit/run-audit.js';
import { siteFacts, suggestAudience, suggestAudienceFor, askOllamaForAudience, type SiteFacts } from './suggest.js';
import { parseAudienceProfile } from './profile.js';

const dataDir = mkdtempSync(join(tmpdir(), 'prego-audience-'));
const db = new PregoDb(':memory:');
let facts: SiteFacts;

beforeAll(async () => {
  const { run } = await runAudit(db, { project: 'Acme Widgets', target: 'fixtures/bad-site', checks: ['structure'], delayMs: 0, dataDir });
  facts = siteFacts(db.getProject(run.projectId)!, db.getLocations(run.id));
}, 120_000);

afterAll(() => {
  db.close();
  rmSync(dataDir, { recursive: true, force: true });
});

describe('what Prego knows about a site', () => {
  it('records the navigation, headings, contact details and forms a visitor would see', () => {
    expect(facts.navigation.map((n) => n.label)).toEqual(['Home', 'About', 'News', 'Contact']);
    const contact = facts.pages.find((p) => p.path === '/contact.html')!;
    expect(contact.headings).toContain('Contact us');
    expect(contact.signals?.forms).toEqual(['contact']);
  });
});

describe('suggested purposes, personas and tasks', () => {
  it('finds the site’s purposes from its navigation and pages, with the evidence', () => {
    const { purposes } = suggestAudience(facts);
    expect(purposes.map((p) => p.id)).toEqual(expect.arrayContaining(['contact', 'news', 'about', 'staff']));
    const contact = purposes.find((p) => p.id === 'contact')!;
    expect(contact).toMatchObject({ current: true, intended: false, priority: 'primary' });
    expect(contact.evidence).toEqual(expect.arrayContaining(['“Contact” in the main navigation', 'contact details or a contact form on 1 page']));
    // The staff link is only in the footer, so it's a secondary purpose.
    expect(purposes.find((p) => p.id === 'staff')!.priority).toBe('secondary');
  });

  it('suggests personas, including a disabled person and an internal user, each with tasks', () => {
    const { personas, tasks } = suggestAudience(facts);
    expect(personas.map((p) => p.name)).toEqual(expect.arrayContaining(['On their phone, in a hurry', 'Screen reader user', 'Member of staff']));
    const staff = personas.find((p) => p.internal)!;
    expect(tasks.filter((t) => t.personaId === staff.id)).toEqual([expect.objectContaining({ goal: 'Find the staff area', success: { kind: 'page', path: '/private/admin.html' } })]);
    const phone = personas.find((p) => p.device === 'mobile')!;
    expect(tasks.find((t) => t.personaId === phone.id)).toMatchObject({ success: { kind: 'contact' } });
    for (const p of personas) expect(tasks.some((t) => t.personaId === p.id)).toBe(true);
  });

  it('treats what people search for, but the site doesn’t show, as a possible gap', () => {
    const visit = suggestAudience({ ...facts, searches: ['acme opening times', 'acme widgets'] }).purposes.find((p) => p.id === 'visit')!;
    expect(visit).toMatchObject({ current: false, evidence: ['people search for “acme opening times” (Search Console)'] });
  });

  it('uses Google Analytics devices to describe the phone user', () => {
    const withGa: SiteFacts = {
      ...facts,
      analytics: { importedAt: '', files: [], period: null, engagementSeconds: null, tables: [{ id: 'devices', title: 'Devices', measure: 'Active users', rows: [{ label: 'mobile', value: 62 }, { label: 'desktop', value: 38 }] }] },
    };
    expect(suggestAudience(withGa).personas[0].summary).toContain('62% of visitors use a phone');
  });
});

describe('suggestions from Ollama', () => {
  const answer = {
    purposes: [
      { title: 'Sell widgets', description: 'Shows the range.', primary: true, evidence: ['/products/mark-iv.html'] },
      { title: 'Take enquiries', description: 'Contact form.', primary: false, evidence: [] },
    ],
    personas: [
      {
        name: 'Busy buyer',
        summary: 'Buys for a factory.',
        context: 'At work.',
        device: 'desktop',
        accessNeeds: '',
        internal: false,
        purposes: [1, 2, 9],
        tasks: [
          { goal: 'Find the Mark IV', doneWhen: 'On its page', page: 'https://acme.example/contact.html' },
          { goal: 'Invent a page', doneWhen: 'Never', page: '/made-up.html' },
        ],
      },
    ],
  };
  const fake = (body: unknown, status = 200) => (async () => new Response(JSON.stringify({ message: { content: JSON.stringify(body) } }), { status })) as unknown as typeof fetch;

  it('keeps only pages Prego found and purposes that exist', async () => {
    const profile = await askOllamaForAudience({ url: 'http://127.0.0.1:11434', model: 'm' }, facts, fake(answer));
    expect(profile.purposes.map((p) => [p.title, p.priority])).toEqual([
      ['Sell widgets', 'primary'],
      ['Take enquiries', 'secondary'],
    ]);
    expect(profile.personas[0].purposeIds).toEqual(['purpose-1', 'purpose-2']);
    expect(profile.tasks.map((t) => t.success)).toEqual([{ kind: 'page', path: '/contact.html' }, { kind: 'described' }]);
  });

  it('falls back to Prego’s own suggestions when Ollama can’t help, and only talks to Ollama on this computer', async () => {
    const fallback = await suggestAudienceFor(facts, { url: 'http://127.0.0.1:11434', model: 'm' }, fake({ purposes: [], personas: [] }));
    expect(fallback).toMatchObject({ source: 'reader', note: expect.stringMatching(/no purposes or personas/) });
    expect((await suggestAudienceFor(facts, undefined)).source).toBe('reader');
    await expect(askOllamaForAudience({ url: 'https://ollama.example.com', model: 'm' }, facts, fake(answer))).rejects.toThrow(/only talks to Ollama on this computer/);
  });
});

describe('saving a profile', () => {
  it('drops incomplete entries, makes IDs unique and removes links that don’t resolve', () => {
    const profile = parseAudienceProfile({
      purposes: [{ id: 'sell', title: 'Sell', intended: true }, { id: 'sell', title: 'Sell again' }, { title: '' }],
      personas: [{ id: 'p', name: 'Pat', device: 'watch', purposeIds: ['sell', 'missing'] }, { name: '' }],
      tasks: [
        { personaId: 'p', goal: 'Buy', success: { kind: 'page', path: '/shop' } },
        { personaId: 'p', goal: 'Bad page', success: { kind: 'page', path: 'javascript:alert(1)' } },
        { personaId: 'nobody', goal: 'Orphan' },
      ],
    });
    expect(profile.purposes.map((p) => p.id)).toEqual(['sell', 'sell-2']);
    expect(profile.purposes[0]).toMatchObject({ intended: true, current: false, priority: 'secondary' });
    expect(profile.personas).toEqual([expect.objectContaining({ id: 'p', device: 'any', purposeIds: ['sell'] })]);
    expect(profile.tasks.map((t) => [t.goal, t.success])).toEqual([
      ['Buy', { kind: 'page', path: '/shop' }],
      ['Bad page', { kind: 'described' }],
    ]);
  });
});
