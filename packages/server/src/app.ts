import Fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest } from 'fastify';
import fastifyStatic from '@fastify/static';
import { createReadStream, existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { basename, dirname, extname, join, resolve, sep } from 'node:path';
import JSZip from 'jszip';
import mammoth from 'mammoth';
import {
  CATEGORIES,
  PregoDb,
  CSV_PRESETS,
  DEFAULT_DENY_LABELS,
  SEVERITIES,
  TriageError,
  buildExportPlan,
  buildDashboard,
  readManifest,
  updateVulnDb,
  vulnDbAgeDays,
  type UpdateProgress,
  type Dashboard,
  reportOutline,
  checkDefinitions,
  aiSettings,
  assertLocalOllama,
  CHECK_GROUPS,
  unknownChecks,
  ensureJourneysDir,
  journeysDir,
  sessionPath,
  journeyFile,
  listJourneys,
  slugify,
  stateMapPng,
  stateMapStates,
  exportRun,
  runImagesDeleted,
  reportCharts,
  parseReportOptions,
  parseAnalyticsCsv,
  mergeAnalytics,
  AnalyticsImportError,
  parseAudienceProfile,
  siteFacts,
  suggestAudienceFor,
  suggestReportText,
  getSettings,
  logoPath,
  reportBranding,
  reportDocx,
  overviewDocx,
  futureDocx,
  hasReadiness,
  audienceDocx,
  hasAudience,
  saveSettings,
  type DummyData,
  type ExportRecord,
  type PregoSettings,
  averagePerformance,
  categoryScore,
  checkedCategories,
  mergeTickets,
  updateTicket,
  type TicketChanges,
  isProfileName,
  runDirectory,
  type Category,
  type ProfileName,
  type Run,
  type SuggestJob,
} from '@prego/core';
import { AuditInProgressError, JobRunner, type JobEvent } from './jobs.js';
import { planAudit, recentCalibration } from './assistant.js';
import { playwrightCodegen, type Recorder, type Recording } from './recorder.js';

export interface AppOptions {
  db: PregoDb;
  dataDir: string;
  /** Built web app to serve (packages/web/dist). Omit in development, where Vite serves it. */
  webDist?: string;
  logger?: boolean;
  /** Values the explorer types into forms. Default: built-in dummy data. */
  dummyData?: DummyData;
  /** How journeys are recorded. Default: Playwright's code generator (tests swap in a fake). */
  recorder?: Recorder;
  /** Refresh the vulnerability data in the background when it's a week old (if the auditor allows). Off in tests. */
  vulnDbAutoUpdate?: boolean;
}

export interface PregoApp {
  app: FastifyInstance;
  jobs: JobRunner;
}

const LOCAL_HOSTNAMES = new Set(['localhost', '127.0.0.1', '[::1]', '::1']);

const IMAGE_TYPES: Record<string, string> = { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg' };

/** Body of POST /api/runs. Credentials are passed to the audit and never stored. */
interface StartRunBody {
  project: string;
  target: string;
  competitors?: string[];
  mode?: 'crawl' | 'explore' | 'journey';
  /** Checks to run, by ID (GET /api/checks). Default: the defaults in Settings. */
  checks?: string[];
  /** Journey mode: name of the project's recorded journey to replay. */
  journey?: string;
  /** Replay this recorded journey first to log in. */
  loginJourney?: string;
  maxStates?: number;
  maskSelectors?: string[];
  denyLabels?: string[];
  denySelectors?: string[];
  viewports?: string[];
  emulation?: { reducedMotion?: boolean; forcedColors?: boolean; darkMode?: boolean; zoom200?: boolean };
  maxPages?: number;
  maxDepth?: number;
  timeBudgetMinutes?: number;
  include?: string[];
  exclude?: string[];
  respectRobots?: boolean;
  useSitemap?: boolean;
  perTemplate?: number;
  auditAll?: boolean;
  concurrency?: number;
  delayMs?: number;
  basicAuth?: { username: string; password: string };
}

const positiveInt = { type: 'integer', minimum: 0 } as const;
const stringList = { type: 'array', items: { type: 'string', minLength: 1 } } as const;
const startRunSchema = {
  body: {
    type: 'object',
    required: ['project', 'target'],
    additionalProperties: false,
    properties: {
      project: { type: 'string', minLength: 1, maxLength: 200 },
      target: { type: 'string', minLength: 1 },
      mode: { enum: ['crawl', 'explore', 'journey'] },
      checks: { type: 'array', items: { type: 'string' }, minItems: 1, uniqueItems: true },
      journey: { type: 'string', minLength: 1 },
      loginJourney: { type: 'string', minLength: 1 },
      maxStates: { type: 'integer', minimum: 1, maximum: 2000 },
      maskSelectors: { type: 'array', items: { type: 'string' } },
      denyLabels: { type: 'array', items: { type: 'string' } },
      denySelectors: { type: 'array', items: { type: 'string' } },
      viewports: { type: 'array', items: { type: 'string' }, minItems: 1 },
      emulation: {
        type: 'object',
        additionalProperties: false,
        properties: { reducedMotion: { type: 'boolean' }, forcedColors: { type: 'boolean' }, darkMode: { type: 'boolean' }, zoom200: { type: 'boolean' } },
      },
      maxPages: { type: 'integer', minimum: 1, maximum: 5000 },
      maxDepth: positiveInt,
      timeBudgetMinutes: { type: 'integer', minimum: 1 },
      include: stringList,
      exclude: stringList,
      respectRobots: { type: 'boolean' },
      useSitemap: { type: 'boolean' },
      perTemplate: { type: 'integer', minimum: 1 },
      auditAll: { type: 'boolean' },
      concurrency: { type: 'integer', minimum: 1, maximum: 8 },
      delayMs: positiveInt,
      competitors: { type: 'array', items: { type: 'string', maxLength: 300 }, maxItems: 20 },
      basicAuth: {
        type: 'object',
        required: ['username', 'password'],
        additionalProperties: false,
        properties: { username: { type: 'string', minLength: 1 }, password: { type: 'string' } },
      },
    },
  },
} as const;

export async function buildApp(options: AppOptions): Promise<PregoApp> {
  const { db, dataDir } = options;
  // Reject unknown fields rather than silently dropping them, so a mistyped option is an error.
  const app = Fastify({ logger: options.logger ?? false, ajv: { customOptions: { removeAdditional: false } } });
  const jobs = new JobRunner(db, dataDir);

  // Prego is a local tool handling client data. Refuse requests addressed to any other host name
  // (DNS rebinding) and cross-site requests from other origins.
  app.addHook('onRequest', async (request, reply) => {
    const hostname = hostnameOf(request.headers.host);
    const origin = request.headers.origin;
    if (!hostname || !LOCAL_HOSTNAMES.has(hostname) || (origin && !LOCAL_HOSTNAMES.has(hostnameOf(safeHost(origin)) ?? ''))) {
      return reply.code(403).send({ error: 'Prego only accepts requests from this computer.' });
    }
  });

  app.addHook('onClose', async () => {
    await jobs.shutdown();
  });

  app.get('/api/health', async () => ({ ok: true }));

  // The checks a run can choose from, for the New audit form.
  app.get('/api/checks', async () =>
    checkDefinitions().map(({ id, name, description, categories, defaultOn, slow, cost }) => ({
      id,
      name,
      description,
      categories,
      defaultOn,
      slow: !!slow,
      cost: { id, ...cost },
      available: (id !== 'ai' && id !== 'tasks') || !!aiSettings(getSettings(db)),
    })),
  );

  // Test groups, and how long checks took in the last 20 audits on this machine, for time estimates.
  app.get('/api/check-groups', async () => ({ groups: CHECK_GROUPS, calibration: recentCalibration(db) }));

  // Read a typed request ("an accessibility audit of example.org") into audit settings, for the person
  // to confirm. It never starts an audit itself.
  app.post<{ Body: { text: string } }>(
    '/api/assistant/plan',
    { schema: { body: { type: 'object', required: ['text'], additionalProperties: false, properties: { text: { type: 'string', minLength: 1, maxLength: 1000 } } } } },
    async (request) => planAudit(db, request.body.text),
  );

  // Projects

  app.get('/api/projects', async () =>
    db.listProjects().map((project) => {
      const runs = db.listRuns(project.id);
      const lastRun = runs.at(-1);
      const lastComplete = [...runs].reverse().find((r) => r.status === 'complete');
      return { ...project, runCount: runs.length, lastRun: lastRun ? runSummary(lastRun) : null, scores: lastComplete ? scoresFor(db, lastComplete) : null };
    }),
  );

  app.post<{ Body: { name: string } }>(
    '/api/projects',
    { schema: { body: { type: 'object', required: ['name'], additionalProperties: false, properties: { name: { type: 'string', minLength: 1, maxLength: 200 } } } } },
    async (request, reply) => {
      const name = request.body.name.trim();
      if (!name) return reply.code(400).send({ error: 'Give the project a name.' });
      return reply.code(201).send(db.ensureProject(name));
    },
  );

  // Delete a project with all its audits, screenshots, exports, journeys and saved login session.
  app.delete<{ Params: { id: string } }>('/api/projects/:id', async (request, reply) => {
    const project = db.getProject(Number(request.params.id));
    if (!project) return reply.code(404).send({ error: 'Project not found' });
    if (jobs.activeJob?.projectId === project.id) return reply.code(409).send({ error: 'Stop the running audit before deleting this project.' });
    const deleted = db.deleteProject(project.id)!;
    // Only ever remove files inside the data folder.
    const root = resolve(dataDir) + sep;
    const remove = (path: string) => {
      const full = resolve(path);
      if (full.startsWith(root)) rmSync(full, { recursive: true, force: true });
    };
    for (const runId of deleted.runIds) remove(runDirectory(dataDir, runId));
    for (const dir of deleted.exportDirs) remove(dir);
    remove(journeysDir(dataDir, project.slug));
    remove(sessionPath(dataDir, project.slug));
    return { deleted: { project: project.name, audits: deleted.runIds.length, exports: deleted.exportDirs.length } };
  });

  app.put<{ Params: { id: string }; Body: { pinned: boolean } }>(
    '/api/projects/:id/pinned',
    { schema: { body: { type: 'object', required: ['pinned'], additionalProperties: false, properties: { pinned: { type: 'boolean' } } } } },
    async (request, reply) => {
      const project = db.getProject(Number(request.params.id));
      if (!project) return reply.code(404).send({ error: 'Project not found' });
      db.saveProjectSettings(project.id, { pinned: request.body.pinned });
      return { pinned: request.body.pinned };
    },
  );

  app.get<{ Params: { id: string } }>('/api/projects/:id', async (request, reply) => {
    const project = db.getProject(Number(request.params.id));
    if (!project) return reply.code(404).send({ error: 'Project not found' });
    return { ...project, runs: db.listRuns(project.id).reverse().map(runSummary) };
  });

  // Journeys

  const recordings = new Map<string, Recording>();
  const recorder = options.recorder ?? playwrightCodegen;

  app.get<{ Params: { id: string } }>('/api/projects/:id/journeys', async (request, reply) => {
    const project = db.getProject(Number(request.params.id));
    if (!project) return reply.code(404).send({ error: 'Project not found' });
    return {
      journeys: listJourneys(dataDir, project.slug).map((j) => ({
        name: j.name,
        startUrl: j.startUrl,
        recordedAt: j.recordedAt,
        steps: j.steps.map((s) => ({ index: s.index, description: s.description })),
        unsupported: j.unsupported,
      })),
      recordings: [...recordings.values()].filter((r) => r.projectId === project.id),
    };
  });

  app.post<{ Params: { id: string }; Body: { name: string; url: string } }>(
    '/api/projects/:id/journeys/record',
    {
      schema: {
        body: {
          type: 'object',
          required: ['name', 'url'],
          additionalProperties: false,
          properties: { name: { type: 'string', minLength: 1, maxLength: 100 }, url: { type: 'string', pattern: '^https?://' } },
        },
      },
    },
    async (request, reply) => {
      const project = db.getProject(Number(request.params.id));
      if (!project) return reply.code(404).send({ error: 'Project not found' });
      const name = slugify(request.body.name);
      const key = `${project.id}:${name}`;
      if (recordings.get(key)?.status === 'recording') return reply.code(409).send({ error: `"${name}" is already being recorded.` });
      ensureJourneysDir(dataDir, project.slug);
      const outputFile = journeyFile(dataDir, project.slug, name);
      const recording: Recording = { projectId: project.id, name, status: 'recording' };
      recordings.set(key, recording);
      const child = recorder({ url: request.body.url, outputFile });
      child.once('error', (error) => Object.assign(recording, { status: 'failed', error: error.message }));
      child.once('exit', (code) => {
        if (recording.status !== 'recording') return;
        const saved = existsSync(outputFile) && listJourneys(dataDir, project.slug).some((j) => j.name === name);
        Object.assign(recording, saved ? { status: 'saved' } : { status: 'failed', error: code ? `The recorder exited with code ${code}` : 'Nothing was recorded' });
      });
      return reply.code(202).send({ name, status: 'recording' });
    },
  );

  // Runs

  app.post<{ Body: StartRunBody }>('/api/runs', { schema: startRunSchema }, async (request, reply) => {
    const body = request.body;
    const target = body.target.trim();
    const isUrl = /^https?:\/\//i.test(target);
    if (!isUrl && !(existsSync(target) && statSync(target).isDirectory())) {
      return reply.code(400).send({ error: 'Enter a web address starting with http:// or https://, or the full path of a folder on this computer.' });
    }
    const viewports = body.viewports ?? ['desktop'];
    const unknown = viewports.filter((v) => !isProfileName(v));
    if (unknown.length) return reply.code(400).send({ error: `Unknown viewport: ${unknown.join(', ')}` });
    try {
      const clean = (list?: string[]) => list?.map((s) => s.trim()).filter(Boolean);
      const explore = body.mode === 'explore';
      // Journeys belong to a project, so look them up by the project's name.
      const project = db.getProjectBySlug(slugify(body.project));
      const findJourney = (name: string) => (project ? listJourneys(dataDir, project.slug).find((j) => j.name === slugify(name)) : undefined);
      const journey = body.mode === 'journey' ? findJourney(body.journey ?? '') : undefined;
      const loginJourney = body.loginJourney ? findJourney(body.loginJourney) : undefined;
      if (body.mode === 'journey' && !journey) return reply.code(400).send({ error: 'Choose a recorded journey for this project.' });
      const checks = body.checks ?? getSettings(db).defaults.checks;
      const unknownCheckIds = unknownChecks(checks);
      if (unknownCheckIds.length) return reply.code(400).send({ error: `Unknown check: ${unknownCheckIds.join(', ')}` });
      if (body.loginJourney && !loginJourney) return reply.code(400).send({ error: `No recorded journey called "${body.loginJourney}" for this project.` });
      const ai = aiSettings(getSettings(db));
      if ((checks.includes('ai') || checks.includes('tasks')) && !ai) return reply.code(400).send({ error: 'AI review is switched off. Turn it on in Settings, with Ollama running on this computer.' });
      if (checks.includes('tasks') && !project?.settings.audience?.tasks.length) {
        return reply.code(400).send({ error: 'The task walkthrough needs personas and tasks. Set them up on this project’s Purposes and audience page first.' });
      }
      const job = await jobs.start({
        ai,
        project: body.project.trim(),
        target,
        mode: body.mode,
        checks,
        journey,
        loginJourney,
        maxStates: body.maxStates,
        maskSelectors: clean(body.maskSelectors),
        denyLabels: clean(body.denyLabels),
        denySelectors: clean(body.denySelectors),
        dummyData: options.dummyData,
        viewports: viewports as ProfileName[],
        emulation: body.emulation,
        maxPages: body.maxPages,
        maxDepth: body.maxDepth,
        timeBudgetMs: body.timeBudgetMinutes ? body.timeBudgetMinutes * 60_000 : undefined,
        include: body.include?.length ? body.include : undefined,
        exclude: body.exclude?.length ? body.exclude : undefined,
        respectRobots: body.respectRobots,
        useSitemap: body.useSitemap,
        perTemplate: body.perTemplate,
        auditAll: body.auditAll,
        concurrency: body.concurrency,
        delayMs: body.delayMs,
        basicAuth: body.basicAuth?.username ? body.basicAuth : undefined,
        competitors: body.competitors,
      });
      // Remember the explorer's denylist and masks for this project's next audit.
      if (explore) {
        db.saveProjectSettings(job.projectId, {
          ...(body.denyLabels && { denyLabels: clean(body.denyLabels) }),
          ...(body.denySelectors && { denySelectors: clean(body.denySelectors) }),
          ...(body.maskSelectors && { maskSelectors: clean(body.maskSelectors) }),
        });
      }
      return reply.code(202).send({ runId: job.runId, projectId: job.projectId });
    } catch (error) {
      if (error instanceof AuditInProgressError) return reply.code(409).send({ error: error.message, runId: error.runId });
      throw error;
    }
  });

  // Audit again: a new audit with the same settings as an earlier one. Concurrency and the delay between
  // pages aren't stored with an audit, so they come from Settings. A site password is never stored, so
  // audits that used one have to be started from the New audit form.
  app.post<{ Params: { id: string } }>('/api/runs/:id/rerun', async (request, reply) => {
    const run = db.getRun(Number(request.params.id));
    if (!run) return reply.code(404).send({ error: 'Run not found' });
    const s = run.settings as Record<string, unknown> & { basicAuth?: { username: string } | null; journey?: { name: string } | null; loginJourney?: string | null; modules?: { id: string }[] };
    if (s.basicAuth) return reply.code(409).send({ error: 'This audit used a site password, which Prego doesn’t keep. Start it again from the New audit form.' });
    const defaults = getSettings(db).defaults;
    const known = new Set(checkDefinitions().map((d) => d.id));
    const body: StartRunBody = {
      project: db.getProject(run.projectId)!.name,
      target: run.target,
      mode: run.mode as StartRunBody['mode'],
      checks: (s.modules ?? []).map((m) => m.id).filter((id) => known.has(id)),
      ...(s.journey && { journey: s.journey.name }),
      ...(s.loginJourney && { loginJourney: s.loginJourney }),
      ...(run.mode === 'explore' && { maxStates: s.maxStates as number, maskSelectors: s.maskSelectors as string[], denyLabels: s.denyLabels as string[], denySelectors: s.denySelectors as string[] }),
      viewports: s.viewports as string[],
      emulation: s.emulation as StartRunBody['emulation'],
      maxPages: s.maxPages as number,
      maxDepth: s.maxDepth as number,
      include: s.include as string[],
      exclude: s.exclude as string[],
      respectRobots: s.respectRobots as boolean,
      useSitemap: s.useSitemap as boolean,
      perTemplate: s.perTemplate as number,
      auditAll: s.auditAll as boolean,
      concurrency: defaults.concurrency,
      delayMs: defaults.delayMs,
      ...(Array.isArray(s.competitors) && s.competitors.length && { competitors: s.competitors as string[] }),
    };
    // Through the same route as the New audit form, so every check on the settings applies.
    const response = await app.inject({ method: 'POST', url: '/api/runs', payload: JSON.parse(JSON.stringify(body)) });
    return reply.code(response.statusCode).send(response.json());
  });

  app.get('/api/runs/active', async () => {
    const job = jobs.activeJob;
    return job ? { runId: job.runId, projectId: job.projectId } : null;
  });

  app.get<{ Params: { id: string } }>('/api/runs/:id', async (request, reply) => {
    const run = db.getRun(Number(request.params.id));
    if (!run) return reply.code(404).send({ error: 'Run not found' });
    const project = db.getProject(run.projectId)!;
    return {
      ...runSummary(run),
      project,
      settings: run.settings,
      locations: db.getLocations(run.id),
      scores: run.status === 'complete' ? scoresFor(db, run) : null,
      dashboard: run.status === 'complete' ? dashboardFor(db, run) : null,
      screenshotsDeleted: runImagesDeleted(db, run.id),
    };
  });

  app.post<{ Params: { id: string } }>('/api/runs/:id/stop', async (request, reply) => {
    if (!jobs.stop(Number(request.params.id))) return reply.code(409).send({ error: 'That audit is not running.' });
    return { stopping: true };
  });

  // Live progress as server-sent events. Replays everything so far, then streams new events.
  app.get<{ Params: { id: string } }>('/api/runs/:id/events', async (request, reply) => {
    const runId = Number(request.params.id);
    const run = db.getRun(runId);
    if (!run) return reply.code(404).send({ error: 'Run not found' });
    reply.hijack();
    const res = reply.raw;
    res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive', 'X-Accel-Buffering': 'no' });
    const send = (event: JobEvent) => res.write(`data: ${JSON.stringify(event)}\n\n`);

    const job = jobs.get(runId);
    if (!job) {
      // Finished before this server started (or never ran here): report how it ended.
      send({ type: 'end', status: run.status === 'running' ? 'failed' : run.status, error: run.error ?? undefined });
      res.end();
      return;
    }
    for (const event of job.events) send(event);
    if (job.status !== 'running') {
      res.end();
      return;
    }
    const listener = (event: JobEvent) => {
      send(event);
      if (event.type === 'end') close();
    };
    const heartbeat = setInterval(() => res.write(': keep-alive\n\n'), 15_000);
    const close = () => {
      clearInterval(heartbeat);
      job.listeners.delete(listener);
      res.end();
    };
    job.listeners.add(listener);
    request.raw.on('close', close);
  });

  // Tickets and triage

  app.get<{ Params: { id: string } }>('/api/runs/:id/tickets', async (request, reply) => {
    const runId = Number(request.params.id);
    if (!db.getRun(runId)) return reply.code(404).send({ error: 'Run not found' });
    // Pages are named by URL; interactive screens (which share one URL) by title.
    const journey = db.getRun(runId)!.mode === 'journey';
    const locations = new Map(db.getLocations(runId).map((l) => [l.id, l.kind !== 'state' ? l.url : journey ? (l.title ?? '') : `Screen: ${l.title}`]));
    // Each ticket lists the pages it affects, for the page filter.
    const pagesByTicket = new Map<string, Set<string>>();
    const locationIdsByTicket = new Map<string, Set<number>>();
    for (const o of db.getOccurrences(runId)) {
      if (!pagesByTicket.has(o.ticketId)) {
        pagesByTicket.set(o.ticketId, new Set());
        locationIdsByTicket.set(o.ticketId, new Set());
      }
      pagesByTicket.get(o.ticketId)!.add(locations.get(o.locationId) ?? '');
      locationIdsByTicket.get(o.ticketId)!.add(o.locationId);
    }
    return db.getTickets(runId).map((t) => ({ ...t, pages: [...(pagesByTicket.get(t.ticketId) ?? [])], locationIds: [...(locationIdsByTicket.get(t.ticketId) ?? [])] }));
  });

  app.get<{ Params: { id: string; ticketId: string } }>('/api/runs/:id/tickets/:ticketId', async (request, reply) => {
    const runId = Number(request.params.id);
    const ticket = db.getTicket(runId, request.params.ticketId);
    if (!ticket) return reply.code(404).send({ error: 'Ticket not found' });
    const locations = new Map(db.getLocations(runId).map((l) => [l.id, l]));
    const findings = new Map(db.getRawFindings(runId).map((f) => [f.id, f]));
    const screenshotsDeleted = runImagesDeleted(db, runId);
    const occurrences = db.getOccurrences(runId, ticket.ticketId).map((o) => ({
      id: o.id,
      url: locations.get(o.locationId)?.url ?? '',
      screen: locations.get(o.locationId)?.kind === 'state' ? locations.get(o.locationId)!.title : null,
      viewport: o.viewport,
      selector: o.selector,
      html: o.html,
      crop: screenshotsDeleted ? null : o.crop,
      failureSummary: findings.get(o.rawFindingId)?.failureSummary ?? null,
    }));
    const helpUrl = db.getRawFindings(runId).find((f) => f.ticketId === ticket.ticketId)?.helpUrl ?? null;
    return { ...ticket, helpUrl, occurrenceList: occurrences, screenshotsDeleted };
  });

  app.patch<{ Params: { id: string; ticketId: string }; Body: TicketChanges }>(
    '/api/runs/:id/tickets/:ticketId',
    {
      schema: {
        body: {
          type: 'object',
          additionalProperties: false,
          minProperties: 1,
          properties: {
            title: { type: ['string', 'null'], maxLength: 300 },
            severity: { anyOf: [{ type: 'null' }, { enum: [...SEVERITIES] }] },
            priority: { anyOf: [{ type: 'null' }, { enum: ['P1', 'P2', 'P3', 'P4'] }] },
            auditorNotes: { type: ['string', 'null'], maxLength: 5000 },
            dismissed: { type: 'boolean' },
            approved: { type: 'boolean' },
          },
        },
      },
    },
    async (request, reply) => {
      const runId = Number(request.params.id);
      if (jobs.get(runId)?.status === 'running') return reply.code(409).send({ error: 'Wait for the audit to finish before editing tickets.' });
      try {
        return updateTicket(db, runId, request.params.ticketId, request.body);
      } catch (error) {
        if (error instanceof TriageError) return reply.code(404).send({ error: error.message });
        throw error;
      }
    },
  );

  app.post<{ Params: { id: string }; Body: { into: string; from: string[] } }>(
    '/api/runs/:id/tickets/merge',
    {
      schema: {
        body: {
          type: 'object',
          required: ['into', 'from'],
          additionalProperties: false,
          properties: { into: { type: 'string' }, from: { type: 'array', items: { type: 'string' }, minItems: 1 } },
        },
      },
    },
    async (request, reply) => {
      const runId = Number(request.params.id);
      if (jobs.get(runId)?.status === 'running') return reply.code(409).send({ error: 'Wait for the audit to finish before merging tickets.' });
      try {
        return mergeTickets(db, runId, request.body.into, request.body.from);
      } catch (error) {
        if (error instanceof TriageError) return reply.code(400).send({ error: error.message });
        throw error;
      }
    },
  );

  // Settings

  // Vulnerability data: a local copy of public databases, refreshed on request or weekly. Downloads
  // name only a fixed list of common software, never anything about an audited site.
  type VulnJob = { controller: AbortController; progress: UpdateProgress | null; startedAt: string; finishedAt: string | null; error: string | null };
  let vulnJob: VulnJob | null = null;
  const autoUpdate = () => db.getSetting<boolean>('vulnDbAutoUpdate') ?? true;
  const vulnStatus = () => ({
    manifest: readManifest(dataDir),
    ageDays: vulnDbAgeDays(dataDir),
    autoUpdate: autoUpdate(),
    updating: !!vulnJob && !vulnJob.finishedAt,
    progress: vulnJob?.finishedAt ? null : (vulnJob?.progress ?? null),
    error: vulnJob?.error ?? null,
  });
  const startVulnUpdate = () => {
    if (vulnJob && !vulnJob.finishedAt) return;
    const job: VulnJob = { controller: new AbortController(), progress: null, startedAt: new Date().toISOString(), finishedAt: null, error: null };
    vulnJob = job;
    updateVulnDb(dataDir, { signal: job.controller.signal, onProgress: (p) => (job.progress = p) })
      .then((manifest) => {
        const failed = manifest.sources.filter((s) => s.error);
        if (failed.length) job.error = `Couldn’t update ${failed.map((s) => s.name).join(', ')}. The previous copy is kept.`;
      })
      .catch((error: Error) => (job.error = job.controller.signal.aborted ? 'Stopped. The previous copy is kept.' : `The update failed: ${error.message}. The previous copy is kept.`))
      .finally(() => (job.finishedAt = new Date().toISOString()));
  };
  app.get('/api/vulndb', async () => vulnStatus());
  app.post('/api/vulndb/update', async () => {
    startVulnUpdate();
    return vulnStatus();
  });
  app.delete('/api/vulndb/update', async () => {
    vulnJob?.controller.abort();
    return vulnStatus();
  });
  app.put<{ Body: { autoUpdate: boolean } }>(
    '/api/vulndb',
    { schema: { body: { type: 'object', required: ['autoUpdate'], additionalProperties: false, properties: { autoUpdate: { type: 'boolean' } } } } },
    async (request) => {
      db.setSetting('vulnDbAutoUpdate', request.body.autoUpdate);
      return vulnStatus();
    },
  );
  if (options.vulnDbAutoUpdate) {
    // Check now and every six hours; update when the data is missing or a week old.
    const check = () => {
      const age = vulnDbAgeDays(dataDir);
      if (autoUpdate() && (age === null || age >= 7)) startVulnUpdate();
    };
    const first = setTimeout(check, 15_000);
    const timer = setInterval(check, 6 * 3_600_000);
    first.unref();
    timer.unref();
    app.addHook('onClose', async () => {
      clearTimeout(first);
      clearInterval(timer);
      vulnJob?.controller.abort();
    });
  }

  app.get('/api/settings', async () => ({ ...getSettings(db), hasLogo: existsSync(logoPath(dataDir)), exploreDefaults: { denyLabels: DEFAULT_DENY_LABELS } }));

  app.put<{ Body: PregoSettings }>('/api/settings', { schema: settingsSchema }, async (request, reply) => {
    const unknown = request.body.defaults.viewports.filter((v) => !isProfileName(v));
    if (unknown.length) return reply.code(400).send({ error: `Unknown viewport: ${unknown.join(', ')}` });
    if (!CSV_PRESETS[request.body.defaults.csvPreset]) return reply.code(400).send({ error: 'Unknown CSV preset' });
    if (request.body.defaults.checks && unknownChecks(request.body.defaults.checks).length) return reply.code(400).send({ error: 'Unknown check' });
    const ai = request.body.ai ?? getSettings(db).ai;
    try {
      assertLocalOllama(ai.url);
    } catch (error) {
      return reply.code(400).send({ error: error instanceof Error ? error.message : String(error) });
    }
    const report = request.body.report ?? getSettings(db).report;
    saveSettings(db, { ...request.body, ai, report, branding: { ...request.body.branding, accentColour: request.body.branding.accentColour.replace(/^#/, '').toUpperCase() } });
    return { ...getSettings(db), hasLogo: existsSync(logoPath(dataDir)) };
  });

  // Check Ollama is running on this computer and list its models, for the Settings screen.
  app.post<{ Body: { url: string } }>(
    '/api/settings/ai/test',
    { schema: { body: { type: 'object', required: ['url'], additionalProperties: false, properties: { url: { type: 'string', maxLength: 200 } } } } },
    async (request, reply) => {
      let base: URL;
      try {
        base = assertLocalOllama(request.body.url);
      } catch (error) {
        return reply.code(400).send({ error: error instanceof Error ? error.message : String(error) });
      }
      try {
        const res = await fetch(new URL('/api/tags', base), { signal: AbortSignal.timeout(5_000) });
        if (!res.ok) return reply.code(502).send({ error: `Ollama answered ${res.status}.` });
        const { models } = (await res.json()) as { models?: { name: string }[] };
        return { models: (models ?? []).map((m) => m.name).sort() };
      } catch {
        return reply.code(502).send({ error: `Nothing is answering at ${base.origin}. Start Ollama (ollama serve) and try again.` });
      }
    },
  );

  // The report logo, uploaded as a base64 PNG in JSON (so uploads need the same JSON content type
  // as every other write, which cross-site forms can't send).
  app.put<{ Body: { png: string } }>(
    '/api/settings/logo',
    {
      bodyLimit: 3 * 1024 * 1024,
      schema: { body: { type: 'object', required: ['png'], additionalProperties: false, properties: { png: { type: 'string', maxLength: 2_800_000 } } } },
    },
    async (request, reply) => {
      const data = Buffer.from(request.body.png.replace(/^data:image\/png;base64,/, ''), 'base64');
      if (data.length < 24 || data.toString('ascii', 1, 4) !== 'PNG') return reply.code(400).send({ error: 'The logo must be a PNG image.' });
      mkdirSync(dirname(logoPath(dataDir)), { recursive: true });
      writeFileSync(logoPath(dataDir), data);
      return { hasLogo: true };
    },
  );

  app.delete('/api/settings/logo', async () => {
    rmSync(logoPath(dataDir), { force: true });
    return { hasLogo: false };
  });

  app.get('/api/settings/logo', async (_request, reply) => {
    const path = logoPath(dataDir);
    if (!existsSync(path)) return reply.code(404).send({ error: 'No logo' });
    return reply.type('image/png').header('Cache-Control', 'no-cache').send(createReadStream(path));
  });

  // Report contents: the client-facing layout, optional sections and written text, per audit.

  // `outline` is the developer report's sections and `clientOutline` the client report's.
  const reportState = (runId: number) => {
    const plan = buildExportPlan(db, runId);
    const run = db.getRun(runId)!;
    return {
      options: plan.options,
      available: plan.available,
      outline: reportOutline(run, { ...plan.options, clientFacing: false }, plan.available),
      clientOutline: reportOutline(run, { ...plan.options, clientFacing: true }, plan.available),
      suggestions: suggestReportText(plan),
      hasReadiness: hasReadiness(plan),
      hasAudience: hasAudience(plan),
    };
  };

  app.get<{ Params: { id: string } }>('/api/runs/:id/report', async (request, reply) => {
    const run = db.getRun(Number(request.params.id));
    if (!run) return reply.code(404).send({ error: 'Run not found' });
    return reportState(run.id);
  });

  app.put<{ Params: { id: string }; Body: unknown }>(
    '/api/runs/:id/report',
    { schema: { body: { type: 'object' } }, bodyLimit: 512 * 1024 },
    async (request, reply) => {
      const run = db.getRun(Number(request.params.id));
      if (!run) return reply.code(404).send({ error: 'Run not found' });
      db.saveReportOptions(run.id, parseReportOptions(request.body));
      return reportState(run.id);
    },
  );

  // What a project's site is for and who it's for: purposes, personas and tasks, suggested from its
  // latest finished audit and edited by the auditor.
  const latestCompleteRun = (projectId: number) => db.listRuns(projectId).findLast((r) => r.status === 'complete');

  app.get<{ Params: { id: string } }>('/api/projects/:id/audience', async (request, reply) => {
    const project = db.getProject(Number(request.params.id));
    if (!project) return reply.code(404).send({ error: 'Project not found' });
    const run = latestCompleteRun(project.id);
    const pages = run ? siteFacts(project, db.getLocations(run.id)).pages.map((p) => p.path) : [];
    return { profile: project.settings.audience ?? null, latestRunId: run?.id ?? null, pages: [...new Set(pages)].sort() };
  });

  // Suggestions run in the background: with AI on, the model can take a few minutes, so the page
  // checks on progress and can stop it. One job per project, kept until the next one starts.
  type Job = Omit<SuggestJob, 'seconds'> & { controller: AbortController; finishedAt?: number };
  const suggestJobs = new Map<number, Job>();
  const jobView = ({ controller: _controller, finishedAt, ...job }: Job): SuggestJob => ({ ...job, seconds: Math.round(((finishedAt ?? Date.now()) - Date.parse(job.startedAt)) / 1000) });
  let nextJobId = 1;
  app.post<{ Params: { id: string } }>('/api/projects/:id/audience/suggest', async (request, reply) => {
    const project = db.getProject(Number(request.params.id));
    if (!project) return reply.code(404).send({ error: 'Project not found' });
    const run = latestCompleteRun(project.id);
    if (!run) return reply.code(409).send({ error: 'Run an audit of this site first: suggestions come from what Prego finds on it.' });
    const running = suggestJobs.get(project.id);
    if (running?.status === 'running') return jobView(running);
    const ai = aiSettings(getSettings(db));
    const job: Job = { id: nextJobId++, status: 'running', ai: !!ai, startedAt: new Date().toISOString(), progress: null, suggestion: null, controller: new AbortController() };
    suggestJobs.set(project.id, job);
    const finished = suggestAudienceFor(siteFacts(project, db.getLocations(run.id)), ai, { signal: job.controller.signal, onProgress: (progress) => (job.progress = progress) }).then((suggestion) => {
      job.suggestion = suggestion;
      job.status = 'done';
      job.finishedAt = Date.now();
    });
    // Without AI it's instant, so answer with the result straight away.
    if (!ai) await finished;
    return jobView(job);
  });
  app.get<{ Params: { id: string } }>('/api/projects/:id/audience/suggest', async (request) => {
    const job = suggestJobs.get(Number(request.params.id));
    return job ? jobView(job) : null;
  });
  app.delete<{ Params: { id: string } }>('/api/projects/:id/audience/suggest', async (request) => {
    const job = suggestJobs.get(Number(request.params.id));
    job?.controller.abort();
    return { stopping: job?.status === 'running' };
  });

  app.put<{ Params: { id: string }; Body: unknown }>('/api/projects/:id/audience', { schema: { body: { type: 'object' } }, bodyLimit: 512 * 1024 }, async (request, reply) => {
    const project = db.getProject(Number(request.params.id));
    if (!project) return reply.code(404).send({ error: 'Project not found' });
    const profile = parseAudienceProfile(request.body);
    db.saveProjectSettings(project.id, { audience: profile });
    return { profile };
  });

  app.delete<{ Params: { id: string } }>('/api/projects/:id/audience', async (request, reply) => {
    const project = db.getProject(Number(request.params.id));
    if (!project) return reply.code(404).send({ error: 'Project not found' });
    db.saveProjectSettings(project.id, { audience: undefined });
    return { profile: null };
  });

  // Google Analytics figures for a project's reports, from GA's own CSV exports.
  app.put<{ Params: { id: string }; Body: { files: { name: string; text: string }[] } }>(
    '/api/projects/:id/analytics',
    {
      bodyLimit: 5 * 1024 * 1024,
      schema: {
        body: {
          type: 'object',
          required: ['files'],
          additionalProperties: false,
          properties: {
            files: {
              type: 'array',
              minItems: 1,
              maxItems: 10,
              items: { type: 'object', required: ['name', 'text'], additionalProperties: false, properties: { name: { type: 'string', maxLength: 200 }, text: { type: 'string' } } },
            },
          },
        },
      },
    },
    async (request, reply) => {
      const project = db.getProject(Number(request.params.id));
      if (!project) return reply.code(404).send({ error: 'Project not found' });
      try {
        // Added to what's there: a report replaces the same report from an earlier import.
        const analytics = mergeAnalytics(project.settings.analytics, parseAnalyticsCsv(request.body.files));
        db.saveProjectSettings(project.id, { analytics });
        return { analytics };
      } catch (error) {
        if (error instanceof AnalyticsImportError) return reply.code(400).send({ error: error.message });
        throw error;
      }
    },
  );

  app.delete<{ Params: { id: string } }>('/api/projects/:id/analytics', async (request, reply) => {
    const project = db.getProject(Number(request.params.id));
    if (!project) return reply.code(404).send({ error: 'Project not found' });
    db.saveProjectSettings(project.id, { analytics: undefined });
    return { analytics: null };
  });

  // Exports

  app.get<{ Params: { id: string } }>('/api/runs/:id/exports', async (request, reply) => {
    const runId = Number(request.params.id);
    if (!db.getRun(runId)) return reply.code(404).send({ error: 'Run not found' });
    return db.listExports(runId).filter((e) => existsSync(e.dir)).map(exportSummary);
  });

  app.post<{ Params: { id: string }; Body: { preset?: string } }>(
    '/api/runs/:id/exports',
    { schema: { body: { type: 'object', additionalProperties: false, properties: { preset: { type: 'string' } } } } },
    async (request, reply) => {
      const runId = Number(request.params.id);
      const run = db.getRun(runId);
      if (!run) return reply.code(404).send({ error: 'Run not found' });
      if (run.status !== 'complete') return reply.code(409).send({ error: 'Only finished audits can be exported.' });
      const preset = request.body?.preset;
      if (preset && !CSV_PRESETS[preset]) return reply.code(400).send({ error: `Unknown CSV preset "${preset}"` });
      const result = await exportRun(db, runId, { dataDir, preset });
      return reply.code(201).send(exportSummary(db.getExport(result.id)!));
    },
  );

  app.get<{ Params: { exportId: string; file: string } }>('/api/exports/:exportId/files/:file', async (request, reply) => {
    const record = db.getExport(Number(request.params.exportId));
    const file = EXPORT_FILES[request.params.file];
    if (!record || !file || !existsSync(join(record.dir, request.params.file))) return reply.code(404).send({ error: 'File not found' });
    return reply
      .type(file)
      .header('Content-Disposition', `attachment; filename="${basename(record.dir)}-${request.params.file}"`)
      .send(createReadStream(join(record.dir, request.params.file)));
  });

  app.get<{ Params: { exportId: string } }>('/api/exports/:exportId/zip', async (request, reply) => {
    const record = db.getExport(Number(request.params.exportId));
    if (!record || !existsSync(record.dir)) return reply.code(404).send({ error: 'Export not found' });
    const name = basename(record.dir);
    const zip = new JSZip();
    const folder = zip.folder(name)!;
    for (const file of Object.keys(EXPORT_FILES)) if (existsSync(join(record.dir, file))) folder.file(file, readFileSync(join(record.dir, file)));
    return reply
      .type('application/zip')
      .header('Content-Disposition', `attachment; filename="${name}.zip"`)
      .send(zip.generateNodeStream({ type: 'nodebuffer', streamFiles: true, compression: 'DEFLATE' }));
  });

  // The Word report as HTML, for previewing before export: report.docx (the developer report) by default,
  // or `?report=client`, `overview`, `audience` or `future`.
  app.get<{ Params: { id: string }; Querystring: { report?: string } }>('/api/runs/:id/report-preview', async (request, reply) => {
    const runId = Number(request.params.id);
    const run = db.getRun(runId);
    if (!run) return reply.code(404).send({ error: 'Run not found' });
    if (run.status !== 'complete') return reply.code(409).send({ error: 'Only finished audits have a report.' });
    const stored = buildExportPlan(db, runId);
    // The developer and client previews each use their own layout; the other reports follow the saved choice.
    const report = request.query.report ?? 'technical';
    const clientFacing = report === 'client' ? true : report === 'technical' ? false : stored.options.clientFacing;
    const plan = clientFacing === stored.options.clientFacing ? stored : buildExportPlan(db, runId, { ...stored.options, clientFacing });
    if (request.query.report === 'audience') {
      const { value } = await mammoth.convertToHtml({ buffer: await audienceDocx(plan, runDirectory(dataDir, runId), reportBranding(db, dataDir)) });
      return { html: value };
    }
    if (request.query.report === 'future') {
      const { value } = await mammoth.convertToHtml({ buffer: await futureDocx(plan, runDirectory(dataDir, runId), reportBranding(db, dataDir)) });
      return { html: value };
    }
    if (request.query.report === 'overview') {
      const { value } = await mammoth.convertToHtml({ buffer: await overviewDocx(plan, getSettings(db).report.whyItMatters, reportBranding(db, dataDir)) });
      return { html: value };
    }
    const stateMap =
      run.mode === 'explore'
        ? await stateMapPng(stateMapStates(plan), plan.edges.map((e) => ({ from: e.fromLocationId, to: e.toLocationId, label: e.step.label, outcome: e.outcome })))
        : undefined;
    const docx = await reportDocx(plan, runDirectory(dataDir, runId), reportBranding(db, dataDir), { stateMap, charts: await reportCharts(plan) });
    const { value } = await mammoth.convertToHtml({ buffer: docx });
    return { html: value };
  });

  // The explored state map: screens, what each action did, and each screen's open tickets.
  app.get<{ Params: { id: string } }>('/api/runs/:id/state-map', async (request, reply) => {
    const runId = Number(request.params.id);
    const run = db.getRun(runId);
    if (!run) return reply.code(404).send({ error: 'Run not found' });
    const tickets = new Map(db.getTickets(runId).filter((t) => t.status !== 'Dismissed').map((t) => [t.ticketId, t]));
    const ticketsByLocation = new Map<number, Set<string>>();
    for (const o of db.getOccurrences(runId)) {
      if (!tickets.has(o.ticketId)) continue;
      ticketsByLocation.set(o.locationId, (ticketsByLocation.get(o.locationId) ?? new Set()).add(o.ticketId));
    }
    const firstViewport = ((run.settings.viewports as string[] | undefined) ?? [])[0];
    const screenshotsDeleted = runImagesDeleted(db, runId);
    const states = db
      .getLocations(runId)
      .filter((l) => l.kind === 'state')
      .map((l) => ({
        id: l.id,
        stateId: l.stateId,
        title: l.title,
        depth: l.depth,
        steps: l.steps ?? [],
        screenshot: screenshotsDeleted ? null : (l.screenshots[firstViewport] ?? Object.values(l.screenshots)[0] ?? null),
        tickets: [...(ticketsByLocation.get(l.id) ?? [])].map((id) => {
          const t = tickets.get(id)!;
          return { ticketId: t.ticketId, title: t.title, severity: t.severity, category: t.category };
        }),
      }));
    const edges = db.getEdges(runId).map((e) => ({ from: e.fromLocationId, to: e.toLocationId, label: e.step.label, outcome: e.outcome, reason: e.reason }));
    return { states, edges, screenshotsDeleted };
  });

  // Screenshots and crops from a run folder.
  app.get<{ Params: { id: string; '*': string } }>('/api/runs/:id/files/*', async (request, reply) => {
    const runDir = resolve(runDirectory(dataDir, Number(request.params.id)));
    const path = resolve(join(runDir, request.params['*']));
    const type = IMAGE_TYPES[extname(path).toLowerCase()];
    if (!path.startsWith(runDir + sep) || !type || !existsSync(path)) return reply.code(404).send({ error: 'File not found' });
    return reply.type(type).header('Cache-Control', 'private, max-age=3600').send(createReadStream(path));
  });

  app.setErrorHandler((error: { statusCode?: number; validation?: unknown; message: string }, _request: FastifyRequest, reply: FastifyReply) => {
    if (error.validation) return reply.code(400).send({ error: error.message });
    app.log.error(error);
    return reply.code(error.statusCode ?? 500).send({ error: error.message });
  });

  if (options.webDist && existsSync(join(options.webDist, 'index.html'))) {
    // Serve whatever is in the build folder now, so a rebuild doesn't need a restart.
    await app.register(fastifyStatic, { root: resolve(options.webDist) });
    // Client-side routes (e.g. /runs/3) all load the app.
    app.setNotFoundHandler((request, reply) => {
      if (request.method === 'GET' && !request.url.startsWith('/api/')) return reply.sendFile('index.html');
      return reply.code(404).send({ error: 'Not found' });
    });
  }

  return { app, jobs };
}

const EXPORT_FILES: Record<string, string> = {
  'client-report.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  'overview.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  'future.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  'audience.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  'report.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  'tickets.csv': 'text/csv; charset=utf-8',
  'occurrences.csv': 'text/csv; charset=utf-8',
  'run.json': 'application/json',
  'state-map.png': 'image/png',
};

function exportSummary(record: ExportRecord) {
  return {
    id: record.id,
    runId: record.runId,
    name: basename(record.dir),
    folder: record.dir,
    preset: record.preset,
    createdAt: record.createdAt,
    files: Object.keys(EXPORT_FILES).filter((f) => existsSync(join(record.dir, f))),
  };
}

const settingsSchema = {
  body: {
    type: 'object',
    required: ['branding', 'defaults'],
    additionalProperties: false,
    properties: {
      branding: {
        type: 'object',
        required: ['companyName', 'accentColour'],
        additionalProperties: false,
        properties: {
          companyName: { type: 'string', minLength: 1, maxLength: 100 },
          accentColour: { type: 'string', pattern: '^#?[0-9A-Fa-f]{6}$' },
        },
      },
      defaults: {
        type: 'object',
        required: ['viewports', 'perTemplate', 'concurrency', 'delayMs', 'respectRobots', 'csvPreset'],
        additionalProperties: false,
        properties: {
          viewports: { type: 'array', items: { type: 'string' }, minItems: 1 },
          perTemplate: { type: 'integer', minimum: 1 },
          concurrency: { type: 'integer', minimum: 1, maximum: 8 },
          delayMs: { type: 'integer', minimum: 0 },
          respectRobots: { type: 'boolean' },
          csvPreset: { type: 'string' },
          checks: { type: 'array', items: { type: 'string' }, uniqueItems: true },
        },
      },
      ai: {
        type: 'object',
        required: ['enabled', 'url', 'model'],
        additionalProperties: false,
        properties: {
          enabled: { type: 'boolean' },
          url: { type: 'string', minLength: 1, maxLength: 200 },
          model: { type: 'string', minLength: 1, maxLength: 100 },
        },
      },
      report: {
        type: 'object',
        required: ['whyItMatters'],
        additionalProperties: false,
        properties: { whyItMatters: { type: 'string', maxLength: 20000 } },
      },
    },
  },
} as const;

function runSummary(run: Run) {
  return { id: run.id, projectId: run.projectId, mode: run.mode, target: run.target, status: run.status, startedAt: run.startedAt, finishedAt: run.finishedAt, summary: run.summary, error: run.error };
}

/** Score per checked category for a finished run, ignoring dismissed tickets and unapproved AI suggestions. */
export function scoresFor(db: PregoDb, run: Run): Partial<Record<Category, number>> {
  const checked = checkedCategories(run.settings);
  const tickets = db.getTickets(run.id).filter((t) => t.status === 'Open');
  const scores: Partial<Record<Category, number>> = {};
  for (const category of CATEGORIES) {
    if (!checked.has(category)) continue;
    const lighthouse = category === 'PERF' ? averagePerformance(db.getLocations(run.id)) : null;
    scores[category] = lighthouse ?? categoryScore(tickets.filter((t) => t.category === category).map((t) => t.severity));
  }
  return scores;
}

/** The results page's figures with traffic lights, and signs of possible legal risks. */
export function dashboardFor(db: PregoDb, run: Run): Dashboard {
  const project = db.getProject(run.projectId)!;
  return buildDashboard({
    run,
    locations: db.getLocations(run.id),
    tickets: db.getTickets(run.id).filter((t) => t.status === 'Open'),
    scores: scoresFor(db, run),
    checks: ((run.settings.modules as { id: string }[] | undefined) ?? []).map((m) => m.id),
    audience: project.settings.audience,
    analytics: project.settings.analytics,
  });
}

function hostnameOf(host: string | undefined): string | undefined {
  if (!host) return undefined;
  return host.startsWith('[') ? host.slice(0, host.indexOf(']') + 1) : host.split(':')[0];
}

function safeHost(origin: string): string | undefined {
  try {
    return new URL(origin).host;
  } catch {
    return undefined;
  }
}
