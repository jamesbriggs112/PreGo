import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { serveFolder, type StaticServer } from '../serve/static-server.js';
import { BrowserSession, sessionPath } from './session.js';
import { PROFILES, viewportName, type ProfileName } from './profiles.js';

let site: StaticServer;
let kiosk: StaticServer;
let session: BrowserSession;
const outDir = mkdtempSync(join(tmpdir(), 'prego-browser-'));

beforeAll(async () => {
  site = await serveFolder('fixtures/bad-site', { substituteOrigin: true });
  kiosk = await serveFolder('fixtures/kiosk-app');
  session = await new BrowserSession().start();
});

afterAll(async () => {
  await session?.close();
  await site?.close();
  await kiosk?.close();
  rmSync(outDir, { recursive: true, force: true });
});

describe('BrowserSession', () => {
  it.each(Object.keys(PROFILES) as ProfileName[])('opens both fixtures at the %s profile and saves screenshots', async (name) => {
    const profile = PROFILES[name];
    for (const [fixture, server] of [['bad-site', site], ['kiosk-app', kiosk]] as const) {
      const opened = await session.newPage(name);
      await opened.page.goto(server.url);
      const size = await opened.page.evaluate(() => ({
        // screen, not innerWidth: on mobile profiles the layout width follows the page's meta viewport.
        width: screen.width,
        height: screen.height,
        touch: navigator.maxTouchPoints > 0,
      }));
      expect(size).toEqual({ width: profile.width, height: profile.height, touch: profile.touch });
      const path = join(outDir, `${fixture}-${name}.png`);
      await opened.page.screenshot({ path, fullPage: true });
      expect(readFileSync(path).subarray(1, 4).toString()).toBe('PNG');
      await opened.close();
    }
  });

  it('applies emulation toggles', async () => {
    const emulation = { reducedMotion: true, forcedColors: true, darkMode: true, zoom200: true };
    const opened = await session.newPage('desktop', emulation);
    await opened.page.goto(site.url);
    const media = await opened.page.evaluate(() => ({
      reducedMotion: matchMedia('(prefers-reduced-motion: reduce)').matches,
      forcedColors: matchMedia('(forced-colors: active)').matches,
      dark: matchMedia('(prefers-color-scheme: dark)').matches,
      width: window.innerWidth,
      dpr: window.devicePixelRatio,
    }));
    expect(media).toEqual({ reducedMotion: true, forcedColors: true, dark: true, width: 720, dpr: 2 });
    expect(opened.viewport).toBe('desktop+reduced-motion+forced-colors+dark+zoom200');
    expect(viewportName('mobile')).toBe('mobile');
    await opened.close();
  });

  it('sends basic auth credentials to the target origin', async () => {
    const locked = await serveFolder('fixtures/bad-site', { basicAuth: { username: 'four', password: 's3cret' } });
    try {
      const anonymous = await session.newPage('desktop');
      expect((await anonymous.page.goto(locked.url))?.status()).toBe(401);
      await anonymous.close();

      const authed = new BrowserSession({ basicAuth: { username: 'four', password: 's3cret' }, authOrigin: locked.origin });
      const opened = await authed.newPage('desktop');
      expect((await opened.page.goto(locked.url))?.status()).toBe(200);
      await authed.close();
    } finally {
      await locked.close();
    }
  });

  it('saves a browser session and loads it into later contexts', async () => {
    const path = sessionPath(outDir, 'acme');
    const first = await session.newPage('desktop');
    await first.page.goto(site.url);
    await first.page.evaluate(() => {
      document.cookie = 'prego_test=logged-in; path=/';
    });
    await BrowserSession.saveSession(first.context, path);
    await first.close();
    expect(existsSync(path)).toBe(true);

    const restored = new BrowserSession({ storageStatePath: path });
    const second = await restored.newPage('desktop');
    await second.page.goto(site.url);
    expect(await second.page.evaluate(() => document.cookie)).toContain('prego_test=logged-in');
    await restored.close();
  });
});

describe('BrowserSession concurrency', () => {
  it('launches one browser when pages are opened concurrently', async () => {
    const fresh = new BrowserSession();
    const pages = await Promise.all([fresh.newPage('desktop'), fresh.newPage('mobile'), fresh.newPage('tablet')]);
    const browsers = new Set(pages.map((p) => p.context.browser()));
    expect(browsers.size).toBe(1);
    await fresh.close();
    expect([...browsers][0]!.isConnected()).toBe(false);
  });
});
