import { describe, expect, it } from 'vitest';
import { duplicatePages, pageKey, pageType } from './pages.js';

describe('the same page at several addresses', () => {
  it('gives one key however the address is written', () => {
    const same = [
      'https://www.example.org/news',
      'http://example.org/news/',
      'https://www.example.org/news?page=0',
      'https://www.example.org/index%2Ephp/news',
      'https://www.example.org/index.php/news',
    ];
    expect(new Set(same.map(pageKey)).size).toBe(1);
    expect(pageKey('https://example.org/news?page=1')).not.toBe(pageKey('https://example.org/news'));
    expect(pageKey('https://example.org/?b=2&a=1')).toBe(pageKey('https://example.org/?a=1&b=2'));
  });

  it('tells later pages of lists, tags and searches from content', () => {
    expect(pageType('https://example.org/latest/news?page=2')).toBe('pagination');
    expect(pageType('https://example.org/blog/page/3/')).toBe('pagination');
    expect(pageType('https://example.org/latest/news?page=0')).toBe('content');
    expect(pageType('https://example.org/taxonomy/term/12')).toBe('taxonomy');
    expect(pageType('https://example.org/search?q=gloves')).toBe('search');
    expect(pageType('https://example.org/services/quality')).toBe('content');
  });

  it('merges copies by address and by canonical, but not when the site points everything at one page', () => {
    const pages = [
      { url: 'https://example.org/' },
      { url: 'https://example.org/forensics', canonical: 'https://example.org/forensics' },
      { url: 'https://example.org/node/1385', canonical: 'https://example.org/forensics' },
      { url: 'https://example.org/index%2Ephp/forensics' },
    ];
    expect([...duplicatePages(pages)]).toEqual([
      [3, 1],
      [2, 1],
    ]);
    const careless = Array.from({ length: 10 }, (_, i) => ({ url: `https://example.org/p${i}`, canonical: 'https://example.org/' }));
    expect(duplicatePages([{ url: 'https://example.org/' }, ...careless]).size).toBe(0);
  });
});
