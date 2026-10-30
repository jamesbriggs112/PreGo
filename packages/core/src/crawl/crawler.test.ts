import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { existsSync } from 'node:fs';
import { serveFolder, type StaticServer } from '../serve/static-server.js';
import { crawlSite } from './crawler.js';

let site: StaticServer;

beforeAll(async () => {
  site = await serveFolder('fixtures/bad-site', { substituteOrigin: true });
});
afterAll(() => site?.close());

const paths = (urls: string[]) => urls.map((url) => new URL(url).pathname).sort();
const FIVE_PAGES = ['/', '/about.html', '/contact.html', '/news/post-1.html', '/news/post-2.html'];

describe('crawlSite', () => {
  it('finds every page of bad-site, including the sitemap-only page', async () => {
    const result = await crawlSite({ startUrl: site.url, delayMs: 0 });
    expect(paths(result.pages.map((p) => p.url))).toEqual(FIVE_PAGES);
    expect(result.sitemapUrls).toHaveLength(5);

    const home = result.pages.find((p) => new URL(p.url).pathname === '/')!;
    expect(home.title).toBe('Acme Widgets');
    expect(paths(home.aliases)).toEqual(['/index.html']);
    expect(home.depth).toBe(0);

    // The broken link is reported with the page that links to it.
    expect(result.failed).toEqual([
      expect.objectContaining({ statusCode: 404, url: `${site.origin}/products/mark-iv.html` }),
    ]);
    expect(paths([result.failed[0].referrer!])).toEqual(expect.arrayContaining([expect.stringMatching(/^\/(index\.html)?$/)]));

    // robots.txt keeps the crawler out of /private/.
    expect(result.pages.some((p) => p.url.includes('/private/'))).toBe(false);
    expect(result.skipped).toContainEqual({ url: `${site.origin}/private/admin.html`, reason: 'robotsTxt' });
    // Crawlee storage stays in memory.
    expect(existsSync('storage')).toBe(false);
  }, 60_000);

  it('visits robots-disallowed pages when robots.txt is switched off', async () => {
    const result = await crawlSite({ startUrl: site.url, delayMs: 0, respectRobots: false, useSitemap: false });
    expect(result.pages.some((p) => p.url.endsWith('/private/admin.html'))).toBe(true);
    // Without the sitemap, the orphaned post is never found.
    expect(result.pages.some((p) => p.url.endsWith('/news/post-2.html'))).toBe(false);
  }, 60_000);

  it('applies include and exclude patterns', async () => {
    const result = await crawlSite({ startUrl: site.url, delayMs: 0, useSitemap: false, exclude: ['/news/**', '/contact.html'] });
    expect(paths(result.pages.map((p) => p.url))).toEqual(['/', '/about.html']);
  }, 60_000);

  it('respects the depth and page limits', async () => {
    const shallow = await crawlSite({ startUrl: site.url, delayMs: 0, useSitemap: false, maxDepth: 0 });
    expect(paths(shallow.pages.map((p) => p.url))).toEqual(['/']);

    const limited = await crawlSite({ startUrl: site.url, delayMs: 0, maxPages: 2 });
    expect(limited.pages.length).toBeLessThanOrEqual(2);
    expect(limited.stoppedEarly).toBe(true);
  }, 60_000);

  it('logs in to basic-auth sites', async () => {
    const locked = await serveFolder('fixtures/bad-site', { substituteOrigin: true, basicAuth: { username: 'four', password: 'pw' } });
    try {
      const result = await crawlSite({ startUrl: locked.url, delayMs: 0, basicAuth: { username: 'four', password: 'pw' } });
      expect(paths(result.pages.map((p) => p.url))).toEqual(FIVE_PAGES);
    } finally {
      await locked.close();
    }
  }, 60_000);
});
