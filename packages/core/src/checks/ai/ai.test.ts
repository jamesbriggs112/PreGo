import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createServer, type Server } from 'node:http';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AddressInfo } from 'node:net';
import { PregoDb } from '../../db/database.js';
import { runAudit } from '../../audit/run-audit.js';
import { buildExportPlan, allExported } from '../../export/plan.js';
import { updateTicket } from '../../tickets/triage.js';
import { assertLocalOllama } from './ai.js';

// A stand-in for Ollama's /api/chat, answering as a vision model would with structured output.
const dataDir = mkdtempSync(join(tmpdir(), 'prego-ai-'));
const db = new PregoDb(':memory:');
const requests: { model: string; images: string[]; format: unknown }[] = [];
let ollama: Server;
let url: string;

beforeAll(async () => {
  ollama = createServer((req, res) => {
    let body = '';
    req.on('data', (chunk) => (body += chunk));
    req.on('end', () => {
      const parsed = JSON.parse(body);
      requests.push({ model: parsed.model, images: parsed.messages[0].images, format: parsed.format });
      const findings = [
        { heuristic: 4, severity: 'Medium', problem: 'Buttons on this screen use three different styles.', evidence: 'The “Send” button is blue, “Reset” is grey and “Back” is a text link.', recommendation: 'Use one primary and one secondary button style.' },
        { heuristic: 11, severity: 'High', problem: 'Out of range', evidence: '', recommendation: '' },
      ];
      res.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify({ message: { role: 'assistant', content: JSON.stringify({ findings }) } }));
    });
  });
  await new Promise<void>((done) => ollama.listen(0, '127.0.0.1', done));
  url = `http://127.0.0.1:${(ollama.address() as AddressInfo).port}`;
});

afterAll(async () => {
  db.close();
  await new Promise((done) => ollama.close(done));
  rmSync(dataDir, { recursive: true, force: true });
});

describe('AI heuristic review (T31)', () => {
  it('with Ollama running locally, findings appear as AI-suggested and Needs review, and stay out of exports', async () => {
    const { run } = await runAudit(db, { project: 'AI', target: 'fixtures/bad-site', checks: ['ai'], delayMs: 0, dataDir, maxPages: 2, ai: { url, model: 'qwen2.5vl:7b' } });
    expect(run.status).toBe('complete');
    expect(requests.length).toBeGreaterThan(0);
    expect(requests[0]).toMatchObject({ model: 'qwen2.5vl:7b', format: expect.objectContaining({ type: 'object' }) });
    expect(Buffer.from(requests[0].images[0], 'base64').subarray(1, 4).toString()).toBe('PNG');

    const tickets = db.getTickets(run.id);
    expect(tickets.length).toBeGreaterThan(0);
    for (const t of tickets) {
      expect(t).toMatchObject({ status: 'Needs review', engine: 'ollama', category: 'UX', ruleId: 'heuristic-4', severity: 'Medium' });
      expect(t.title).toMatch(/^AI-suggested: Buttons on this screen use three different styles/);
      expect(t.actual).toMatch(/Suggested fix: Use one primary/);
    }
    expect(allExported(buildExportPlan(db, run.id))).toEqual([]);

    // Approving one brings it into the export like any other ticket.
    updateTicket(db, run.id, tickets[0].ticketId, { approved: true });
    const approved = db.getTicket(run.id, tickets[0].ticketId)!;
    expect(approved.status).toBe('New');
    expect(allExported(buildExportPlan(db, run.id)).map((t) => t.ticketId)).toEqual([approved.ticketId]);
  }, 120_000);

  it('with it off, nothing changes: no requests to Ollama and no AI tickets', async () => {
    const before = requests.length;
    const { run } = await runAudit(db, { project: 'No AI', target: 'fixtures/bad-site', checks: ['axe'], delayMs: 0, dataDir, maxPages: 2 });
    expect(requests.length).toBe(before);
    expect(db.getTickets(run.id).some((t) => t.engine === 'ollama')).toBe(false);
    await expect(runAudit(db, { project: 'No AI', target: 'fixtures/bad-site', checks: ['ai'], delayMs: 0, dataDir, maxPages: 1 })).rejects.toThrow(/AI review is switched off/);
  }, 120_000);

  it('only talks to Ollama on this computer, and says clearly when it isn’t running', async () => {
    expect(() => assertLocalOllama('https://ollama.example.com')).toThrow(/only talks to Ollama on this computer/);
    expect(() => assertLocalOllama('http://192.168.1.20:11434')).toThrow(/only talks to Ollama on this computer/);
    expect(assertLocalOllama('http://localhost:11434').port).toBe('11434');
    const { run } = await runAudit(db, { project: 'Ollama down', target: 'fixtures/bad-site', checks: ['ai'], delayMs: 0, dataDir, maxPages: 1, ai: { url: 'http://127.0.0.1:9', model: 'x' } }).catch((error: Error) => ({ run: { status: 'threw', error: error.message } }));
    expect(run.status === 'failed' || run.status === 'threw').toBe(true);
    expect(run.error).toMatch(/Couldn’t reach Ollama at http:\/\/127\.0\.0\.1:9/);
  }, 120_000);
});
