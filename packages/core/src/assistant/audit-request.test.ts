import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { askOllama, findAddress, readAuditRequest, understandAuditRequest } from './audit-request.js';

describe('the built-in reader', () => {
  it('reads the site, test group and screen sizes from a plain request', () => {
    expect(readAuditRequest('run a accessibiltiy audit on example.org')).toMatchObject({ target: 'https://example.org/' });
    expect(readAuditRequest('run an accessibility audit on example.org, desktop and mobile')).toEqual({
      target: 'https://example.org/',
      groups: ['accessibility'],
      viewports: ['desktop', 'mobile'],
    });
    expect(readAuditRequest('Check performance and security for https://staging.acme.example/shop, 30 pages, every screen size')).toEqual({
      target: 'https://staging.acme.example/shop',
      groups: ['performance', 'security'],
      viewports: ['desktop', 'mobile', 'tablet'],
      maxPages: 30,
    });
    expect(readAuditRequest('full audit of the whole site at www.makeuk.org for project "Make UK"')).toEqual({
      target: 'https://www.makeuk.org/',
      project: 'Make UK',
      groups: ['full'],
      auditAll: true,
    });
    expect(readAuditRequest('explore the kiosk app at http://localhost:5173 in portrait')).toMatchObject({ target: 'http://localhost:5173/', mode: 'explore', viewports: ['kiosk-portrait'] });
  });

  it('ignores email addresses and file names, and trims trailing punctuation', () => {
    expect(findAddress('email hello@example.org about report.docx')).toBeUndefined();
    expect(findAddress('audit example.org.')).toBe('https://example.org/');
    expect(findAddress('(see https://example.org/about).')).toBe('https://example.org/about');
    expect(readAuditRequest('run a quick check')).toEqual({ groups: ['quick'] });
  });
});

// A stand-in for Ollama's /api/chat, answering with structured output as a real model would.
let ollama: Server;
let url: string;
let answer: Record<string, unknown>;
const prompts: string[] = [];

beforeAll(async () => {
  ollama = createServer((req, res) => {
    let body = '';
    req.on('data', (chunk) => (body += chunk));
    req.on('end', () => {
      prompts.push(JSON.parse(body).messages[0].content);
      res.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify({ message: { role: 'assistant', content: JSON.stringify(answer) } }));
    });
  });
  await new Promise<void>((done) => ollama.listen(0, '127.0.0.1', done));
  url = `http://127.0.0.1:${(ollama.address() as AddressInfo).port}`;
});

afterAll(() => new Promise((done) => ollama.close(done)));

describe('reading with a local Ollama model', () => {
  it('turns looser wording into settings, keeping only known groups and screen sizes', async () => {
    answer = { project: 'Example', site: 'example.org', groups: ['accessibility', 'hacking'], viewports: ['mobile', 'watch'], maxPages: 0, everyPage: false, interactive: false };
    const request = await askOllama({ url, model: 'qwen2.5:3b' }, 'make sure example.org works for people using screen readers on their phones');
    expect(request).toEqual({ project: 'Example', target: 'https://example.org/', groups: ['accessibility'], viewports: ['mobile'] });
    expect(prompts.at(-1)).toContain('Request: make sure example.org works');
  });

  it('never uses an address that isn’t in the request', async () => {
    answer = { project: '', site: 'https://evil.example', groups: [], viewports: [], maxPages: 0, everyPage: false, interactive: false };
    expect((await askOllama({ url, model: 'm' }, 'check the Example site')).target).toBeUndefined();
  });

  it('fills in what the model missed from the built-in reader, and falls back to it when Ollama is down', async () => {
    answer = { project: '', site: '', groups: ['performance'], viewports: [], maxPages: 0, everyPage: false, interactive: false };
    expect(await understandAuditRequest('how fast is example.org on mobile?', { url, model: 'm' })).toEqual({
      source: 'ollama',
      request: { target: 'https://example.org/', viewports: ['mobile'], groups: ['performance'] },
    });
    const down = await understandAuditRequest('accessibility audit of example.org', { url: 'http://127.0.0.1:9', model: 'm' });
    expect(down).toMatchObject({ source: 'reader', request: { target: 'https://example.org/', groups: ['accessibility'] }, note: expect.stringMatching(/^Ollama didn’t answer/) });
    expect(await understandAuditRequest('accessibility audit of example.org', undefined)).toMatchObject({ source: 'reader' });
  });

  it('only talks to Ollama on this computer', async () => {
    await expect(askOllama({ url: 'https://ollama.example.com', model: 'm' }, 'audit example.org')).rejects.toThrow(/only talks to Ollama on this computer/);
  });
});
