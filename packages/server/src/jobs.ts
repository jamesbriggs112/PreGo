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

  /** Start an audit. Resolves with the job once its run exists in the database. */
  start(options: Omit<AuditOptions, 'dataDir' | 'signal' | 'onEvent'>): Promise<Job> {
    if (this.activeJob) return Promise.reject(new AuditInProgressError(this.activeJob.runId));
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
          markStarted(job);
        }
        emit(event);
      },
    });

    const finished = audit.then(
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
    const job = this.activeJob;
    if (job) {
      job.controller.abort();
      await job.done;
    }
  }
}
