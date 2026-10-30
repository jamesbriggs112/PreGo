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
    const buffered: JobEvent[] = [];
    let job: Job | undefined;

    return new Promise<Job>((resolve, reject) => {
      const emit = (event: JobEvent) => {
        if (!job) {
          buffered.push(event);
          return;
        }
        job.events.push(event);
        for (const listener of job.listeners) listener(event);
      };

      const audit = runAudit(this.db, {
        ...options,
        dataDir: this.dataDir,
        signal: controller.signal,
        onEvent: (event) => {
          if (event.type === 'started' && !job) {
            job = {
              runId: event.runId,
              projectId: event.projectId,
              status: 'running',
              events: buffered,
              listeners: new Set(),
              controller,
              done: Promise.resolve(),
            };
            job.done = audit.then(
              () => undefined,
              () => undefined,
            );
            this.jobs.set(job.runId, job);
            this.active = job;
            resolve(job);
          }
          emit(event);
        },
      });

      audit.then(
        ({ run }) => {
          if (!job) return reject(new Error('Audit finished without starting'));
          job.status = run.status === 'running' ? 'failed' : run.status;
          emit({ type: 'end', status: job.status, error: run.error ?? undefined });
        },
        (error: unknown) => {
          const message = error instanceof Error ? error.message : String(error);
          if (!job) return reject(error);
          job.status = 'failed';
          emit({ type: 'end', status: 'failed', error: message });
        },
      );
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
