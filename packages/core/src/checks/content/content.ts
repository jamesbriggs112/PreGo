import type { Severity } from '../../types.js';
import type { CheckFinding, CheckModule } from '../types.js';
import { guidanceFor } from '../guidance.js';

// Content and SEO basics read straight from the page: titles, meta descriptions, Open Graph tags and
// whether image alt text actually describes anything. (Missing alt and missing titles are axe's job.)

const RULES: Record<string, Severity> = {
  'meta-description-missing': 'Medium',
  'meta-description-length': 'Low',
  'title-length': 'Low',
  'open-graph-missing': 'Low',
  'alt-text-unhelpful': 'Medium',
};

/** Alt text that names a file or just says "image", rather than describing it. */
export function unhelpfulAlt(alt: string): string | null {
  const text = alt.trim();
  if (!text) return null; // Empty alt marks a decorative image, which is fine.
  if (/\.(jpe?g|png|gif|svg|webp|avif|bmp|tiff?)$/i.test(text)) return 'it is a file name';
  if (/^(img|image|dsc|dscn|pxl|photo)[-_ ]?\d+$/i.test(text) || /^\d+$/.test(text)) return 'it looks like a camera or file reference';
  if (/^(image|picture|photo|photograph|graphic|icon|logo|img|banner|placeholder)( of)?$/i.test(text)) return 'it only says what kind of thing it is';
  return null;
}

export function contentModule(): CheckModule {
  return {
    id: 'content',
    name: 'Content and SEO',
    perViewport: false,
    async run({ page, location }) {
      // Explored screens share one document head; only check it on the start screen.
      if (location.kind === 'state' && location.depth > 0) return [];
      const data = await page.evaluate(() => {
        const meta = (selector: string) => document.querySelector(selector)?.getAttribute('content')?.trim() ?? null;
        const path = (el: Element): string => {
          if (el.id) return `#${CSS.escape(el.id)}`;
          const src = el.getAttribute('src');
          if (src && document.querySelectorAll(`img[src="${CSS.escape(src)}"]`).length === 1) return `img[src="${CSS.escape(src)}"]`;
          const imgs = [...document.querySelectorAll('img')];
          return `img:nth-of-type(${imgs.indexOf(el as HTMLImageElement) + 1})`;
        };
        return {
          title: document.title.trim(),
          description: meta('meta[name="description"]'),
          ogTitle: meta('meta[property="og:title"]'),
          ogDescription: meta('meta[property="og:description"]'),
          ogImage: meta('meta[property="og:image"]'),
          images: [...document.querySelectorAll('img[alt]')].map((img) => ({ alt: img.getAttribute('alt') ?? '', selector: path(img), html: img.outerHTML.slice(0, 200) })),
        };
      });

      const out: CheckFinding[] = [];
      if (!data.description) {
        out.push(finding('meta-description-missing', 'head', '<head>', 'The page has no meta description, so search engines and link previews make one up from the page text.'));
      } else if (data.description.length < 50 || data.description.length > 160) {
        out.push(finding('meta-description-length', 'meta[name="description"]', `<meta name="description" content="${data.description.slice(0, 120)}">`, `The meta description is ${data.description.length} characters; 50 to 160 shows best in search results.`));
      }
      if (data.title && (data.title.length < 10 || data.title.length > 65)) {
        out.push(finding('title-length', 'title', `<title>${data.title}</title>`, `The page title is ${data.title.length} characters; 10 to 65 shows in full in search results and browser tabs.`));
      }
      const missingOg = [!data.ogTitle && 'og:title', !data.ogDescription && 'og:description', !data.ogImage && 'og:image'].filter(Boolean);
      if (missingOg.length) out.push(finding('open-graph-missing', 'head', '<head>', `Missing Open Graph tags: ${missingOg.join(', ')}. Shared links won’t have a proper title, summary or image.`));
      for (const image of data.images) {
        const reason = unhelpfulAlt(image.alt);
        if (reason) out.push(finding('alt-text-unhelpful', image.selector, image.html, `The alt text is “${image.alt}”, which doesn’t describe the image: ${reason}.`));
      }
      return out;
    },
  };
}

function finding(ruleId: string, selector: string, html: string, failureSummary: string): CheckFinding {
  const guidance = guidanceFor('prego', ruleId)!;
  const alt = ruleId === 'alt-text-unhelpful';
  return {
    module: 'content',
    engine: 'prego',
    ruleId,
    // Unhelpful alt text is an accessibility problem (WCAG 1.1.1); the rest is content and SEO.
    category: alt ? 'A11Y' : 'CONT',
    severity: RULES[ruleId],
    title: guidance.title,
    description: guidance.description,
    helpUrl: null,
    wcagCriteria: alt ? ['1.1.1'] : [],
    wcagLevel: alt ? 'A' : null,
    selector,
    html,
    failureSummary,
    // Head-level problems are usually the template's or CMS's: one site-wide ticket listing the pages.
    ...(alt ? {} : { siteWide: true, component: `content:${ruleId}` }),
  };
}
