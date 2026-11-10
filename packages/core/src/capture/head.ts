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
    };
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

/** The site's icon as a data URL, small enough to keep with the project. */
export async function iconDataUrl(page: Page, icons: HeadIcon[]): Promise<{ dataUrl: string; from: string } | null> {
  const icon = bestIcon(icons);
  if (!icon) return null;
  const file = await fetchLinkedImage(page, icon.href, 64 * 1024);
  return file ? { dataUrl: `data:${file.type};base64,${file.body.toString('base64')}`, from: icon.href } : null;
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
