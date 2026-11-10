import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import type { Page } from 'playwright';

// What a page's <head> tells search engines and link previews, for the results page's Previews tab,
// plus the files it links to (its icon and share image). Only files the page itself links to are
// fetched, the way a browser or a link preview would: nothing is guessed, such as /favicon.ico.

export interface HeadIcon {
  href: string;
  rel: string;
  sizes: string | null;
  type: string | null;
}

/** Stored on each location as `metrics.head`. */
export interface HeadMetrics {
  title: string;
  description: string | null;
  canonical: string | null;
  lang: string | null;
  robots: string | null;
  og: { title: string | null; description: string | null; image: string | null; imageAlt: string | null; siteName: string | null; type: string | null; url: string | null };
  twitter: { card: string | null; title: string | null; description: string | null; image: string | null };
  icons: HeadIcon[];
  /** Logos the page links: the organisation's logo in its structured data, then a logo image in the header. */
  logos: string[];
  /** The share image, saved in the run folder, when the page links one. */
  shareImage?: string | null;
}

/** Read the page's head. Links are made absolute. */
export function readHead(page: Page): Promise<HeadMetrics> {
  return page.evaluate(() => {
    const meta = (selector: string) => document.querySelector(selector)?.getAttribute('content')?.trim() || null;
    const absolute = (href: string | null | undefined) => {
      if (!href) return null;
      try {
        return new URL(href, document.baseURI).href;
      } catch {
        return null;
      }
    };
    const icons = [...document.querySelectorAll('link[rel]')]
      .filter((l) => /(^|\s)(icon|apple-touch-icon|apple-touch-icon-precomposed)(\s|$)/i.test(l.getAttribute('rel') ?? ''))
      .map((l) => ({ href: absolute(l.getAttribute('href')) ?? '', rel: (l.getAttribute('rel') ?? '').toLowerCase(), sizes: l.getAttribute('sizes'), type: l.getAttribute('type') }))
      .filter((i) => /^(https?:|data:image\/)/.test(i.href));
    return {
      title: document.title.trim(),
      description: meta('meta[name="description"]'),
      canonical: absolute(document.querySelector('link[rel="canonical"]')?.getAttribute('href')),
      lang: document.documentElement.getAttribute('lang'),
      robots: meta('meta[name="robots"]'),
      og: {
        title: meta('meta[property="og:title"]'),
        description: meta('meta[property="og:description"]'),
        image: absolute(meta('meta[property="og:image"]') ?? meta('meta[property="og:image:url"]')),
        imageAlt: meta('meta[property="og:image:alt"]'),
        siteName: meta('meta[property="og:site_name"]'),
        type: meta('meta[property="og:type"]'),
        url: absolute(meta('meta[property="og:url"]')),
      },
      twitter: {
        card: meta('meta[name="twitter:card"]'),
        title: meta('meta[name="twitter:title"]'),
        description: meta('meta[name="twitter:description"]'),
        image: absolute(meta('meta[name="twitter:image"]')),
      },
      icons,
      logos: [...structuredLogos(), ...headerLogos()].map((href) => absolute(href)).filter((href, i, all): href is string => !!href && /^https?:/.test(href) && all.indexOf(href) === i),
    };

    function structuredLogos(): string[] {
      const out: string[] = [];
      const visit = (node: unknown) => {
        if (!node || typeof node !== 'object') return;
        if (Array.isArray(node)) return node.forEach(visit);
        const record = node as Record<string, unknown>;
        const logo = record.logo;
        if (typeof logo === 'string') out.push(logo);
        else if (logo && typeof logo === 'object' && typeof (logo as Record<string, unknown>).url === 'string') out.push((logo as Record<string, string>).url);
        if (record['@graph']) visit(record['@graph']);
      };
      for (const script of document.querySelectorAll('script[type="application/ld+json"]')) {
        try {
          visit(JSON.parse(script.textContent ?? ''));
        } catch {
          // Unreadable structured data is the future readiness check's business.
        }
      }
      return out;
    }

    function headerLogos(): string[] {
      return [...document.querySelectorAll('header img, nav img, [class*="header" i] img, [id*="header" i] img')]
        .filter((img) => /logo/i.test([img.getAttribute('alt'), img.getAttribute('class'), img.getAttribute('id'), img.getAttribute('src'), img.closest('[class*="logo" i]') ? 'logo' : ''].join(' ')))
        .map((img) => (img as HTMLImageElement).currentSrc || img.getAttribute('src') || '')
        .slice(0, 2);
    }
  });
}

/** The icon best suited to a small square in a list: SVG, then a PNG of 32px or more, then the touch icon, then any. */
export function bestIcon(icons: HeadIcon[]): HeadIcon | null {
  const size = (i: HeadIcon) => Math.max(0, ...(i.sizes ?? '').split(/\s+/).map((s) => Number(s.split('x')[0]) || 0));
  const score = (i: HeadIcon) => {
    if (/svg/.test(i.type ?? '') || /\.svg(\?|$)/i.test(i.href)) return 400;
    if (i.rel.includes('apple-touch-icon')) return 200;
    const px = size(i);
    if (px >= 32) return 300 + Math.min(px, 99);
    return 100 + px;
  };
  return [...icons].sort((a, b) => score(b) - score(a))[0] ?? null;
}

const IMAGE_TYPES: Record<string, string> = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/gif': 'gif',
  'image/webp': 'webp',
  'image/svg+xml': 'svg',
  'image/x-icon': 'ico',
  'image/vnd.microsoft.icon': 'ico',
  'image/avif': 'avif',
};

/** Fetch a file the page links to, with the page's own session. Null unless it's an image within the size limit. */
export async function fetchLinkedImage(page: Page, url: string, maxBytes: number): Promise<{ body: Buffer; type: string; ext: string } | null> {
  if (url.startsWith('data:')) {
    const match = /^data:(image\/[\w.+-]+)(;base64)?,(.*)$/s.exec(url);
    if (!match || !IMAGE_TYPES[match[1]]) return null;
    const body = match[2] ? Buffer.from(match[3], 'base64') : Buffer.from(decodeURIComponent(match[3]));
    return body.length <= maxBytes ? { body, type: match[1], ext: IMAGE_TYPES[match[1]] } : null;
  }
  try {
    const response = await page.request.get(url, { timeout: 15_000, maxRedirects: 3 });
    if (!response.ok()) return null;
    const type = (response.headers()['content-type'] ?? '').split(';')[0].trim().toLowerCase();
    const ext = IMAGE_TYPES[type];
    if (!ext) return null;
    const length = Number(response.headers()['content-length'] ?? 0);
    if (length > maxBytes) return null;
    const body = await response.body();
    return body.length <= maxBytes ? { body, type, ext } : null;
  } catch {
    return null;
  }
}

/** What a project's picture is: the site's icon, its logo, or its share image, best first. */
export type SiteImageKind = 'icon' | 'logo' | 'share-image';
export const SITE_IMAGE_RANK: Record<SiteImageKind, number> = { icon: 3, logo: 2, 'share-image': 1 };

/** The pictures this page links that could stand for the site, best first. */
export function siteImageCandidates(head: HeadMetrics): { kind: SiteImageKind; href: string }[] {
  const icon = bestIcon(head.icons);
  const share = head.og.image ?? head.twitter.image;
  return [...(icon ? [{ kind: 'icon' as const, href: icon.href }] : []), ...head.logos.map((href) => ({ kind: 'logo' as const, href })), ...(share ? [{ kind: 'share-image' as const, href: share }] : [])];
}

/** Save a picture the page links into `path` (no extension). Returns the saved file's name, or null. */
export async function saveSiteImage(page: Page, href: string, path: string): Promise<string | null> {
  const file = await fetchLinkedImage(page, href, 2 * 1024 * 1024);
  if (!file) return null;
  const full = `${path}.${file.ext}`;
  mkdirSync(dirname(full), { recursive: true });
  writeFileSync(full, file.body);
  return full;
}

/** Save the page's share image into the run folder. Returns its path, or null. */
export async function saveShareImage(page: Page, url: string, path: (ext: string) => { relative: string; full: string }): Promise<string | null> {
  const file = await fetchLinkedImage(page, url, 5 * 1024 * 1024);
  if (!file || file.ext === 'svg') return null;
  const { relative, full } = path(file.ext);
  mkdirSync(dirname(full), { recursive: true });
  writeFileSync(full, file.body);
  return relative;
}
