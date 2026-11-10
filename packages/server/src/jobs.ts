import { runAudit, type AuditEvent, type AuditOptions, type PregoDb } from '@prego/core';

export type JobStatus = 'running' | 'complete' | 'failed' | 'stopped';

/** What the live view receives: audit events, plus one `end` event when the job finishes. */
export type JobEvent = AuditEvent | { type: 'end'; status: JobStatus; error?: string };

export interface Job {
  runId: number;
  projectId: number;
  status: JobStatus;
  events: JobEvent[];
  listeners: Set<(event: JobEvent) => void>;
  controller: AbortController;
  done: Promise<void>;
}

/** An audit waiting for the one before it to finish. Held in memory only: closing Prego clears the queue. */
export interface QueuedAudit {
  id: number;
  project: string;
  target: string;
  queuedAt: string;
}

type StartOptions = Omit<AuditOptions, 'dataDir' | 'signal' | 'onEvent'>;

interface QueueEntry extends QueuedAudit {
  options: StartOptions;
  onStart?: (job: Job) => void;
}

export class AuditInProgressError extends Error {
  constructor(readonly runId: number) {
    super(`Audit ${runId} is still running. Wait for it to finish or stop it first.`);
  }
}

/**
 * Runs audits in the background, one at a time, and keeps each job's events so a live view that
 * connects late (or reconnects) can replay them.
 */
export class JobRunner {
  private readonly jobs = new Map<number, Job>();
  private active: Job | undefined;
  private queue: QueueEntry[] = [];
  private nextQueueId = 1;
  private closed = false;
  /** True between asking for an audit to start and its run existing. */
  private starting = false;

  constructor(
    private readonly db: PregoDb,
    private readonly dataDir: string,
  ) {}

  get(runId: number): Job | undefined {
    return this.jobs.get(runId);
  }

  get activeJob(): Job | undefined {
    return this.active?.status === 'running' ? this.active : undefined;
  }

  /** Audits waiting to start, first in line first. */
  get queued(): QueuedAudit[] {
    return this.queue.map(({ id, project, target, queuedAt }) => ({ id, project, target, queuedAt }));
  }

  /**
   * Start an audit now, or queue it if another is running. `onStart` runs when it starts, whether
   * that's now or later. Resolves with the job, or with the queue entry.
   */
  async startOrQueue(options: StartOptions, onStart?: (job: Job) => void): Promise<{ job: Job } | { queued: QueuedAudit & { position: number } }> {
    if (!this.activeJob && !this.starting && this.queue.length === 0) {
      const job = await this.start(options);
      onStart?.(job);
      return { job };
    }
    const entry: QueueEntry = { id: this.nextQueueId++, project: options.project, target: options.target, queuedAt: new Date().toISOString(), options, onStart };
    this.queue.push(entry);
    // Nothing running (the last audit finished between checks): start the first in line.
    if (!this.activeJob && !this.starting) void this.startNext();
    const { options: _o, onStart: _s, ...view } = entry;
    return { queued: { ...view, position: this.queue.indexOf(entry) + 1 } };
  }

  /** Take an audit out of the queue. False if it isn't waiting (it may have started). */
  unqueue(id: number): boolean {
    const before = this.queue.length;
    this.queue = this.queue.filter((q) => q.id !== id);
    return this.queue.length < before;
  }

  /** Drop every queued audit for a project, e.g. when it's deleted. */
  unqueueProject(name: string) {
    const key = name.trim().toLowerCase();
    this.queue = this.queue.filter((q) => q.project.trim().toLowerCase() !== key);
  }

  /** Start queued audits in order until one starts. One that can't start is dropped. */
  private async startNext() {
    while (!this.closed && !this.activeJob && !this.starting && this.queue.length) {
      const next = this.queue.shift()!;
      try {
        const job = await this.start(next.options);
        next.onStart?.(job);
        return;
      } catch {
        // It failed before its run existed (nothing to show for it): carry on with the next.
      }
    }
  }

  /** Start an audit. Resolves with the job once its run exists in the database. */
  start(options: StartOptions): Promise<Job> {
    if (this.activeJob) return Promise.reject(new AuditInProgressError(this.activeJob.runId));
    this.starting = true;
    const controller = new AbortController();
    const events: JobEvent[] = [];
    const listeners = new Set<(event: JobEvent) => void>();
    let job: Job | undefined;
    let markStarted: (job: Job) => void = () => {};
    const started = new Promise<Job>((resolve) => (markStarted = resolve));

    const emit = (event: JobEvent) => {
      events.push(event);
      for (const listener of listeners) listener(event);
    };

    // runAudit can emit 'started' synchronously, before it returns its promise (for web addresses
    // there's nothing to wait for first), so the job is created here without touching that promise.
    const audit = runAudit(this.db, {
      ...options,
      dataDir: this.dataDir,
      signal: controller.signal,
      onEvent: (event) => {
        if (event.type === 'started' && !job) {
          job = { runId: event.runId, projectId: event.projectId, status: 'running', events, listeners, controller, done: Promise.resolve() };
          this.jobs.set(job.runId, job);
          this.active = job;
          this.starting = false;
          markStarted(job);
        }
        emit(event);
      },
    });

    const finished = audit.finally(() => (this.starting = false)).then(
      ({ run }) => {
        if (!job) throw new Error('Audit finished without starting');
        job.status = run.status === 'running' ? 'failed' : run.status;
        emit({ type: 'end', status: job.status, error: run.error ?? undefined });
      },
      (error: unknown) => {
        if (!job) throw error;
        job.status = 'failed';
        emit({ type: 'end', status: 'failed', error: error instanceof Error ? error.message : String(error) });
      },
    );
    // When this audit ends, the next in the queue starts.
    void finished.then(
      () => this.startNext(),
      () => this.startNext(),
    );

    // Resolve as soon as the run exists; reject if the audit fails before that.
    return Promise.race([started, finished.then(() => started)]).then((startedJob) => {
      startedJob.done = finished.catch(() => undefined);
      return startedJob;
    });
  }

  stop(runId: number): boolean {
    const job = this.jobs.get(runId);
    if (!job || job.status !== 'running') return false;
    job.controller.abort();
    return true;
  }

  /** Stop any running audit and wait for it, e.g. on shutdown. */
  async shutdown() {
    this.closed = true;
    this.queue = [];
    const job = this.activeJob;
    if (job) {
      job.controller.abort();
      await job.done;
    }
  }
}
