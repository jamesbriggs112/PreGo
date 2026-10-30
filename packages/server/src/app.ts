import Fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest } from 'fastify';
import fastifyStatic from '@fastify/static';
import { createReadStream, existsSync, statSync } from 'node:fs';
import { extname, join, resolve, sep } from 'node:path';
import {
  CATEGORIES,
  PregoDb,
  SEVERITIES,
  TriageError,
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

export interface AppOptions {
  db: PregoDb;
  dataDir: string;
  /** Built web app to serve (packages/web/dist). Omit in development, where Vite serves it. */
  webDist?: string;
  logger?: boolean;
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
      const job = await jobs.start({
        project: body.project.trim(),
        target,
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
    const locations = new Map(db.getLocations(runId).map((l) => [l.id, l.url]));
    // Each ticket lists the pages it affects, for the page filter.
    const pagesByTicket = new Map<string, Set<string>>();
    for (const o of db.getOccurrences(runId)) {
      if (!pagesByTicket.has(o.ticketId)) pagesByTicket.set(o.ticketId, new Set());
      pagesByTicket.get(o.ticketId)!.add(locations.get(o.locationId) ?? '');
    }
    return db.getTickets(runId).map((t) => ({ ...t, pages: [...(pagesByTicket.get(t.ticketId) ?? [])] }));
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

function runSummary(run: Run) {
  return { id: run.id, projectId: run.projectId, mode: run.mode, target: run.target, status: run.status, startedAt: run.startedAt, finishedAt: run.finishedAt, summary: run.summary, error: run.error };
}

/** Score per checked category for a finished run, ignoring dismissed tickets. */
export function scoresFor(db: PregoDb, run: Run): Partial<Record<Category, number>> {
  const checked = checkedCategories(run.settings);
  const tickets = db.getTickets(run.id).filter((t) => t.status !== 'Dismissed' && t.status !== 'Needs review');
  const scores: Partial<Record<Category, number>> = {};
  for (const category of CATEGORIES) {
    if (checked.has(category)) scores[category] = categoryScore(tickets.filter((t) => t.category === category).map((t) => t.severity));
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
