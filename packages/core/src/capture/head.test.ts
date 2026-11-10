import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PregoDb } from '../db/database.js';
import { runAudit } from '../audit/run-audit.js';
import { bestIcon, siteImageCandidates, type HeadIcon, type HeadMetrics } from './head.js';

const icon = (href: string, rel = 'icon', sizes: string | null = null, type: string | null = null): HeadIcon => ({ href, rel, sizes, type });

describe('choosing the site icon', () => {
  it('prefers SVG, then a PNG of 32px or more, then the touch icon, then anything', () => {
    const small = icon('https://x.test/16.png', 'icon', '16x16');
    const big = icon('https://x.test/32.png', 'icon', '32x32');
    const touch = icon('https://x.test/touch.png', 'apple-touch-icon');
    const svg = icon('https://x.test/icon.svg', 'icon', null, 'image/svg+xml');
    expect(bestIcon([small, big, touch, svg])).toBe(svg);
    expect(bestIcon([small, big, touch])).toBe(big);
    expect(bestIcon([small, touch])).toBe(touch);
    expect(bestIcon([small])).toBe(small);
    expect(bestIcon([])).toBeNull();
  });
});

describe('the project picture', () => {
  const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=', 'base64');
  let server: Server;
  let origin: string;
  const requested: string[] = [];
  const dataDir = mkdtempSync(join(tmpdir(), 'prego-head-'));
  const db = new PregoDb(':memory:');
  const page = (body: string) => `<!doctype html><html lang="en"><head><title>Riverside</title>${body}</head><body><header><a href="/"><img src="/img/site-logo.png" alt="Riverside logo"></a></header><main><h1>Hi</h1><a href="/two">Two</a></main></body></html>`;

  beforeAll(async () => {
    server = createServer((req, res) => {
      requested.push(req.url ?? '');
      if (req.url?.startsWith('/img/')) return res.writeHead(200, { 'Content-Type': 'image/png' }).end(png);
      if (req.url === '/robots.txt' || req.url === '/sitemap.xml') return res.writeHead(404).end();
      res.writeHead(200, { 'Content-Type': 'text/html' }).end(page(`<meta property="og:image" content="${origin}/img/share.png">`));
    });
    await new Promise<void>((done) => server.listen(0, '127.0.0.1', done));
    origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });
  afterAll(async () => {
    db.close();
    await new Promise((done) => server.close(done));
    rmSync(dataDir, { recursive: true, force: true });
  });

  it('uses the logo when no icon is linked, and never asks for /favicon.ico', async () => {
    const { run } = await runAudit(db, { project: 'Riverside', target: origin, checks: ['content'], delayMs: 0, dataDir, maxPages: 2 });
    const icon = db.getProject(run.projectId)!.settings.icon!;
    expect(icon).toMatchObject({ kind: 'logo', from: `${origin}/img/site-logo.png` });
    expect(existsSync(join(dataDir, 'icons', icon.file))).toBe(true);
    expect(requested).not.toContain('/favicon.ico');
    expect(db.getLocations(run.id)[0].metrics.head).toMatchObject({ og: { image: `${origin}/img/share.png` }, logos: [`${origin}/img/site-logo.png`] });
  }, 120_000);

  it('orders icon, then logo, then share image', () => {
    const head = { icons: [icon('https://x.test/i.png')], logos: ['https://x.test/logo.png'], og: { image: 'https://x.test/share.png' }, twitter: { image: null } } as unknown as HeadMetrics;
    expect(siteImageCandidates(head).map((c) => c.kind)).toEqual(['icon', 'logo', 'share-image']);
    expect(siteImageCandidates({ ...head, icons: [], logos: [] }).map((c) => c.kind)).toEqual(['share-image']);
  });
});
