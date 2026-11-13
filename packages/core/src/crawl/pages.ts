// Telling apart addresses that are really the same page, and the kinds of page a crawl finds. Used
// after crawling, before pages are grouped into templates, and when rebuilding a saved run.

export type PageType = 'content' | 'pagination' | 'taxonomy' | 'search';

/**
 * One key per page, however its address is written: http and https, `www.` or not, a trailing
 * slash, `?page=0` (the first page of a list), `/index.php/…` and its encoded form `/index%2Ephp/…`,
 * and query parameters in any order are all the same page.
 */
export function pageKey(url: string): string {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return url;
  }
  const host = u.hostname.toLowerCase().replace(/^www\./, '');
  let path = u.pathname.replace(/%2e/gi, '.').replace(/^\/index\.php(?=\/|$)/i, '') || '/';
  path = path.replace(/\/index\.(html?|php)$/i, '/').replace(/(.)\/+$/, '$1');
  const params = [...u.searchParams.entries()].filter(([k, v]) => !(k === 'page' && v === '0')).sort(([a], [b]) => a.localeCompare(b));
  const query = params.length ? `?${new URLSearchParams(params).toString()}` : '';
  return `${host}${path}${query}`;
}

/** What kind of page an address is: a later page of a list, a tag or category listing, search results, or content. */
export function pageType(url: string): PageType {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return 'content';
  }
  const page = Number(u.searchParams.get('page') ?? u.searchParams.get('paged') ?? /\/page\/(\d+)\/?$/.exec(u.pathname)?.[1] ?? 0);
  if (page >= 1) return 'pagination';
  if (/\/(search)(\/|$)/i.test(u.pathname) || u.searchParams.has('s') || u.searchParams.has('q') || u.searchParams.has('search')) return 'search';
  if (/\/(taxonomy\/term|tag|tags|category|categories)\//i.test(u.pathname)) return 'taxonomy';
  return 'content';
}

/**
 * For pages in crawl order (most important first), which earlier page each one duplicates: the same
 * page key, or a canonical address naming another crawled page. Returns index → index of the page
 * kept; pages that aren't duplicates aren't in the map.
 */
export function duplicatePages(pages: { url: string; canonical?: string | null }[]): Map<number, number> {
  const byKey = new Map<string, number>();
  const duplicates = new Map<number, number>();
  pages.forEach((p, i) => {
    const key = pageKey(p.url);
    const kept = byKey.get(key);
    if (kept !== undefined) duplicates.set(i, kept);
    else byKey.set(key, i);
  });
  // A canonical address that names another page we have: this one is a copy of it (/node/123 → its alias).
  const byCanonical = new Map<number, number[]>();
  pages.forEach((p, i) => {
    if (duplicates.has(i) || !p.canonical || pageKey(p.canonical) === pageKey(p.url)) return;
    const target = byKey.get(pageKey(p.canonical));
    if (target !== undefined && target !== i && !duplicates.has(target)) byCanonical.set(target, [...(byCanonical.get(target) ?? []), i]);
  });
  for (const [target, copies] of byCanonical) {
    // Many pages naming one page (often every page naming the home page) is a mistake in the site, not copies.
    if (copies.length > 3 && copies.length > pages.length * 0.2) continue;
    for (const i of copies) duplicates.set(i, target);
  }
  return duplicates;
}
