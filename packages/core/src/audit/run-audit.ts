import { existsSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import type { PregoDb } from '../db/database.js';
import { BrowserSession, sessionPath, type BasicAuth } from '../browser/session.js';
import type { Emulation, ProfileName } from '../browser/profiles.js';
import { crawlSite } from '../crawl/crawler.js';
import { extractStructure, groupTemplates, samplePages } from '../crawl/templates.js';
import { captureCrop, captureFullPage } from '../capture/capture.js';
import { describeComponent } from '../tickets/component.js';
import { buildTickets } from '../tickets/build.js';
import { serveFolder, type StaticServer } from '../serve/static-server.js';
import { axeModule } from '../checks/axe/axe.js';
import type { CheckModule } from '../checks/types.js';
import { defaultDataDir } from '../paths.js';
import type { Location, Run } from '../types.js';

export interface AuditOptions {
  /** Project (client or site) name. Created if it doesn't exist. */
  project: string;
  /** URL to audit, or a local folder, which Prego serves itself. */
  target: string;
  viewports?: ProfileName[];
  emulation?: Emulation;
  maxPages?: number;
  maxDepth?: number;
  timeBudgetMs?: number;
  include?: string[];
  exclude?: string[];
  respectRobots?: boolean;
  useSitemap?: boolean;
  /** Pages open at once, for crawling and auditing. Default 2. */
  concurrency?: number;
  /** Delay between page loads. Default 500ms. */
  delayMs?: number;
  /** Pages audited per template. Default 3. */
  perTemplate?: number;
  auditAll?: boolean;
  basicAuth?: BasicAuth;
  /** URLs on a key user journey; problems there get a higher priority. */
  keyJourneyUrls?: string[];
  /** Check modules to run. Default: axe. */
  modules?: CheckModule[];
  /** Maximum outlined crops per location and viewport. Default 100. */
  maxCropsPerLocation?: number;
  dataDir?: string;
  signal?: AbortSignal;
  onEvent?: (event: AuditEvent) => void;
}

export type AuditEvent =
  | { type: 'phase'; phase: 'crawl' | 'group' | 'audit' | 'tickets' | 'done'; message: string }
  | { type: 'page-found'; url: string; count: number }
  | { type: 'location-audited'; url: string; viewport: string; findings: number; done: number; total: number; screenshot: string }
  | { type: 'warning'; message: string };

export interface AuditResult {
  run: Run;
  runDir: string;
  locations: Location[];
}

/** Run folder for screenshots and crops. Paths stored in the database are relative to it. */
export function runDirectory(dataDir: string, runId: number): string {
  return join(dataDir, 'runs', String(runId));
}

/** Crawl a site, audit a sample of pages per template at each viewport, and store the findings. */
export async function runAudit(db: PregoDb, options: AuditOptions): Promise<AuditResult> {
  const emit = options.onEvent ?? (() => {});
  const dataDir = resolve(options.dataDir ?? defaultDataDir());
  const viewports = options.viewports ?? ['desktop'];
  const modules = options.modules ?? [axeModule()];
  const delayMs = options.delayMs ?? 500;

  let server: StaticServer | undefined;
  let startUrl = options.target;
  if (!/^https?:\/\//i.test(options.target) && existsSync(options.target) && statSync(options.target).isDirectory()) {
    server = await serveFolder(options.target, { substituteOrigin: true });
    startUrl = server.url;
  }

  const project = db.ensureProject(options.project);
  const run = db.createRun({
    projectId: project.id,
    mode: 'crawl',
    target: options.target,
    // Credentials never go in the run record: only whether auth was used.
    settings: {
      startUrl,
      viewports,
      emulation: options.emulation ?? {},
      maxPages: options.maxPages ?? 100,
      maxDepth: options.maxDepth ?? 10,
      include: options.include ?? [],
      exclude: options.exclude ?? [],
      respectRobots: options.respectRobots ?? true,
      useSitemap: options.useSitemap ?? true,
      perTemplate: options.perTemplate ?? 3,
      auditAll: options.auditAll ?? false,
      basicAuth: options.basicAuth ? { username: options.basicAuth.username } : null,
      keyJourneyUrls: options.keyJourneyUrls ?? [],
      modules: modules.map((m) => ({ id: m.id, name: m.name })),
    },
  });
  const runDir = runDirectory(dataDir, run.id);
  const storageStatePath = sessionPath(dataDir, project.slug);
  const session = new BrowserSession({ basicAuth: options.basicAuth, authOrigin: new URL(startUrl).origin, storageStatePath });

  let pagesFound = 0;
  try {
    emit({ type: 'phase', phase: 'crawl', message: `Crawling ${startUrl}` });
    const crawl = await crawlSite({
      startUrl,
      maxPages: options.maxPages,
      maxDepth: options.maxDepth,
      timeBudgetMs: options.timeBudgetMs,
      include: options.include,
      exclude: options.exclude,
      respectRobots: options.respectRobots,
      useSitemap: options.useSitemap,
      concurrency: options.concurrency,
      delayMs,
      basicAuth: options.basicAuth,
      storageStatePath,
      inspectPage: async ({ page }) => ({ structure: await extractStructure(page) }),
      onPage: (page) => emit({ type: 'page-found', url: page.url, count: ++pagesFound }),
    });
    throwIfAborted(options.signal);

    emit({ type: 'phase', phase: 'group', message: `Grouping ${crawl.pages.length} pages into templates` });
    const groups = groupTemplates(crawl.pages.map((p) => ({ ...p, structure: p.data.structure as string[] })));
    const sampled = samplePages(groups, { perTemplate: options.perTemplate, auditAll: options.auditAll });
    const toAudit: Location[] = [];
    db.transaction(() => {
      for (const s of sampled) {
        const location = db.addLocation({
          runId: run.id,
          kind: 'page',
          url: s.page.url,
          title: s.page.title,
          statusCode: s.page.statusCode,
          depth: s.page.depth,
          templateKey: s.templateKey,
          structureHash: s.templateHash,
          audited: s.audit,
          notAuditedReason: s.reason ?? null,
        });
        if (s.audit) toAudit.push(location);
      }
      for (const f of crawl.failed) {
        db.addLocation({
          runId: run.id,
          kind: 'page',
          url: f.url,
          title: null,
          statusCode: f.statusCode,
          depth: 0,
          templateKey: null,
          structureHash: null,
          audited: false,
          notAuditedReason: f.referrer ? `${f.error}, linked from ${f.referrer}` : f.error,
        });
      }
    });

    emit({ type: 'phase', phase: 'audit', message: `Auditing ${toAudit.length} pages at ${viewports.length} viewport(s)` });
    const jobs = toAudit.flatMap((location) => viewports.map((profile) => ({ location, profile })));
    let done = 0;
    await runPool(jobs, options.concurrency ?? 2, async ({ location, profile }) => {
      throwIfAborted(options.signal);
      const result = await auditLocation(db, session, run, runDir, location, profile, options.emulation, modules, options.maxCropsPerLocation ?? 100);
      done++;
      emit({ type: 'location-audited', url: location.url, viewport: result.viewport, findings: result.findings, done, total: jobs.length, screenshot: join(runDir, result.screenshot) });
      if (delayMs > 0) await sleep(delayMs);
    });

    emit({ type: 'phase', phase: 'tickets', message: 'Grouping findings into tickets' });
    buildTickets(db, run.id, { keyJourneyUrls: options.keyJourneyUrls });

    const findings = db.getRawFindings(run.id).length;
    db.finishRun(run.id, 'complete', {
      pagesFound: crawl.pages.length,
      pagesAudited: toAudit.length,
      templates: groups.length,
      brokenLinks: crawl.failed.length,
      skipped: crawl.skipped.length,
      stoppedEarly: crawl.stoppedEarly,
      findings,
      tickets: db.getTickets(run.id).length,
    });
    emit({ type: 'phase', phase: 'done', message: 'Audit complete' });
  } catch (error) {
    const aborted = options.signal?.aborted;
    db.finishRun(run.id, aborted ? 'stopped' : 'failed', {}, error instanceof Error ? error.message : String(error));
    if (!aborted) throw error;
  } finally {
    await session.close();
    await server?.close();
  }

  return { run: db.getRun(run.id)!, runDir, locations: db.getLocations(run.id) };
}

async function auditLocation(
  db: PregoDb,
  session: BrowserSession,
  run: Run,
  runDir: string,
  location: Location,
  profile: ProfileName,
  emulation: Emulation | undefined,
  modules: CheckModule[],
  maxCrops: number,
): Promise<{ viewport: string; findings: number; screenshot: string }> {
  const opened = await session.newPage(profile, emulation);
  try {
    await opened.page.goto(location.url, { waitUntil: 'load' });
    await opened.page.waitForLoadState('networkidle', { timeout: 5_000 }).catch(() => undefined);
    const screenshot = join('screenshots', `${location.id}-${safe(opened.viewport)}.png`);
    await captureFullPage(opened.page, join(runDir, screenshot));
    db.updateLocation(location.id, { screenshots: { ...(db.getLocation(location.id)?.screenshots ?? {}), [opened.viewport]: screenshot } });

    let count = 0;
    for (const module of modules) {
      const findings = await module.run({ page: opened.page, location, viewport: opened.viewport });
      for (const finding of findings) {
        count++;
        const component = await describeComponent(opened.page, finding.selector);
        let crop: string | null = null;
        if (count <= maxCrops) {
          const path = join('crops', `${location.id}-${safe(opened.viewport)}-${count}.png`);
          if (await captureCrop(opened.page, finding.selector, join(runDir, path))) crop = path;
        }
        db.addRawFinding({
          ...finding,
          runId: run.id,
          locationId: location.id,
          viewport: opened.viewport,
          crop,
          component: component.path,
          componentShared: component.shared,
        });
      }
    }
    return { viewport: opened.viewport, findings: count, screenshot };
  } finally {
    await opened.close();
  }
}

async function runPool<T>(items: T[], concurrency: number, worker: (item: T) => Promise<void>) {
  let next = 0;
  const lanes = Array.from({ length: Math.min(concurrency, items.length) }, async () => {
    while (next < items.length) await worker(items[next++]);
  });
  await Promise.all(lanes);
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const safe = (name: string) => name.replace(/[^a-z0-9+-]/gi, '_');

function throwIfAborted(signal?: AbortSignal) {
  if (signal?.aborted) throw new Error('Audit stopped');
}
