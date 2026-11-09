import { mkdirSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import type { Severity } from '../../types.js';
import type { CheckFinding, CheckModule } from '../types.js';
import { guidanceFor } from '../guidance.js';

// Search and sharing: how each page appears in search results and when its link is shared on
// LinkedIn, Facebook, X, WhatsApp, Slack and the like. It reads the page's own tags, and loads the
// share image the page names, as a link preview would. Missing Open Graph tags and title and
// description lengths are the Content and SEO check's; this adds what's left.

const RULES: Record<string, Severity> = {
  'share-image-broken': 'Medium',
  'share-image-small': 'Low',
  'share-image-relative': 'Low',
  'canonical-missing': 'Low',
  'twitter-card-missing': 'Low',
  'touch-icon-missing': 'Low',
};

/** Recommended share image size: 1200 × 630 shows large on every platform. Below 600 × 315 most show a small thumbnail. */
export const SHARE_IMAGE = { recommended: { width: 1200, height: 630 }, minimum: { width: 600, height: 315 } };

const MAX_IMAGE_BYTES = 5 * 1024 * 1024;
const MAX_SAVED_IMAGES = 12;

/** What the search and sharing check records on each page, for the report's previews. */
export interface SharingMetrics {
  title: string;
  description: string | null;
  canonical: string | null;
  og: { title: string | null; description: string | null; image: string | null; url: string | null; type: string | null; siteName: string | null };
  twitter: { card: string | null; title: string | null; description: string | null; image: string | null };
  hreflang: number;
  icons: { icon: boolean; touch: boolean };
  /** The share image (Open Graph, or X's if there's no Open Graph image), once loaded. */
  image: { url: string; ok: boolean; width: number | null; height: number | null; bytes: number; type: string | null; file: string | null } | null;
}

/** Width and height from a PNG, JPEG, GIF or WebP file's header, or null. Exported for tests. */
export function imageSize(data: Buffer): { width: number; height: number; type: string } | null {
  if (data.length >= 24 && data.toString('ascii', 1, 4) === 'PNG') return { width: data.readUInt32BE(16), height: data.readUInt32BE(20), type: 'png' };
  if (data.length >= 10 && data.toString('ascii', 0, 3) === 'GIF') return { width: data.readUInt16LE(6), height: data.readUInt16LE(8), type: 'gif' };
  if (data.length >= 30 && data.toString('ascii', 0, 4) === 'RIFF' && data.toString('ascii', 8, 12) === 'WEBP') {
    const chunk = data.toString('ascii', 12, 16);
    if (chunk === 'VP8X') return { width: 1 + data.readUIntLE(24, 3), height: 1 + data.readUIntLE(27, 3), type: 'webp' };
    if (chunk === 'VP8 ') return { width: data.readUInt16LE(26) & 0x3fff, height: data.readUInt16LE(28) & 0x3fff, type: 'webp' };
    if (chunk === 'VP8L') {
      const bits = data.readUInt32LE(21);
      return { width: 1 + (bits & 0x3fff), height: 1 + ((bits >> 14) & 0x3fff), type: 'webp' };
    }
  }
  if (data.length >= 4 && data[0] === 0xff && data[1] === 0xd8) {
    let i = 2;
    while (i + 9 < data.length) {
      if (data[i] !== 0xff) return null;
      const marker = data[i + 1];
      const length = data.readUInt16BE(i + 2);
      // Start-of-frame markers carry the size; skip DHT (C4), JPG (C8) and DAC (CC).
      if (marker >= 0xc0 && marker <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(marker)) return { width: data.readUInt16BE(i + 7), height: data.readUInt16BE(i + 5), type: 'jpeg' };
      i += 2 + length;
    }
  }
  return null;
}

/** Share images are kept in `{runDir}/sharing/` for the report's previews, and deleted with the screenshots on export. */
export function sharingModule(runDir?: string): CheckModule {
  const images = new Map<string, NonNullable<SharingMetrics['image']>>();
  let touchIcon = false;
  let firstPage: { locationId: number; viewport: string } | undefined;
  return {
    id: 'sharing',
    name: 'Search and sharing',
    perViewport: false,
    async run({ page, location, viewport, recordMetrics }) {
      const url = page.url();
      if (!/^https?:/.test(url) || (location.kind === 'state' && location.depth > 0)) return [];
      const tags = await page.evaluate(() => {
        const meta = (key: string) => document.querySelector(`meta[property="${key}" i], meta[name="${key}" i]`)?.getAttribute('content')?.trim() || null;
        return {
          title: document.title.trim(),
          description: meta('description'),
          canonical: document.querySelector('link[rel="canonical" i]')?.getAttribute('href') ?? null,
          og: { title: meta('og:title'), description: meta('og:description'), image: meta('og:image'), url: meta('og:url'), type: meta('og:type'), siteName: meta('og:site_name') },
          twitter: { card: meta('twitter:card'), title: meta('twitter:title'), description: meta('twitter:description'), image: meta('twitter:image') },
          hreflang: document.querySelectorAll('link[rel="alternate" i][hreflang]').length,
          icons: { icon: !!document.querySelector('link[rel~="icon" i]'), touch: !!document.querySelector('link[rel~="apple-touch-icon" i], link[rel~="apple-touch-icon-precomposed" i]') },
        };
      });
      const out: CheckFinding[] = [];
      const imageRef = tags.og.image ?? tags.twitter.image;
      let image: SharingMetrics['image'] = null;
      if (imageRef) {
        if (!/^https?:\/\//i.test(imageRef)) out.push(finding('share-image-relative', `The share image is given as “${imageRef}”. Some platforms only accept a full address starting https://.`));
        let absolute: string | null = null;
        try {
          absolute = new URL(imageRef, url).href;
        } catch {
          absolute = null;
        }
        if (absolute) {
          image = images.get(absolute) ?? (await loadImage(page.context().request, absolute, images.size < MAX_SAVED_IMAGES ? runDir : undefined));
          images.set(absolute, image);
          if (!image.ok) out.push(finding('share-image-broken', `The share image ${absolute} didn’t load, so shared links show no picture.`, `sharing:image:${absolute}`));
          else if (image.width !== null && image.height !== null && (image.width < SHARE_IMAGE.minimum.width || image.height < SHARE_IMAGE.minimum.height)) {
            out.push(
              finding(
                'share-image-small',
                `The share image is ${image.width} × ${image.height} pixels. Below ${SHARE_IMAGE.minimum.width} × ${SHARE_IMAGE.minimum.height} most platforms show a small thumbnail; ${SHARE_IMAGE.recommended.width} × ${SHARE_IMAGE.recommended.height} shows large everywhere.`,
                `sharing:image:${absolute}`,
              ),
            );
          }
        }
      }
      if (!tags.canonical) out.push(finding('canonical-missing', 'The page has no canonical link, so search engines guess which address is the main one when it can be reached more than one way.'));
      if (tags.og.title && !tags.twitter.card) out.push(finding('twitter-card-missing', 'There’s no twitter:card tag, so X shows links to this page as a small summary rather than a large image card.'));
      if (tags.icons.touch) touchIcon = true;
      firstPage ??= { locationId: location.id, viewport };
      recordMetrics?.({ sharing: { ...tags, image } satisfies SharingMetrics });
      return out;
    },
    async finish() {
      if (touchIcon || !firstPage) return [];
      return [{ ...finding('touch-icon-missing', 'No page audited has an apple-touch-icon, so phones show a screenshot or a letter when the site is saved to a home screen, and some apps show no icon next to shared links.'), ...firstPage }];
    },
  };
}

async function loadImage(request: import('playwright').APIRequestContext, url: string, saveIn: string | undefined): Promise<NonNullable<SharingMetrics['image']>> {
  const res = await request.get(url, { failOnStatusCode: false, maxRedirects: 5, timeout: 15_000 }).catch(() => null);
  if (!res?.ok()) return { url, ok: false, width: null, height: null, bytes: 0, type: null, file: null };
  const body = await res.body().catch(() => Buffer.alloc(0));
  const size = body.length <= MAX_IMAGE_BYTES ? imageSize(body) : null;
  let file: string | null = null;
  if (saveIn && size && size.type !== 'gif') {
    file = join('sharing', `${createHash('sha1').update(url).digest('hex').slice(0, 12)}.${size.type === 'jpeg' ? 'jpg' : size.type}`);
    mkdirSync(join(saveIn, 'sharing'), { recursive: true });
    writeFileSync(join(saveIn, file), body);
  }
  return { url, ok: body.length > 0, width: size?.width ?? null, height: size?.height ?? null, bytes: body.length, type: size?.type ?? null, file };
}

function finding(ruleId: string, failureSummary: string, component?: string): CheckFinding {
  const guidance = guidanceFor('prego', ruleId)!;
  return {
    module: 'sharing',
    engine: 'prego',
    ruleId,
    category: 'CONT',
    severity: RULES[ruleId],
    title: guidance.title,
    description: guidance.description,
    helpUrl: null,
    wcagCriteria: [],
    wcagLevel: null,
    selector: 'head',
    html: '<head>',
    failureSummary,
    // Tags come from the template or CMS, so each is one ticket for the site, listing the pages.
    siteWide: true,
    component: component ?? `sharing:${ruleId}`,
  };
}
