import { existsSync, mkdirSync, statSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import type { PregoDb } from '../db/database.js';
import { BrowserSession, sessionPath, type BasicAuth, type OpenedPage } from '../browser/session.js';
import { exploreApp, openScreen } from '../explore/explorer.js';
import { createSafety, DEFAULT_DENY_LABELS, type DummyData } from '../explore/safety.js';
import { viewportName, type Emulation, type ProfileName } from '../browser/profiles.js';
import { stateMapModule } from '../checks/state-map/state-map.js';
import { guidanceFor } from '../checks/guidance.js';
import type { CheckFinding, LocatedFinding } from '../checks/types.js';
import { identifyScreen } from '../explore/state.js';
import { runStep, type Journey, type JourneyStep } from '../journeys/journey.js';
import { crawlSite, type FailedPage } from '../crawl/crawler.js';
import { extractStructure, groupTemplates, samplePages } from '../crawl/templates.js';
import { captureCrop, captureFullPage } from '../capture/capture.js';
import { describeComponent } from '../tickets/component.js';
import { buildTickets } from '../tickets/build.js';
import { serveFolder, type StaticServer } from '../serve/static-server.js';
import { checkDefinitions, createChecks, defaultChecks, unknownChecks } from '../checks/registry.js';
import type { CheckModule } from '../checks/types.js';
import type { AiSettings } from '../checks/ai/ai.js';
import { defaultDataDir } from '../paths.js';
import type { Location, Run } from '../types.js';

export interface AuditOptions {
  /** Project (client or site) name. Created if it doesn't exist. */
  project: string;
  /** URL to audit, or a local folder, which Prego serves itself. */
  target: string;
  /** Site crawl (default), interactive exploration of a single-page app or kiosk, or a recorded journey. */
  mode?: 'crawl' | 'explore' | 'journey';
  /** Journey mode: the recorded journey to replay, checking after every step. */
  journey?: Journey;
  /** Crawl or explore: replay this journey first to log in, and audit with the session it leaves. */
  loginJourney?: Journey;
  viewports?: ProfileName[];
  emulation?: Emulation;
  maxPages?: number;
  /** Link depth for crawls (default 10), action depth for explorations (default 8). */
  maxDepth?: number;
  /** Explore: maximum screens to record. Default 200. */
  maxStates?: number;
  /** Explore: elements to ignore when telling screens apart (clocks, carousels, videos). */
  maskSelectors?: string[];
  /** Explore: fake time allowed for transitions after each action. Default 1000ms. */
  settleMs?: number;
  /** Explore: action labels never pressed. Default DEFAULT_DENY_LABELS (delete, buy, send...). */
  denyLabels?: string[];
  /** Explore: CSS selectors never pressed. */
  denySelectors?: string[];
  /** Explore: screens more than this many taps from the start are flagged. Default 4. */
  maxTaps?: number;
  /** Explore: values typed into form fields. Default: config/dummy-data.json values. */
  dummyData?: DummyData;
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
  /** Checks to run, by ID (see checks/registry.ts). Default: every default check except slow ones. */
  checks?: string[];
  /** Check module instances to run instead of `checks` (tests and custom setups). */
  modules?: CheckModule[];
  /** Maximum outlined crops per location and viewport. Default 100. */
  maxCropsPerLocation?: number;
  dataDir?: string;
  signal?: AbortSignal;
  /** Called with the URL of every request any browser makes during the audit. */
  onRequest?: (url: string) => void;
  /** Ollama on this computer, for the optional AI review check. */
  ai?: AiSettings;
  onEvent?: (event: AuditEvent) => void;
}

export type AuditEvent =
  | { type: 'started'; runId: number; projectId: number }
  | { type: 'phase'; phase: 'login' | 'crawl' | 'group' | 'explore' | 'journey' | 'audit' | 'tickets' | 'done'; message: string }
  | { type: 'page-found'; url: string; count: number }
  | { type: 'state-found'; stateId: string; title: string; depth: number; count: number; fromStateId: string | null; action: string | null }
  | { type: 'journey-step'; index: number; total: number; description: string; ok: boolean; error?: string }
  | {
      type: 'location-audited';
      url: string;
      viewport: string;
      findings: number;
      done: number;
      total: number;
      /** Full-page screenshot, relative to the run folder. */
      screenshot: string;
    }
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

/** What discovery hands to the checking stage: locations to audit, and how to open each one. */
interface Discovery {
  toAudit: Location[];
  open: (location: Location, profile: ProfileName) => Promise<OpenedPage>;
  /** Check modules that need what discovery found (e.g. the state map). */
  modules?: CheckModule[];
  /** Crawl only: pages that returned errors, for the broken links check. */
  failedPages?: FailedPage[];
  summary: Record<string, unknown>;
}

/**
 * Discover locations (crawl a site, or explore an interactive), audit them at each viewport, group the
 * findings into tickets and store everything.
 */
export async function runAudit(db: PregoDb, options: AuditOptions): Promise<AuditResult> {
  // A broken progress listener must never stop the audit or leave its run stuck at "running".
  const emit = (event: AuditEvent) => {
    try {
      options.onEvent?.(event);
    } catch (error) {
      console.error('Prego: audit event listener failed', error);
    }
  };
  const dataDir = resolve(options.dataDir ?? defaultDataDir());
  const viewports = options.viewports ?? ['desktop'];
  const checkIds = options.checks ?? defaultChecks();
  const unknown = unknownChecks(checkIds);
  if (unknown.length) throw new Error(`Unknown check: ${unknown.join(', ')}`);
  const chosen = options.modules?.map((m) => ({ id: m.id, name: m.name })) ?? checkIds.map((id) => ({ id, name: checkDefinitions().find((d) => d.id === id)!.name }));
  const delayMs = options.delayMs ?? 500;
  const mode = options.mode ?? 'crawl';

  let server: StaticServer | undefined;
  let startUrl = options.target;
  if (!/^https?:\/\//i.test(options.target) && existsSync(options.target) && statSync(options.target).isDirectory()) {
    server = await serveFolder(options.target, { substituteOrigin: true });
    startUrl = server.url;
  }

  const project = db.ensureProject(options.project);
  const run = db.createRun({
    projectId: project.id,
    mode,
    target: options.target,
    // Credentials never go in the run record: only whether auth was used.
    settings: {
      startUrl,
      viewports,
      emulation: options.emulation ?? {},
      maxPages: options.maxPages ?? 100,
      maxDepth: options.maxDepth ?? (mode === 'explore' ? 8 : 10),
      maxStates: options.maxStates ?? 200,
      maskSelectors: options.maskSelectors ?? [],
      denyLabels: options.denyLabels ?? DEFAULT_DENY_LABELS,
      denySelectors: options.denySelectors ?? [],
      include: options.include ?? [],
      exclude: options.exclude ?? [],
      respectRobots: options.respectRobots ?? true,
      useSitemap: options.useSitemap ?? true,
      perTemplate: options.perTemplate ?? 3,
      auditAll: options.auditAll ?? false,
      basicAuth: options.basicAuth ? { username: options.basicAuth.username } : null,
      keyJourneyUrls: options.keyJourneyUrls ?? [],
      modules: [
        ...chosen,
        ...(mode === 'explore' ? [{ id: 'state-map', name: 'Usability (state map)' }] : []),
        ...(mode === 'journey' ? [{ id: 'journey', name: 'Usability (journey replay)' }] : []),
      ],
      maxTaps: options.maxTaps ?? 4,
      journey: options.journey ? { name: options.journey.name, steps: options.journey.steps.length } : null,
      loginJourney: options.loginJourney?.name ?? null,
    },
  });
  emit({ type: 'started', runId: run.id, projectId: project.id });
  const runDir = runDirectory(dataDir, run.id);
  const storageStatePath = sessionPath(dataDir, project.slug);
  let session: BrowserSession | undefined;
  let activeModules: CheckModule[] = [];

  // Everything after the run row exists is inside this try, so any failure is recorded on the run.
  try {
    const browser = new BrowserSession({ basicAuth: options.basicAuth, authOrigin: new URL(startUrl).origin, storageStatePath, onRequest: options.onRequest });
    session = browser;
    if (options.loginJourney) {
      emit({ type: 'phase', phase: 'login', message: `Logging in with the "${options.loginJourney.name}" journey` });
      await logInWithJourney(browser, options.loginJourney, storageStatePath);
    }
    const context: DiscoveryContext = { db, run, options, startUrl, storageStatePath, browser, viewports, delayMs, emit };
    const discoveryStarted = Date.now();
    const discovery =
      mode === 'explore' ? await discoverByExploring(context) : mode === 'journey' ? await discoverByJourney(context) : await discoverByCrawling(context);
    const { toAudit } = discovery;
    const modules = [
      ...(options.modules ??
        createChecks(checkIds, {
          startUrl,
          failedPages: discovery.failedPages ?? [],
          basicAuth: options.basicAuth,
          onRequest: options.onRequest,
          previousScreenshot: previousScreenshots(db, run, dataDir),
          ai: options.ai,
        })),
      ...(discovery.modules ?? []),
    ];
    const firstViewport = viewportName(viewports[0], options.emulation);
    activeModules = modules;
    const timings: AuditTimings = { discoveryMs: Date.now() - discoveryStarted, pageViews: 0, openMs: 0, checks: {} };

    const noun = mode === 'explore' ? 'screens' : mode === 'journey' ? 'steps' : 'pages';
    emit({ type: 'phase', phase: 'audit', message: `Auditing ${toAudit.length} ${noun} at ${viewports.length} viewport(s)` });
    const jobs = toAudit.flatMap((location) => viewports.map((profile) => ({ location, profile })));
    let done = 0;
    // Explorations and journeys replay paths in a stateful app, so they're checked one at a time.
    await runPool(jobs, mode === 'crawl' ? (options.concurrency ?? 2) : 1, async ({ location, profile }) => {
      throwIfAborted(options.signal);
      try {
        const result = await auditLocation(db, () => discovery.open(location, profile), run, runDir, location, modules, options.maxCropsPerLocation ?? 100, firstViewport, timings);
        done++;
        emit({ type: 'location-audited', url: location.title && mode !== 'crawl' ? location.title : location.url, viewport: result.viewport, findings: result.findings, done, total: jobs.length, screenshot: result.screenshot });
      } catch (error) {
        if (mode === 'crawl') throw error;
        // A path found at one viewport may not exist at another (responsive layouts differ).
        done++;
        emit({ type: 'warning', message: `Couldn't reach "${location.title}" at ${profile}: ${error instanceof Error ? error.message.split('\n')[0] : error}` });
      }
      if (delayMs > 0 && mode === 'crawl') await sleep(delayMs);
    });

    // Checks that compare across locations (duplicate titles, colour drift) report now. Their example
    // pages are opened again, once each, to crop the element the finding points at.
    const late = (
      await Promise.all(
        modules.map(async (m) => {
          const started = Date.now();
          const found = (await m.finish?.()) ?? [];
          timings.checks[m.id] = (timings.checks[m.id] ?? 0) + Date.now() - started;
          return found;
        }),
      )
    ).flat();
    const byLocation = new Map<number, LocatedFinding[]>();
    for (const f of late) byLocation.set(f.locationId, [...(byLocation.get(f.locationId) ?? []), f]);
    for (const [locationId, findings] of byLocation) {
      const location = db.getLocation(locationId)!;
      let opened: OpenedPage | undefined;
      try {
        opened = await discovery.open(location, viewports[0]);
      } catch {
        // Couldn't reach it again: keep the findings without crops.
      }
      try {
        for (const [i, finding] of findings.entries()) {
          const { locationId: _l, viewport, ...rest } = finding;
          let crop: string | null = null;
          if (opened) {
            const path = join('crops', `${locationId}-late-${i + 1}.png`);
            if (await captureCrop(opened.page, finding.selector, join(runDir, path))) crop = path;
          }
          db.addRawFinding({ ...rest, runId: run.id, locationId, viewport, crop, ...findingComponent(finding) });
        }
      } finally {
        await opened?.close();
      }
    }

    emit({ type: 'phase', phase: 'tickets', message: 'Grouping findings into tickets' });
    buildTickets(db, run.id, { keyJourneyUrls: options.keyJourneyUrls });

    db.finishRun(run.id, 'complete', {
      ...discovery.summary,
      findings: db.getRawFindings(run.id).length,
      tickets: db.getTickets(run.id).length,
      timings: { ...timings, totalMs: Date.now() - new Date(run.startedAt).getTime(), locations: toAudit.length, viewports: viewports.length },
    });
    emit({ type: 'phase', phase: 'done', message: 'Audit complete' });
  } catch (error) {
    const aborted = options.signal?.aborted;
    db.finishRun(run.id, aborted ? 'stopped' : 'failed', {}, error instanceof Error ? error.message : String(error));
    if (!aborted) throw error;
  } finally {
    for (const module of activeModules) await module.close?.().catch(() => undefined);
    await session?.close();
    await server?.close();
  }

  return { run: db.getRun(run.id)!, runDir, locations: db.getLocations(run.id) };
}

/**
 * Where an audit's time went, kept in the run summary so time estimates can learn from real audits.
 * Concurrent page views overlap, so the parts can add up to more than the total.
 */
export interface AuditTimings {
  discoveryMs: number;
  /** Page views audited (locations × viewports reached). */
  pageViews: number;
  /** Opening pages and taking the full-page screenshot. */
  openMs: number;
  /** Time in each check, by check ID. */
  checks: Record<string, number>;
  totalMs?: number;
  locations?: number;
  viewports?: number;
}

/**
 * Screenshots from the project's last complete audit, matched by page path (so a local folder served
 * on a new port each time still matches) and, for explored screens, by screen title.
 */
function previousScreenshots(db: PregoDb, run: Run, dataDir: string): (location: Location, viewport: string) => { path: string; runId: number; date: string } | null {
  const previous = db
    .listRuns(run.projectId)
    .filter((r) => r.id < run.id && r.status === 'complete' && r.mode === run.mode)
    .at(-1);
  if (!previous) return () => null;
  const key = (l: Location) => {
    const url = new URL(l.url);
    return `${url.pathname}${url.search}${l.kind === 'state' ? `#${l.title}` : ''}`;
  };
  const byKey = new Map(db.getLocations(previous.id).map((l) => [key(l), l]));
  return (location, viewport) => {
    const shot = byKey.get(key(location))?.screenshots[viewport];
    const path = shot && join(runDirectory(dataDir, previous.id), shot);
    return path && existsSync(path) ? { path, runId: previous.id, date: previous.startedAt.slice(0, 10) } : null;
  };
}

async function auditLocation(
  db: PregoDb,
  open: () => Promise<OpenedPage>,
  run: Run,
  runDir: string,
  location: Location,
  modules: CheckModule[],
  maxCrops: number,
  firstViewport: string,
  timings: AuditTimings,
): Promise<{ viewport: string; findings: number; screenshot: string }> {
  const opening = Date.now();
  const opened = await open();
  try {
    const screenshot = join('screenshots', `${location.id}-${safe(opened.viewport)}.png`);
    await captureFullPage(opened.page, join(runDir, screenshot));
    const screenshotPath = join(runDir, screenshot);
    timings.openMs += Date.now() - opening;
    timings.pageViews++;
    db.updateLocation(location.id, { screenshots: { ...(db.getLocation(location.id)?.screenshots ?? {}), [opened.viewport]: screenshot } });

    let count = 0;
    const touch = await opened.page.evaluate(() => navigator.maxTouchPoints > 0);
    // Run every module first, so second engines can drop what another engine already reported.
    const byModule = new Map<CheckModule, CheckFinding[]>();
    for (const module of modules) {
      if (module.perViewport === false && opened.viewport !== firstViewport) continue;
      const started = Date.now();
      byModule.set(
        module,
        await module.run({
          page: opened.page,
          location,
          viewport: opened.viewport,
          touch,
          firstViewport: opened.viewport === firstViewport,
          screenshot: screenshotPath,
          recordMetrics: (metrics) => db.updateLocation(location.id, { metrics: { ...db.getLocation(location.id)!.metrics, ...metrics } }),
        }),
      );
      timings.checks[module.id] = (timings.checks[module.id] ?? 0) + Date.now() - started;
    }
    for (const [module, own] of byModule) {
      if (!module.dedupe) continue;
      const others = [...byModule].filter(([m]) => m !== module).flatMap(([, f]) => f);
      byModule.set(module, await module.dedupe(opened.page, own, others));
    }
    for (const findings of byModule.values()) {
      for (const finding of findings) {
        count++;
        const component = finding.siteWide || finding.component ? findingComponent(finding) : await describeComponent(opened.page, finding.selector).then((c) => ({ component: c.path, componentShared: c.shared }));
        let crop: string | null = null;
        if (count <= maxCrops) {
          const path = join('crops', `${location.id}-${safe(opened.viewport)}-${count}.png`);
          if (finding.cropImage) {
            mkdirSync(join(runDir, 'crops'), { recursive: true });
            writeFileSync(join(runDir, path), finding.cropImage);
            crop = path;
          } else if (await captureCrop(opened.page, finding.selector, join(runDir, path))) crop = path;
        }
        const { cropImage: _image, ...stored } = finding;
        db.addRawFinding({
          ...stored,
          runId: run.id,
          locationId: location.id,
          viewport: opened.viewport,
          crop,
          ...component,
        });
      }
    }
    return { viewport: opened.viewport, findings: count, screenshot };
  } finally {
    await opened.close();
  }
}

/** Where a finding is grouped when its module says (site-wide problems, or an explicit component). */
function findingComponent(finding: CheckFinding): { component: string; componentShared: boolean } {
  if (finding.siteWide) return { component: `site:${finding.component ?? finding.ruleId}`, componentShared: true };
  return { component: finding.component ?? `selector:${finding.selector}`, componentShared: false };
}

interface DiscoveryContext {
  db: PregoDb;
  run: Run;
  options: AuditOptions;
  startUrl: string;
  storageStatePath: string;
  browser: BrowserSession;
  viewports: ProfileName[];
  delayMs: number;
  emit: (event: AuditEvent) => void;
}

/** Crawl the site, group pages into templates and sample them. */
async function discoverByCrawling({ db, run, options, startUrl, storageStatePath, browser, delayMs, emit }: DiscoveryContext): Promise<Discovery> {
  let pagesFound = 0;
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
    signal: options.signal,
    onRequest: options.onRequest,
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

  return {
    toAudit,
    failedPages: crawl.failed,
    open: async (location, profile) => {
      const opened = await browser.newPage(profile, options.emulation);
      try {
        await opened.page.goto(location.url, { waitUntil: 'load' });
        await opened.page.waitForLoadState('networkidle', { timeout: 5_000 }).catch(() => undefined);
        return opened;
      } catch (error) {
        await opened.close();
        throw error;
      }
    },
    summary: {
      pagesFound: crawl.pages.length,
      pagesAudited: toAudit.length,
      templates: groups.length,
      brokenLinks: crawl.failed.length,
      skipped: crawl.skipped.length,
      stoppedEarly: crawl.stoppedEarly,
    },
  };
}

/** Explore an interactive breadth-first and record every screen and what each action did. */
async function discoverByExploring({ db, run, options, startUrl, browser, viewports, emit }: DiscoveryContext): Promise<Discovery> {
  emit({ type: 'phase', phase: 'explore', message: `Exploring ${startUrl}` });
  const safety = createSafety(startUrl, { denyLabels: options.denyLabels, denySelectors: options.denySelectors, dummyData: options.dummyData });
  const explore = {
    startUrl,
    session: browser,
    emulation: options.emulation,
    settleMs: options.settleMs,
    prepareScreen: safety.prepareScreen,
  };
  const result = await exploreApp({
    ...explore,
    canPerform: safety.canPerform,
    profile: viewports[0],
    maxStates: options.maxStates,
    maxDepth: options.maxDepth,
    timeBudgetMs: options.timeBudgetMs,
    maskSelectors: options.maskSelectors,
    signal: options.signal,
    onState: (state, count, from) =>
      emit({ type: 'state-found', stateId: state.id, title: state.title, depth: state.depth, count, fromStateId: from?.id ?? null, action: state.steps.at(-1)?.label ?? null }),
  });
  throwIfAborted(options.signal);

  const locationByState = new Map<string, Location>();
  db.transaction(() => {
    for (const state of result.states) {
      locationByState.set(
        state.id,
        db.addLocation({
          runId: run.id,
          kind: 'state',
          url: state.url,
          stateId: state.id,
          title: state.title,
          statusCode: null,
          depth: state.depth,
          // Each screen is its own "template" for ticket grouping; state IDs are stable across runs.
          templateKey: `state:${state.id}`,
          structureHash: null,
          audited: true,
          steps: state.steps,
        }),
      );
    }
    for (const edge of result.edges) {
      db.addEdge({
        runId: run.id,
        fromLocationId: locationByState.get(edge.from)!.id,
        toLocationId: edge.to ? (locationByState.get(edge.to)?.id ?? null) : null,
        step: edge.action,
        outcome: edge.outcome,
        reason: edge.reason ?? null,
      });
    }
  });

  const map = stateMapModule(
    { locations: db.getLocations(run.id), edges: db.getEdges(run.id) },
    { maxTaps: options.maxTaps, viewport: viewportName(viewports[0], options.emulation) },
  );
  return {
    toAudit: [...locationByState.values()],
    open: async (location, profile) => (await openScreen(explore, location.steps ?? [], profile)).opened,
    modules: [map],
    summary: {
      statesFound: result.states.length,
      statesAudited: result.states.length,
      actionsTried: result.edges.length,
      stoppedEarly: result.stoppedEarly,
    },
  };
}

/** Replay each recorded step, recording the screen after every one so it can be checked. */
async function discoverByJourney({ db, run, options, browser, viewports, emit }: DiscoveryContext): Promise<Discovery> {
  const journey = options.journey;
  if (!journey) throw new Error('Journey mode needs a recorded journey');
  if (journey.steps.length === 0) throw new Error(`The "${journey.name}" journey has no steps Prego can replay`);
  emit({ type: 'phase', phase: 'journey', message: `Replaying the "${journey.name}" journey (${journey.steps.length} steps)` });

  const toAudit: Location[] = [];
  const failures = new Map<number, CheckFinding[]>();
  const opened = await browser.newPage(viewports[0], options.emulation);
  try {
    for (const step of journey.steps) {
      throwIfAborted(options.signal);
      try {
        await runStep(opened.page, step);
      } catch (error) {
        const message = error instanceof Error ? error.message.split('\n')[0] : String(error);
        emit({ type: 'journey-step', index: step.index, total: journey.steps.length, description: step.description, ok: false, error: message });
        // Report the failure on the last step that worked (the screen the visitor would be stuck on).
        const stuckAt = toAudit.at(-1);
        if (stuckAt) failures.set(stuckAt.id, [journeyFailure(step, message)]);
        break;
      }
      const identity = await identifyScreen(opened.page);
      const location = db.addLocation({
        runId: run.id,
        kind: 'state',
        url: opened.page.url(),
        stateId: identity.id,
        title: `Step ${step.index}: ${step.description}`,
        statusCode: null,
        depth: step.index,
        templateKey: `journey:${journey.name}:${step.index}`,
        structureHash: null,
        audited: true,
        steps: journey.steps.slice(0, step.index).map((s) => ({ key: s.statement, label: s.description, role: 'journey', kind: 'click', selector: '' })),
      });
      toAudit.push(location);
      emit({ type: 'journey-step', index: step.index, total: journey.steps.length, description: step.description, ok: true });
    }
  } finally {
    await opened.close();
  }

  const stepsByIndex = new Map(journey.steps.map((s) => [s.index, s]));
  return {
    toAudit,
    open: async (location, profile) => {
      const page = await browser.newPage(profile, options.emulation);
      try {
        for (let i = 1; i <= location.depth; i++) await runStep(page.page, stepsByIndex.get(i)!);
        return page;
      } catch (error) {
        await page.close();
        throw error;
      }
    },
    modules: [
      {
        id: 'journey',
        name: 'Usability (journey replay)',
        async run({ location, viewport }) {
          return viewport === viewportName(viewports[0], options.emulation) ? (failures.get(location.id) ?? []) : [];
        },
      },
    ],
    summary: {
      journey: journey.name,
      stepsRecorded: journey.steps.length,
      stepsReplayed: toAudit.length,
      completed: toAudit.length === journey.steps.length,
      statesAudited: toAudit.length,
    },
  };
}

function journeyFailure(step: JourneyStep, message: string): CheckFinding {
  const guidance = guidanceFor('prego', 'journey-step-failed')!;
  return {
    module: 'journey',
    engine: 'prego',
    ruleId: 'journey-step-failed',
    category: 'UX',
    severity: 'High',
    title: guidance.title,
    description: guidance.description,
    helpUrl: null,
    wcagCriteria: [],
    wcagLevel: null,
    selector: 'html',
    html: step.statement,
    failureSummary: `Step ${step.index} (${step.description}) failed: ${message}`,
  };
}

/** Replay a login journey and save the session it leaves, so the audit runs logged in. */
async function logInWithJourney(browser: BrowserSession, journey: Journey, storageStatePath: string) {
  const opened = await browser.newPage('desktop');
  try {
    for (const step of journey.steps) await runStep(opened.page, step);
    await BrowserSession.saveSession(opened.context, storageStatePath);
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
