import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { serveFolder, type StaticServer } from '../serve/static-server.js';
import { crawlSite, type CrawledPage } from './crawler.js';
import { extractStructure, groupTemplates, samplePages, similarity, templateKey, type TemplatePage } from './templates.js';

let site: StaticServer;
let pages: (CrawledPage & TemplatePage)[];

beforeAll(async () => {
  site = await serveFolder('fixtures/bad-site', { substituteOrigin: true });
  const result = await crawlSite({
    startUrl: site.url,
    delayMs: 0,
    inspectPage: async ({ page }) => ({ structure: await extractStructure(page) }),
  });
  pages = result.pages.map((p) => ({ ...p, structure: p.data.structure as string[] }));
}, 60_000);
afterAll(() => site?.close());

const path = (url: string) => new URL(url).pathname;

describe('template grouping', () => {
  it('groups the two news posts into one template and keeps other pages apart', () => {
    const groups = groupTemplates(pages);
    expect(groups.map((g) => [g.key, g.pages.map((p) => path(p.url))])).toEqual([
      ['/', ['/']],
      ['/about.html', ['/about.html']],
      ['/contact.html', ['/contact.html']],
      ['/news/*', ['/news/post-1.html', '/news/post-2.html']],
    ]);
  });

  it('groups the same way on every run', () => {
    const shuffled = [...pages].reverse();
    expect(groupTemplates(shuffled)).toEqual(groupTemplates(pages));
  });

  it('respects the per-template sampling limit, or audits everything', () => {
    const groups = groupTemplates(pages);
    const sampled = samplePages(groups, { perTemplate: 1 });
    const skipped = sampled.filter((s) => !s.audit);
    expect(skipped.map((s) => path(s.page.url))).toEqual(['/news/post-2.html']);
    expect(skipped[0].reason).toMatch(/Same template as .*post-1\.html \(\/news\/\*\); not audited/);
    expect(samplePages(groups).every((s) => s.audit)).toBe(true);
    expect(samplePages(groups, { perTemplate: 1, auditAll: true }).every((s) => s.audit)).toBe(true);
  });
});

describe('helpers', () => {
  it('measures structural similarity', () => {
    expect(similarity(['a', 'b'], ['a', 'b'])).toBe(1);
    expect(similarity(['a', 'b'], ['c'])).toBe(0);
    expect(similarity(['a', 'b', 'c'], ['a', 'b', 'd'])).toBe(0.5);
  });

  it('builds readable template keys', () => {
    expect(templateKey(['https://x.org/about'])).toBe('/about');
    expect(templateKey(['https://x.org/news/a', 'https://x.org/news/b'])).toBe('/news/*');
    expect(templateKey(['https://x.org/shop/a', 'https://x.org/shop/b/c'])).toBe('/shop/**');
    expect(templateKey(['https://x.org/', 'https://x.org/'])).toBe('/');
  });
});
