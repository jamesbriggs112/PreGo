import Fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest } from 'fastify';
import fastifyStatic from '@fastify/static';
import { createReadStream, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { basename, dirname, extname, join, resolve, sep } from 'node:path';
import JSZip from 'jszip';
import mammoth from 'mammoth';
import {
  CATEGORIES,
  CATEGORY_NAMES,
  PregoDb,
  CSV_PRESETS,
  DEFAULT_DENY_LABELS,
  SEVERITIES,
  TriageError,
  buildExportPlan,
  checkDefinitions,
  unknownChecks,
  ensureJourneysDir,
  journeyFile,
  listJourneys,
  slugify,
  stateMapPng,
  stateMapStates,
  exportRun,
  getSettings,
  logoPath,
  reportBranding,
  reportDocx,
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
} from '@prego/core';
import { AuditInProgressError, JobRunner, type JobEvent } from './jobs.js';
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
    checkDefinitions().map(({ id, name, description, categories, defaultOn, slow }) => ({ id, name, description, categories, defaultOn, slow: !!slow })),
  );

  // Dashboard: everything the home page shows, in one request.
  app.get('/api/dashboard', async () => {
    const projects = db.listProjects();
    const runs = projects.flatMap((p) => db.listRuns(p.id).map((r) => ({ ...r, projectName: p.name })));
    const completed = runs.filter((r) => r.status === 'complete').sort((a, b) => a.id - b.id);
    // Each project's most recent completed audit is its current state.
    const latestPerProject = projects
      .map((p) => [...completed].reverse().find((r) => r.projectId === p.id))
      .filter((r): r is (typeof completed)[number] => !!r);
    const open = (runId: number) => db.getTickets(runId).filter((t) => t.status !== 'Dismissed' && t.status !== 'Needs review');
    const openTickets = latestPerProject.flatMap((r) => open(r.id).map((t) => ({ ...t, projectName: r.projectName })));
    const severityRank = { Critical: 0, High: 1, Medium: 2, Low: 3 } as const;
    const latest = completed.at(-1);
    const active = jobs.activeJob;

    const categories = CATEGORIES.filter((c) => openTickets.some((t) => t.category === c));
    return {
      totals: {
        projects: projects.length,
        audits: runs.length,
        openTickets: openTickets.length,
        critical: openTickets.filter((t) => t.severity === 'Critical').length,
      },
      active: active ? { runId: active.runId, projectName: projects.find((p) => p.id === active.projectId)?.name ?? '' } : null,
      latest: latest
        ? { runId: latest.id, projectName: latest.projectName, mode: latest.mode, startedAt: latest.startedAt, scores: scoresFor(db, latest) }
        : null,
      recentRuns: [...runs]
        .sort((a, b) => b.id - a.id)
        .slice(0, 6)
        .map((r) => ({ id: r.id, projectName: r.projectName, status: r.status, mode: r.mode, startedAt: r.startedAt })),
      history: completed.slice(-16).map((r) => {
        const tickets = open(r.id);
        return {
          runId: r.id,
          projectName: r.projectName,
          startedAt: r.startedAt,
          tickets: tickets.length,
          critical: tickets.filter((t) => t.severity === 'Critical').length,
          a11y: scoresFor(db, r).A11Y ?? null,
        };
      }),
      heatmap: {
        categories: categories.map((c) => CATEGORY_NAMES[c]),
        cells: categories.flatMap((c) =>
          SEVERITIES.map((severity) => ({ category: CATEGORY_NAMES[c], severity, count: openTickets.filter((t) => t.category === c && t.severity === severity).length })),
        ),
      },
      topIssues: [...openTickets]
        .sort((a, b) => a.priority.localeCompare(b.priority) || severityRank[a.severity] - severityRank[b.severity] || b.locationsAffected - a.locationsAffected)
        .slice(0, 5)
        .map((t) => ({ runId: t.runId, ticketId: t.ticketId, title: t.title, severity: t.severity, priority: t.priority, projectName: t.projectName, occurrences: t.occurrences })),
    };
  });

  // Projects

  app.get('/api/projects', async () =>
    db.listProjects().map((project) => {
      const runs = db.listRuns(project.id);
      const lastRun = runs.at(-1);
      const lastComplete = [...runs].reverse().find((r) => r.status === 'complete');
      return { ...project, lastRun: lastRun ? runSummary(lastRun) : null, scores: lastComplete ? scoresFor(db, lastComplete) : null };
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
      const job = await jobs.start({
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

  app.get('/api/runs/active', async () => {
    const job = jobs.activeJob;
    return job ? { runId: job.runId, projectId: job.projectId } : null;
  });

  app.get<{ Params: { id: string } }>('/api/runs/:id', async (request, reply) => {
    const run = db.getRun(Number(request.params.id));
    if (!run) return reply.code(404).send({ error: 'Run not found' });
    const project = db.getProject(run.projectId)!;
    return { ...runSummary(run), project, settings: run.settings, locations: db.getLocations(run.id), scores: run.status === 'complete' ? scoresFor(db, run) : null };
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
    const occurrences = db.getOccurrences(runId, ticket.ticketId).map((o) => ({
      id: o.id,
      url: locations.get(o.locationId)?.url ?? '',
      screen: locations.get(o.locationId)?.kind === 'state' ? locations.get(o.locationId)!.title : null,
      viewport: o.viewport,
      selector: o.selector,
      html: o.html,
      crop: o.crop,
      failureSummary: findings.get(o.rawFindingId)?.failureSummary ?? null,
    }));
    const helpUrl = db.getRawFindings(runId).find((f) => f.ticketId === ticket.ticketId)?.helpUrl ?? null;
    return { ...ticket, helpUrl, occurrenceList: occurrences };
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

  app.get('/api/settings', async () => ({ ...getSettings(db), hasLogo: existsSync(logoPath(dataDir)), exploreDefaults: { denyLabels: DEFAULT_DENY_LABELS } }));

  app.put<{ Body: PregoSettings }>('/api/settings', { schema: settingsSchema }, async (request, reply) => {
    const unknown = request.body.defaults.viewports.filter((v) => !isProfileName(v));
    if (unknown.length) return reply.code(400).send({ error: `Unknown viewport: ${unknown.join(', ')}` });
    if (!CSV_PRESETS[request.body.defaults.csvPreset]) return reply.code(400).send({ error: 'Unknown CSV preset' });
    if (request.body.defaults.checks && unknownChecks(request.body.defaults.checks).length) return reply.code(400).send({ error: 'Unknown check' });
    saveSettings(db, { ...request.body, branding: { ...request.body.branding, accentColour: request.body.branding.accentColour.replace(/^#/, '').toUpperCase() } });
    return { ...getSettings(db), hasLogo: existsSync(logoPath(dataDir)) };
  });

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
    const shots = join(record.dir, 'screenshots');
    if (existsSync(shots)) for (const file of readdirSync(shots)) folder.file(`screenshots/${file}`, readFileSync(join(shots, file)));
    return reply
      .type('application/zip')
      .header('Content-Disposition', `attachment; filename="${name}.zip"`)
      .send(zip.generateNodeStream({ type: 'nodebuffer', streamFiles: true, compression: 'DEFLATE' }));
  });

  // The Word report as HTML, for previewing before export.
  app.get<{ Params: { id: string } }>('/api/runs/:id/report-preview', async (request, reply) => {
    const runId = Number(request.params.id);
    const run = db.getRun(runId);
    if (!run) return reply.code(404).send({ error: 'Run not found' });
    if (run.status !== 'complete') return reply.code(409).send({ error: 'Only finished audits have a report.' });
    const plan = buildExportPlan(db, runId);
    const stateMap =
      run.mode === 'explore'
        ? await stateMapPng(stateMapStates(plan), plan.edges.map((e) => ({ from: e.fromLocationId, to: e.toLocationId, label: e.step.label, outcome: e.outcome })))
        : undefined;
    const docx = await reportDocx(plan, runDirectory(dataDir, runId), reportBranding(db, dataDir), { stateMap });
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
    const states = db
      .getLocations(runId)
      .filter((l) => l.kind === 'state')
      .map((l) => ({
        id: l.id,
        stateId: l.stateId,
        title: l.title,
        depth: l.depth,
        steps: l.steps ?? [],
        screenshot: l.screenshots[firstViewport] ?? Object.values(l.screenshots)[0] ?? null,
        tickets: [...(ticketsByLocation.get(l.id) ?? [])].map((id) => {
          const t = tickets.get(id)!;
          return { ticketId: t.ticketId, title: t.title, severity: t.severity, category: t.category };
        }),
      }));
    const edges = db.getEdges(runId).map((e) => ({ from: e.fromLocationId, to: e.toLocationId, label: e.step.label, outcome: e.outcome, reason: e.reason }));
    return { states, edges };
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
    await app.register(fastifyStatic, { root: resolve(options.webDist), wildcard: false });
    // Client-side routes (e.g. /runs/3) all load the app.
    app.setNotFoundHandler((request, reply) => {
      if (request.method === 'GET' && !request.url.startsWith('/api/')) return reply.sendFile('index.html');
      return reply.code(404).send({ error: 'Not found' });
    });
  }

  return { app, jobs };
}

const EXPORT_FILES: Record<string, string> = {
  'report.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  'tickets.csv': 'text/csv; charset=utf-8',
  'occurrences.csv': 'text/csv; charset=utf-8',
  'run.json': 'application/json',
  'state-map.png': 'image/png',
};

function exportSummary(record: ExportRecord) {
  const shots = join(record.dir, 'screenshots');
  return {
    id: record.id,
    runId: record.runId,
    name: basename(record.dir),
    folder: record.dir,
    preset: record.preset,
    createdAt: record.createdAt,
    files: Object.keys(EXPORT_FILES).filter((f) => existsSync(join(record.dir, f))),
    screenshots: existsSync(shots) ? readdirSync(shots).length : 0,
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
    },
  },
} as const;

function runSummary(run: Run) {
  return { id: run.id, projectId: run.projectId, mode: run.mode, target: run.target, status: run.status, startedAt: run.startedAt, finishedAt: run.finishedAt, summary: run.summary, error: run.error };
}

/** Score per checked category for a finished run, ignoring dismissed tickets. */
export function scoresFor(db: PregoDb, run: Run): Partial<Record<Category, number>> {
  const checked = checkedCategories(run.settings);
  const tickets = db.getTickets(run.id).filter((t) => t.status !== 'Dismissed' && t.status !== 'Needs review');
  const scores: Partial<Record<Category, number>> = {};
  for (const category of CATEGORIES) {
    if (!checked.has(category)) continue;
    const lighthouse = category === 'PERF' ? averagePerformance(db.getLocations(run.id)) : null;
    scores[category] = lighthouse ?? categoryScore(tickets.filter((t) => t.category === category).map((t) => t.severity));
  }
  return scores;
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
