import { PlaywrightCrawler, Configuration, log, LogLevel, type PlaywrightCrawlingContext } from '@crawlee/playwright';
import { MemoryStorage } from '@crawlee/memory-storage';
import { RobotsTxtFile, Sitemap } from '@crawlee/utils';
import { chromium, type BrowserContextOptions } from 'playwright';
import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import type { BasicAuth } from '../browser/session.js';
import { EVALUATE_SHIM } from '../browser/shim.js';
import { blockTrackersFlag, reportUntracked } from '../browser/trackers.js';

export interface CrawlOptions {
  startUrl: string;
  /** Maximum pages to visit, including ones that turn out to be errors. Default 100. */
  maxPages?: number;
  /** Maximum link depth from the start URL (sitemap URLs count as depth 0). Default 10. */
  maxDepth?: number;
  /** Stop discovering new pages after this many milliseconds. Pages already open finish. */
  timeBudgetMs?: number;
  /**
   * Glob patterns a URL must match to be crawled. Patterns starting with `/` are matched against the
   * path on the start URL's origin, e.g. `/blog/**`. Default: everything on the same hostname.
   */
  include?: string[];
  /** Glob patterns to skip, in the same form as `include`. */
  exclude?: string[];
  /** Respect robots.txt. Default true; switch off for staging sites you own. */
  respectRobots?: boolean;
  /** Seed the crawl from sitemap.xml (via robots.txt or the common location). Default true. */
  useSitemap?: boolean;
  /** Pages open at once. Default 2. */
  concurrency?: number;
  /** Delay between requests to the same host. Default 500ms. */
  delayMs?: number;
  basicAuth?: BasicAuth;
  storageStatePath?: string;
  /** Stop the crawl early. Pages already open finish. */
  signal?: AbortSignal;
  /** Called with the URL of every request the crawler's browser makes. */
  onRequest?: (url: string) => void;
  /** Collect extra data from each page while it's open (e.g. its DOM structure). */
  inspectPage?: (context: PlaywrightCrawlingContext) => Promise<Record<string, unknown>>;
  onPage?: (page: CrawledPage) => void;
}

export interface CrawledPage {
  url: string;
  statusCode: number;
  title: string;
  depth: number;
  /** Other URLs that served identical HTML, e.g. `/index.html` for `/`. */
  aliases: string[];
  /** The page that linked here (undefined for the start URL and sitemap URLs). */
  referrer?: string;
  data: Record<string, unknown>;
}

export interface FailedPage {
  url: string;
  statusCode: number | null;
  error: string;
  referrer?: string;
}

/** A linked file rather than a web page: a PDF, a Word document, a spreadsheet. */
export interface DocumentLink {
  url: string;
  /** The media type the server gave, e.g. `application/pdf`, or null. */
  contentType: string | null;
  /** From Content-Length, when the server says. */
  bytes: number | null;
  statusCode: number | null;
  referrer?: string;
}

export interface CrawlResult {
  pages: CrawledPage[];
  /** Linked files that open or download fine. Never broken links or pages. */
  documents: DocumentLink[];
  /** Pages that returned an HTTP error or failed to load: broken links. */
  failed: FailedPage[];
  /** URLs found but not crawled, and why (robots.txt, filters, limits). */
  skipped: { url: string; reason: string }[];
  sitemapUrls: string[];
  stoppedEarly: boolean;
  /** Why the crawl stopped before reaching every page it found. */
  stopReason: 'time limit' | 'page limit' | 'stopped' | null;
}

export async function crawlSite(options: CrawlOptions): Promise<CrawlResult> {
  const start = new URL(options.startUrl);
  const respectRobots = options.respectRobots ?? true;
  const toGlob = (pattern: string) => (pattern.startsWith('/') ? `${start.origin}${pattern}` : pattern);
  const include = options.include?.map(toGlob);
  const exclude = options.exclude?.map(toGlob);

  const pages: CrawledPage[] = [];
  const failed: FailedPage[] = [];
  const documents: DocumentLink[] = [];
  const skipped: CrawlResult['skipped'] = [];
  const pageByContentHash = new Map<string, CrawledPage>();

  // robots.txt and sitemaps are fetched here rather than by Crawlee so that basic auth applies to them too.
  const robots = await loadRobots(start, options.basicAuth);
  const sitemapUrls = options.useSitemap === false ? [] : await findSitemapUrls(start, robots, options.basicAuth);
  const isAllowed = (url: string) => {
    if (!respectRobots || !robots || robots.isAllowed(url)) return true;
    skipped.push({ url, reason: 'robotsTxt' });
    return false;
  };
  const seeds = [start.href, ...sitemapUrls.filter((url) => new URL(url).hostname === start.hostname)].filter(isAllowed);

  log.setLevel(LogLevel.ERROR);
  const config = new Configuration({
    persistStorage: false,
    purgeOnStart: true,
    storageClient: new MemoryStorage({ persistStorage: false, writeMetadata: false }),
  });

  const contextOptions: BrowserContextOptions = {
    httpCredentials: options.basicAuth ? { ...options.basicAuth, origin: start.origin, send: 'unauthorized' } : undefined,
    storageState: options.storageStatePath && existsSync(options.storageStatePath) ? options.storageStatePath : undefined,
  };

  let stoppedEarly = false;
  let stopReason: CrawlResult['stopReason'] = null;
  const crawler = new PlaywrightCrawler(
    {
      launchContext: { launcher: chromium, launchOptions: { headless: true, args: [blockTrackersFlag()] }, useIncognitoPages: true },
      browserPoolOptions: {
        useFingerprints: false,
        prePageCreateHooks: [
          (_pageId, _controller, pageOptions) => {
            if (pageOptions) Object.assign(pageOptions, contextOptions);
          },
        ],
        postPageCreateHooks: [
          async (page) => {
            await page.addInitScript(EVALUATE_SHIM);
            const { onRequest } = options;
            if (onRequest) page.on('request', reportUntracked(onRequest));
          },
        ],
      },
      useSessionPool: false,
      maxConcurrency: options.concurrency ?? 2,
      sameDomainDelaySecs: (options.delayMs ?? 500) / 1000,
      maxRequestsPerCrawl: options.maxPages ?? 100,
      maxCrawlDepth: options.maxDepth ?? 10,
      maxRequestRetries: 1,
      onSkippedRequest: async ({ url, reason }) => {
        skipped.push({ url, reason });
      },
      async requestHandler(context) {
        const { request, response, page, enqueueLinks } = context;
        const statusCode = response?.status() ?? 0;
        const referrer = request.userData.referrer as string | undefined;
        if (statusCode >= 400) {
          failed.push({ url: request.url, statusCode, error: `HTTP ${statusCode}`, referrer });
          return;
        }
        // Only web pages are audited. Feeds and data are skipped; linked files are listed as documents.
        const contentType = (await response?.headerValue('content-type').catch(() => null)) ?? null;
        if (contentType && !isHtml(contentType)) {
          if (isFeedOrData(contentType)) skipped.push({ url: request.url, reason: 'notAPage' });
          else documents.push({ url: request.url, contentType: mediaType(contentType), bytes: numberOrNull(await response?.headerValue('content-length')), statusCode, referrer });
          return;
        }
        await page.waitForLoadState('load');
        const html = await page.content();
        const hash = createHash('sha1').update(html).digest('hex');
        const url = page.url();
        const duplicate = pageByContentHash.get(hash);
        if (duplicate) {
          duplicate.aliases.push(url);
        } else {
          const crawled: CrawledPage = {
            url,
            statusCode,
            title: await page.title(),
            depth: request.crawlDepth,
            aliases: url === request.url ? [] : [request.url],
            referrer,
            data: options.inspectPage ? await options.inspectPage(context) : {},
          };
          pageByContentHash.set(hash, crawled);
          pages.push(crawled);
          options.onPage?.(crawled);
        }
        await enqueueLinks({
          strategy: 'same-hostname',
          globs: include,
          exclude,
          transformRequestFunction: (req) => {
            if (!isAllowed(req.url)) return false;
            if (looksLikeFeed(req.url)) {
              if (!skipped.some((s) => s.url === req.url)) skipped.push({ url: req.url, reason: 'notAPage' });
              return false;
            }
            req.userData = { ...req.userData, referrer: request.url };
            return req;
          },
        });
      },
      // A link that starts a download is a file, not a broken page: don't try it twice.
      errorHandler({ request }, error) {
        if (isDownload(error)) request.noRetry = true;
      },
      async failedRequestHandler({ request }, error) {
        const referrer = request.userData.referrer as string | undefined;
        if (isDownload(error)) {
          const checked = await checkDocument(request.url, options.basicAuth);
          if (checked.statusCode !== null && checked.statusCode < 400) documents.push({ ...checked, url: request.url, referrer });
          else failed.push({ url: request.url, statusCode: checked.statusCode, error: checked.statusCode ? `HTTP ${checked.statusCode}` : error.message, referrer });
          return;
        }
        failed.push({ url: request.url, statusCode: null, error: error.message, referrer });
      },
    },
    config,
  );

  const timer = options.timeBudgetMs
    ? setTimeout(() => {
        stoppedEarly = true;
        stopReason ??= 'time limit';
        crawler.stop('Time budget reached');
      }, options.timeBudgetMs)
    : undefined;
  const onAbort = () => {
    stoppedEarly = true;
    stopReason ??= 'stopped';
    crawler.stop('Stopped');
  };
  options.signal?.addEventListener('abort', onAbort, { once: true });
  try {
    await crawler.run(seeds);
  } finally {
    clearTimeout(timer);
    options.signal?.removeEventListener('abort', onAbort);
  }

  if (skipped.some((s) => s.reason === 'limit')) {
    stoppedEarly = true;
    stopReason ??= 'page limit';
  }
  // Which alias was fetched first depends on timing; pick the shortest URL so runs agree.
  for (const page of pages) {
    const [canonical, ...aliases] = [page.url, ...page.aliases].sort((a, b) => a.length - b.length || (a < b ? -1 : 1));
    page.url = canonical;
    page.aliases = aliases;
  }
  pages.sort((a, b) => a.depth - b.depth || a.url.localeCompare(b.url));
  return { pages, documents, failed, skipped, sitemapUrls, stoppedEarly, stopReason };
}

const mediaType = (contentType: string) => contentType.split(';')[0].trim().toLowerCase();
const isHtml = (contentType: string) => /^(text\/html|application\/xhtml\+xml)$/.test(mediaType(contentType));
/** Feeds and data, which aren't pages and aren't documents people download. */
const isFeedOrData = (contentType: string) => /(rss|atom|xml|json|javascript)/.test(mediaType(contentType)) && !/officedocument|opendocument/.test(contentType);
/** RSS and Atom feeds and WordPress's data API, known by their addresses, so they aren't even requested. */
export const looksLikeFeed = (url: string) => /\/(feed|rss|atom)(\.xml)?\/?$|\.(rss|atom)$|\/wp-json(\/|$)|[?&]feed=/i.test(new URL(url).pathname + new URL(url).search);
const isDownload = (error: Error) => /download is starting/i.test(error.message);
const numberOrNull = (value: string | null | undefined) => (value && /^\d+$/.test(value) ? Number(value) : null);

/**
 * Whether a linked file is there: a HEAD request, or the first byte when the server won't answer HEAD.
 * The file is never downloaded in full.
 */
export async function checkDocument(url: string, auth?: BasicAuth): Promise<Omit<DocumentLink, 'url' | 'referrer'>> {
  const headers: Record<string, string> = {};
  if (auth) headers.Authorization = `Basic ${Buffer.from(`${auth.username}:${auth.password}`).toString('base64')}`;
  const attempt = async (method: 'HEAD' | 'GET') => {
    const response = await fetch(url, { method, headers: method === 'GET' ? { ...headers, Range: 'bytes=0-0' } : headers, redirect: 'follow', signal: AbortSignal.timeout(15_000) });
    await response.body?.cancel().catch(() => undefined);
    const range = response.headers.get('content-range')?.match(/\/(\d+)$/);
    return {
      statusCode: response.status,
      contentType: response.headers.get('content-type') ? mediaType(response.headers.get('content-type')!) : null,
      bytes: range ? Number(range[1]) : numberOrNull(response.headers.get('content-length')),
    };
  };
  try {
    const head = await attempt('HEAD');
    // Some servers refuse HEAD (405, 501) or answer it wrongly; ask for one byte instead.
    return head.statusCode < 400 ? head : await attempt('GET');
  } catch {
    try {
      return await attempt('GET');
    } catch {
      return { statusCode: null, contentType: null, bytes: null };
    }
  }
}

async function fetchText(url: string, auth?: BasicAuth): Promise<string | undefined> {
  const headers: Record<string, string> = {};
  if (auth) headers.Authorization = `Basic ${Buffer.from(`${auth.username}:${auth.password}`).toString('base64')}`;
  try {
    const response = await fetch(url, { headers, signal: AbortSignal.timeout(15_000) });
    return response.ok ? await response.text() : undefined;
  } catch {
    return undefined;
  }
}

async function loadRobots(start: URL, auth?: BasicAuth): Promise<RobotsTxtFile | undefined> {
  const url = new URL('/robots.txt', start).href;
  const content = await fetchText(url, auth);
  return content === undefined ? undefined : RobotsTxtFile.from(url, content);
}

/** Page URLs from the sitemaps named in robots.txt, falling back to /sitemap.xml. */
async function findSitemapUrls(start: URL, robots: RobotsTxtFile | undefined, auth?: BasicAuth): Promise<string[]> {
  const sitemapLocations = robots?.getSitemaps() ?? [];
  if (sitemapLocations.length === 0) sitemapLocations.push(new URL('/sitemap.xml', start).href);
  const urls: string[] = [];
  for (const location of sitemapLocations) {
    const xml = await fetchText(location, auth);
    if (!xml) continue;
    try {
      urls.push(...(await Sitemap.fromXmlString(xml)).urls);
    } catch {
      // Malformed sitemap: carry on with link discovery alone.
    }
  }
  return [...new Set(urls)];
}
