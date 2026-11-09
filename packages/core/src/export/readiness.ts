import type { Location } from '../types.js';
import type { FutureMetrics, FutureSiteMetrics } from '../checks/future/future.js';
import { SHARE_IMAGE, type SharingMetrics } from '../checks/sharing/sharing.js';

// The future readiness assessment: a short checklist worked out from what the Search and sharing and
// Future readiness checks recorded, each area rated good, partly or poor, and a score from them.

export type ReadinessStatus = 'good' | 'partly' | 'poor';

export interface ReadinessItem {
  id: string;
  area: string;
  status: ReadinessStatus;
  /** What Prego found, in a sentence. */
  found: string;
}

export interface Readiness {
  items: ReadinessItem[];
  /** 0 to 100: good counts fully, partly half. */
  score: number;
  pages: { location: Location; future?: FutureMetrics; sharing?: SharingMetrics }[];
  site: FutureSiteMetrics | null;
}

const pct = (n: number, of: number) => (of ? Math.round((n / of) * 100) : 0);
const status = (share: number, good: number, partly: number): ReadinessStatus => (share >= good ? 'good' : share >= partly ? 'partly' : 'poor');

export const STATUS_LABELS: Record<ReadinessStatus, string> = { good: 'Good', partly: 'Partly', poor: 'Needs work' };

/** The assessment, or null when neither check ran. */
export function assessReadiness(locations: Location[]): Readiness | null {
  const pages = locations
    .filter((l) => l.metrics.future || l.metrics.sharing)
    .map((location) => ({ location, future: location.metrics.future as FutureMetrics | undefined, sharing: location.metrics.sharing as SharingMetrics | undefined }));
  if (!pages.length) return null;
  const site = (locations.find((l) => l.metrics.futureSite)?.metrics.futureSite as FutureSiteMetrics | undefined) ?? null;
  const items: ReadinessItem[] = [];
  const future = pages.filter((p) => p.future).map((p) => p.future!);
  const sharing = pages.filter((p) => p.sharing).map((p) => p.sharing!);

  if (site) {
    if (site.aiCrawlers === null) items.push({ id: 'crawlers', area: 'AI assistants can read the site', status: 'good', found: 'There’s no robots.txt, so every AI crawler may read the site.' });
    else {
      const blocked = site.aiCrawlers.filter((c) => !c.allowed);
      items.push({
        id: 'crawlers',
        area: 'AI assistants can read the site',
        status: blocked.length === 0 ? 'good' : blocked.length < site.aiCrawlers.length ? 'partly' : 'poor',
        found: blocked.length
          ? `robots.txt blocks ${blocked.length} of the ${site.aiCrawlers.length} AI crawlers checked (${blocked.map((c) => c.agent).join(', ')}). That may be a deliberate choice.`
          : `robots.txt lets all ${site.aiCrawlers.length} AI crawlers checked read the site.`,
      });
    }
  }
  if (future.length) {
    const average = future.reduce((sum, f) => sum + f.textWithoutJs, 0) / future.length;
    const needJs = future.filter((f) => f.textWithoutJs < 0.5).length;
    items.push({
      id: 'javascript',
      area: 'Content readable without JavaScript',
      status: status(average, 0.8, 0.5),
      found: `On average ${Math.round(average * 100)}% of each page’s text is in the HTML before scripts run${needJs ? `; ${needJs} ${needJs === 1 ? 'page needs' : 'pages need'} JavaScript for most of it` : ''}.`,
    });
    const types = [...new Set(future.flatMap((f) => f.schemaTypes))];
    const withSchema = future.filter((f) => f.schemaTypes.length).length;
    const organisation = types.some((t) => /Organization|LocalBusiness|Corporation|NGO|Museum|Store|Business/.test(t));
    items.push({
      id: 'schema',
      area: 'Structured data',
      status: withSchema === 0 ? 'poor' : organisation && pct(withSchema, future.length) >= 50 ? 'good' : 'partly',
      found: withSchema ? `${withSchema} of ${future.length} pages describe themselves with schema.org data (${types.slice(0, 6).join(', ')}).${organisation ? '' : ' None says who runs the site.'}` : 'No page has schema.org structured data.',
    });
    const answerable = future.filter((f) => f.questionHeadings > 0 || f.summaryFirst).length;
    items.push({
      id: 'answers',
      area: 'Answer-ready content',
      status: status(pct(answerable, future.length), 50, 1),
      found: `${answerable} of ${future.length} pages open with a short summary or use question headings that AI answers and featured snippets can quote.`,
    });
    const faq = types.includes('FAQPage');
    const speakable = future.some((f) => f.speakable);
    items.push({
      id: 'voice',
      area: 'Voice search',
      status: faq || speakable ? 'good' : answerable ? 'partly' : 'poor',
      found: faq || speakable ? `The site marks up ${[faq && 'FAQs', speakable && 'speakable sections'].filter(Boolean).join(' and ')} for voice assistants.` : 'Nothing is marked up for voice assistants (FAQPage or speakable).',
    });
    const phones = new Set(future.flatMap((f) => f.phones));
    items.push({
      id: 'contact',
      area: 'Consistent contact details',
      status: phones.size === 1 ? 'good' : 'partly',
      found:
        phones.size === 0
          ? 'No page links a phone number, so assistants can’t offer to call.'
          : phones.size === 1
            ? 'The same phone number is linked wherever one appears.'
            : `${phones.size} different phone numbers are linked across the site. Check each is meant to be there.`,
    });
  }
  if (site?.sitemap) {
    const { found, urls, withDates } = site.sitemap;
    items.push({
      id: 'sitemap',
      area: 'Sitemap with dates',
      status: !found ? 'poor' : urls && withDates >= urls / 2 ? 'good' : 'partly',
      found: !found ? 'No sitemap was found.' : `The sitemap lists ${urls} ${urls === 1 ? 'entry' : 'entries'}, ${withDates} with a last-modified date.`,
    });
  }
  if (sharing.length) {
    const goodSnippet = sharing.filter((s) => s.title.length >= 10 && s.title.length <= 65 && s.description && s.description.length >= 50 && s.description.length <= 160).length;
    items.push({
      id: 'snippets',
      area: 'Search result snippets',
      status: status(pct(goodSnippet, sharing.length), 80, 40),
      found: `${goodSnippet} of ${sharing.length} pages have a title and description that show in full in search results.`,
    });
    const goodPreview = sharing.filter(
      (s) => s.og.title && s.og.description && s.image?.ok && (s.image.width ?? 0) >= SHARE_IMAGE.minimum.width && (s.image.height ?? 0) >= SHARE_IMAGE.minimum.height,
    ).length;
    items.push({
      id: 'previews',
      area: 'Link previews when shared',
      status: status(pct(goodPreview, sharing.length), 80, 40),
      found: `${goodPreview} of ${sharing.length} pages show a full preview, with a title, summary and large image, when shared.`,
    });
    const canonical = sharing.filter((s) => s.canonical).length;
    items.push({ id: 'canonical', area: 'Canonical addresses', status: status(pct(canonical, sharing.length), 90, 50), found: `${canonical} of ${sharing.length} pages say which address is the main one.` });
  }
  const score = items.length ? Math.round((items.reduce((sum, i) => sum + (i.status === 'good' ? 1 : i.status === 'partly' ? 0.5 : 0), 0) / items.length) * 100) : 0;
  return { items, score, pages, site };
}
