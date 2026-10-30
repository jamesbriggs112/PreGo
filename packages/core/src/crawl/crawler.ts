import { PlaywrightCrawler, Configuration, log, LogLevel, type PlaywrightCrawlingContext } from '@crawlee/playwright';
import { MemoryStorage } from '@crawlee/memory-storage';
import { RobotsTxtFile, Sitemap } from '@crawlee/utils';
import { chromium, type BrowserContextOptions } from 'playwright';
import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import type { BasicAuth } from '../browser/session.js';
import { EVALUATE_SHIM } from '../browser/shim.js';

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

export interface CrawlResult {
  pages: CrawledPage[];
  /** Pages that returned an HTTP error or failed to load: broken links. */
  failed: FailedPage[];
  /** URLs found but not crawled, and why (robots.txt, filters, limits). */
  skipped: { url: string; reason: string }[];
  sitemapUrls: string[];
  stoppedEarly: boolean;
}

export async function crawlSite(options: CrawlOptions): Promise<CrawlResult> {
  const start = new URL(options.startUrl);
  const respectRobots = options.respectRobots ?? true;
  const toGlob = (pattern: string) => (pattern.startsWith('/') ? `${start.origin}${pattern}` : pattern);
  const include = options.include?.map(toGlob);
  const exclude = options.exclude?.map(toGlob);

  const pages: CrawledPage[] = [];
  const failed: FailedPage[] = [];
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
  const crawler = new PlaywrightCrawler(
    {
      launchContext: { launcher: chromium, launchOptions: { headless: true }, useIncognitoPages: true },
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
            req.userData = { ...req.userData, referrer: request.url };
            return req;
          },
        });
      },
      async failedRequestHandler({ request }, error) {
        failed.push({ url: request.url, statusCode: null, error: error.message, referrer: request.userData.referrer as string });
      },
    },
    config,
  );

  const timer = options.timeBudgetMs
    ? setTimeout(() => {
        stoppedEarly = true;
        crawler.stop('Time budget reached');
      }, options.timeBudgetMs)
    : undefined;
  try {
    await crawler.run(seeds);
  } finally {
    clearTimeout(timer);
  }

  if (skipped.some((s) => s.reason === 'limit')) stoppedEarly = true;
  pages.sort((a, b) => a.depth - b.depth || a.url.localeCompare(b.url));
  return { pages, failed, skipped, sitemapUrls, stoppedEarly };
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
