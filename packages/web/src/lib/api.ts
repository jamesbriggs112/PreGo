import type { Category, Location, Priority, Project, Run, Severity, Ticket } from '@prego/core/types';

export type RunSummary = Pick<Run, 'id' | 'projectId' | 'mode' | 'target' | 'status' | 'startedAt' | 'finishedAt' | 'summary' | 'error'>;
export type Scores = Partial<Record<Category, number>>;

export interface ProjectListItem extends Project {
  lastRun: RunSummary | null;
  scores: Scores | null;
}

export interface ProjectDetail extends Project {
  runs: RunSummary[];
}

export interface RunDetail extends RunSummary {
  project: Project;
  settings: Record<string, unknown>;
  locations: Location[];
  scores: Scores | null;
}

export interface ApiTicket extends Ticket {
  /** Pages (URLs) the ticket's occurrences are on. */
  pages: string[];
}

export interface TicketOccurrence {
  id: number;
  url: string;
  viewport: string;
  selector: string;
  html: string;
  crop: string | null;
  failureSummary: string | null;
}

export interface TicketDetail extends Ticket {
  helpUrl: string | null;
  occurrenceList: TicketOccurrence[];
}

export interface TicketChanges {
  title?: string | null;
  severity?: Severity | null;
  priority?: Priority | null;
  auditorNotes?: string | null;
  dismissed?: boolean;
}

export interface StartRunBody {
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

export class ApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly body: Record<string, unknown>,
  ) {
    super(message);
  }
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(path, {
    ...init,
    headers: init?.body ? { 'Content-Type': 'application/json', ...init.headers } : init?.headers,
  });
  const body = response.status === 204 ? null : await response.json().catch(() => null);
  if (!response.ok) throw new ApiError(body?.error ?? `Request failed (${response.status})`, response.status, body ?? {});
  return body as T;
}

const post = <T>(path: string, body: unknown = {}) => request<T>(path, { method: 'POST', body: JSON.stringify(body) });

export const api = {
  projects: () => request<ProjectListItem[]>('/api/projects'),
  project: (id: number) => request<ProjectDetail>(`/api/projects/${id}`),
  createProject: (name: string) => post<Project>('/api/projects', { name }),
  startRun: (body: StartRunBody) => post<{ runId: number; projectId: number }>('/api/runs', body),
  activeRun: () => request<{ runId: number; projectId: number } | null>('/api/runs/active'),
  run: (id: number) => request<RunDetail>(`/api/runs/${id}`),
  stopRun: (id: number) => post<{ stopping: boolean }>(`/api/runs/${id}/stop`),
  tickets: (runId: number) => request<ApiTicket[]>(`/api/runs/${runId}/tickets`),
  ticket: (runId: number, ticketId: string) => request<TicketDetail>(`/api/runs/${runId}/tickets/${encodeURIComponent(ticketId)}`),
  updateTicket: (runId: number, ticketId: string, changes: TicketChanges) =>
    request<Ticket>(`/api/runs/${runId}/tickets/${encodeURIComponent(ticketId)}`, { method: 'PATCH', body: JSON.stringify(changes) }),
  mergeTickets: (runId: number, into: string, from: string[]) => post<Ticket>(`/api/runs/${runId}/tickets/merge`, { into, from }),
};

export const fileUrl = (runId: number, path: string) => `/api/runs/${runId}/files/${path.split(/[\\/]/).map(encodeURIComponent).join('/')}`;
