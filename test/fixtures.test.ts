import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { chromium, type Browser } from 'playwright';
import { serveFolder, type StaticServer } from '@prego/core';

let browser: Browser;
let badSite: StaticServer;
let kiosk: StaticServer;

beforeAll(async () => {
  browser = await chromium.launch();
  badSite = await serveFolder('fixtures/bad-site', { substituteOrigin: true });
  kiosk = await serveFolder('fixtures/kiosk-app');
});

afterAll(async () => {
  await browser?.close();
  await badSite?.close();
  await kiosk?.close();
});

describe('bad-site fixture', () => {
  const pages = ['index.html', 'about.html', 'contact.html', 'news/post-1.html', 'news/post-2.html'];

  it.each(pages)('opens %s', async (path) => {
    const page = await browser.newPage();
    const response = await page.goto(badSite.url + path);
    expect(response?.status()).toBe(200);
    await expect(page.locator('h1').count()).resolves.toBe(1);
    await page.close();
  });

  it('serves a sitemap with absolute URLs and a robots.txt', async () => {
    const sitemap = await (await fetch(badSite.url + 'sitemap.xml')).text();
    expect(sitemap).toContain(`<loc>${badSite.origin}/news/post-2.html</loc>`);
    const robots = await (await fetch(badSite.url + 'robots.txt')).text();
    expect(robots).toContain('Disallow: /private/');
  });

  it('returns 404 for the deliberately broken link', async () => {
    expect((await fetch(badSite.url + 'products/mark-iv.html')).status).toBe(404);
  });
});

describe('kiosk-app fixture', () => {
  it('moves between screens without changing the URL', async () => {
    const page = await browser.newPage({ viewport: { width: 1920, height: 1080 }, hasTouch: true });
    await page.goto(kiosk.url);
    const startUrl = page.url();
    await page.getByRole('button', { name: /touch anywhere/i }).click();
    await page.getByRole('button', { name: 'Explore the galleries' }).click();
    await page.getByRole('button', { name: 'Ancient world' }).click();
    await page.getByRole('button', { name: 'Egypt' }).click();
    await expect(page.locator('h1').textContent()).resolves.toBe('Egypt');
    await page.getByRole('button', { name: 'Home' }).click();
    await expect(page.locator('h1').textContent()).resolves.toBe('Gallery Guide');
    expect(page.url()).toBe(startUrl);
    await page.close();
  });

  it('has a dead-end screen and a button that does nothing', async () => {
    const page = await browser.newPage({ viewport: { width: 1920, height: 1080 } });
    await page.goto(kiosk.url);
    await page.getByRole('button', { name: /touch anywhere/i }).click();
    await page.getByRole('button', { name: 'Plan your visit' }).click();
    await page.getByRole('button', { name: 'Opening times' }).click();
    await expect(page.getByRole('button').count()).resolves.toBe(0);

    await page.goto(kiosk.url);
    await page.getByRole('button', { name: /touch anywhere/i }).click();
    await page.getByRole('button', { name: 'Our collection' }).click();
    await page.getByRole('button', { name: 'Paintings' }).click();
    const before = await page.locator('#app').innerHTML();
    await page.getByRole('button', { name: 'Zoom in' }).click();
    expect(await page.locator('#app').innerHTML()).toBe(before);
    await page.close();
  });

  it('returns to the attract screen after 60 seconds idle', async () => {
    const page = await browser.newPage();
    await page.clock.install();
    await page.goto(kiosk.url);
    await page.getByRole('button', { name: /touch anywhere/i }).click();
    await expect(page.locator('h1').textContent()).resolves.toBe('Gallery Guide');
    await page.clock.runFor(61_000);
    await expect(page.locator('h1').textContent()).resolves.toBe('Museum of Making');
    await page.close();
  });
});
