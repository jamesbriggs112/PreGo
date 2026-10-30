import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { serveFolder, type StaticServer } from '../../serve/static-server.js';
import { BrowserSession } from '../../browser/session.js';
import type { Location } from '../../types.js';
import type { CheckFinding } from '../types.js';
import { axeModule, wcagFromTags } from './axe.js';

let site: StaticServer;
let session: BrowserSession;
const findingsByPage = new Map<string, CheckFinding[]>();
const PAGES = ['index.html', 'about.html', 'contact.html', 'news/post-1.html', 'news/post-2.html'];

beforeAll(async () => {
  site = await serveFolder('fixtures/bad-site', { substituteOrigin: true });
  session = await new BrowserSession().start();
  const axe = axeModule();
  for (const path of PAGES) {
    const opened = await session.newPage('desktop');
    await opened.page.goto(site.url + path);
    const location = { id: 1, url: site.url + path } as Location;
    findingsByPage.set(path, await axe.run({ page: opened.page, location, viewport: opened.viewport }));
    await opened.close();
  }
}, 60_000);

afterAll(async () => {
  await session?.close();
  await site?.close();
});

const rules = (path: string) => new Set(findingsByPage.get(path)!.map((f) => f.ruleId));

describe('axe module on bad-site', () => {
  it('finds missing alt text on the logo, hero and post photos', () => {
    const imageAlt = findingsByPage.get('index.html')!.filter((f) => f.ruleId === 'image-alt');
    expect(imageAlt.map((f) => f.selector).sort()).toEqual(expect.arrayContaining([expect.stringContaining('img')]));
    expect(imageAlt).toHaveLength(2); // logo + hero
    expect(rules('news/post-1.html')).toContain('image-alt');
  });

  it('finds insufficient colour contrast', () => {
    for (const path of ['index.html', 'about.html', 'news/post-1.html']) expect(rules(path)).toContain('color-contrast');
  });

  it('finds form fields without labels', () => {
    const contact = findingsByPage.get('contact.html')!;
    const unlabelled = contact.filter((f) => f.ruleId === 'label' || f.ruleId === 'select-name');
    // Name input, textarea and select. The placeholder-only email field passes axe (see fixtures/README.md).
    expect(unlabelled).toHaveLength(3);
  });

  it('finds the missing page language', () => {
    expect(rules('about.html')).toContain('html-has-lang');
    expect(rules('index.html')).not.toContain('html-has-lang');
  });

  it('finds skipped heading levels', () => {
    expect(rules('index.html')).toContain('heading-order');
    expect(rules('news/post-2.html')).toContain('heading-order');
  });

  it('returns findings in the common format with plain-English titles', () => {
    const finding = findingsByPage.get('about.html')!.find((f) => f.ruleId === 'html-has-lang')!;
    expect(finding).toMatchObject({
      module: 'axe',
      engine: 'axe-core',
      category: 'A11Y',
      severity: 'High',
      title: 'Page language is not set',
      wcagCriteria: ['3.1.1'],
      wcagLevel: 'A',
      selector: 'html',
    });
    expect(finding.helpUrl).toMatch(/^https:\/\/dequeuniversity\.com/);
  });
});

describe('wcagFromTags', () => {
  it('reads criteria and level', () => {
    expect(wcagFromTags(['cat.color', 'wcag2aa', 'wcag143'])).toEqual({ criteria: ['1.4.3'], level: 'AA' });
    expect(wcagFromTags(['wcag2a', 'wcag111', 'section508'])).toEqual({ criteria: ['1.1.1'], level: 'A' });
    expect(wcagFromTags(['wcag22aa', 'wcag258'])).toEqual({ criteria: ['2.5.8'], level: 'AA' });
    expect(wcagFromTags(['best-practice'])).toEqual({ criteria: [], level: null });
  });
});
