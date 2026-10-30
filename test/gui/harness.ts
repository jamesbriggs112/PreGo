// Starts the API and the Vite dev server in-process and opens a browser, for GUI tests.
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer, type ViteDevServer } from 'vite';
import { chromium, type Browser, type Page } from 'playwright';
import { AxeBuilder } from '@axe-core/playwright';
import { AXE_TAGS, PregoDb } from '@prego/core';
import { buildApp, type PregoApp } from '@prego/server';

export interface Gui {
  url: string;
  dataDir: string;
  db: PregoDb;
  prego: PregoApp;
  browser: Browser;
  page: Page;
  close(): Promise<void>;
}

export async function startGui(): Promise<Gui> {
  const dataDir = mkdtempSync(join(tmpdir(), 'prego-gui-'));
  const db = new PregoDb(join(dataDir, 'prego.sqlite'));
  const prego = await buildApp({ db, dataDir });
  const apiUrl = await prego.app.listen({ host: '127.0.0.1', port: 0 });

  process.env.PREGO_OPEN = '0';
  process.env.PREGO_PORT = new URL(apiUrl).port;
  const vite: ViteDevServer = await createServer({
    configFile: 'packages/web/vite.config.ts',
    root: 'packages/web',
    logLevel: 'error',
    server: { port: 0, strictPort: false, open: false },
  });
  await vite.listen();
  const url = vite.resolvedUrls!.local[0];

  const browser = await chromium.launch();
  // AxeBuilder needs a page from an explicit context.
  const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  const page = await context.newPage();
  return {
    url,
    dataDir,
    db,
    prego,
    browser,
    page,
    async close() {
      await browser.close();
      await vite.close();
      await prego.app.close();
      db.close();
      rmSync(dataDir, { recursive: true, force: true });
    },
  };
}

/** axe violations on the current page, as readable strings (empty means none found). */
export async function axeViolations(page: Page): Promise<string[]> {
  const results = await new AxeBuilder({ page }).withTags(AXE_TAGS).analyze();
  return results.violations.flatMap((v) => v.nodes.map((n) => `${v.id} (${v.impact}): ${n.target.join(' ')}`));
}
