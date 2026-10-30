export const VERSION = '2.0.0-alpha.0';

export { serveFolder, type StaticServer, type StaticServerOptions } from './serve/static-server.js';
export * from './types.js';
export { PregoDb, slugify } from './db/database.js';
export { defaultDataDir } from './paths.js';
export * from './browser/profiles.js';
export { BrowserSession, sessionPath, type BasicAuth, type BrowserSessionOptions, type OpenedPage } from './browser/session.js';
export { crawlSite, type CrawlOptions, type CrawlResult, type CrawledPage, type FailedPage } from './crawl/crawler.js';
export * from './crawl/templates.js';
export * from './checks/types.js';
export { axeModule, AXE_TAGS, wcagFromTags, type AxeModuleOptions } from './checks/axe/axe.js';
export { guidanceFor, guidanceWithFallback, type RuleGuidance, type Effort } from './checks/guidance.js';
export * from './audit/run-audit.js';
export { captureCrop, captureFullPage, HIGHLIGHT_COLOUR, type CropOptions } from './capture/capture.js';
