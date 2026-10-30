import type { Category, Location, Priority, Project, Run, Severity, Ticket } from '@prego/core/types';

export type RunSummary = Pick<Run, 'id' | 'projectId' | 'mode' | 'target' | 'status' | 'startedAt' | 'finishedAt' | 'summary' | 'error'>;
export type Scores = Partial<Record<Category, number>>;

export interface ProjectListItem extends Project {
  runCount: number;
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
  /** Pages (URLs, or "Screen: title" for interactives) the ticket's occurrences are on. */
  pages: string[];
  locationIds: number[];
}

export interface TicketOccurrence {
  id: number;
  url: string;
  /** Screen title, for interactive audits. */
  screen: string | null;
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

export interface CheckInfo {
  id: string;
  name: string;
  description: string;
  categories: string[];
  defaultOn: boolean;
  slow: boolean;
}

export interface JourneySummary {
  name: string;
  startUrl: string | null;
  recordedAt: string;
  steps: { index: number; description: string }[];
  unsupported: { statement: string; reason: string }[];
}

export interface JourneyList {
  journeys: JourneySummary[];
  recordings: { name: string; status: 'recording' | 'saved' | 'failed'; error?: string }[];
}

export interface StateMapData {
  states: {
    id: number;
    stateId: string;
    title: string;
    depth: number;
    steps: { key: string; label: string }[];
    screenshot: string | null;
    tickets: { ticketId: string; title: string; severity: Severity; category: string }[];
  }[];
  edges: { from: number; to: number | null; label: string; outcome: string; reason: string | null }[];
}

export interface ExportSummary {
  id: number;
  runId: number;
  name: string;
  folder: string;
  preset: string;
  createdAt: string;
  files: string[];
  screenshots: number;
}

export interface Settings {
  branding: { companyName: string; accentColour: string };
  defaults: { viewports: string[]; perTemplate: number; concurrency: number; delayMs: number; respectRobots: boolean; csvPreset: string; checks: string[] };
}

export interface StartRunBody {
  project: string;
  target: string;
  mode?: 'crawl' | 'explore' | 'journey';
  checks?: string[];
  journey?: string;
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
  deleteProject: (id: number) =>
    request<{ deleted: { project: string; audits: number; exports: number } }>(`/api/projects/${id}`, { method: 'DELETE' }),
  startRun: (body: StartRunBody) => post<{ runId: number; projectId: number }>('/api/runs', body),
  activeRun: () => request<{ runId: number; projectId: number } | null>('/api/runs/active'),
  run: (id: number) => request<RunDetail>(`/api/runs/${id}`),
  stopRun: (id: number) => post<{ stopping: boolean }>(`/api/runs/${id}/stop`),
  tickets: (runId: number) => request<ApiTicket[]>(`/api/runs/${runId}/tickets`),
  ticket: (runId: number, ticketId: string) => request<TicketDetail>(`/api/runs/${runId}/tickets/${encodeURIComponent(ticketId)}`),
  updateTicket: (runId: number, ticketId: string, changes: TicketChanges) =>
    request<Ticket>(`/api/runs/${runId}/tickets/${encodeURIComponent(ticketId)}`, { method: 'PATCH', body: JSON.stringify(changes) }),
  mergeTickets: (runId: number, into: string, from: string[]) => post<Ticket>(`/api/runs/${runId}/tickets/merge`, { into, from }),
  checks: () => request<CheckInfo[]>('/api/checks'),
  journeys: (projectId: number) => request<JourneyList>(`/api/projects/${projectId}/journeys`),
  recordJourney: (projectId: number, name: string, url: string) => post<{ name: string; status: string }>(`/api/projects/${projectId}/journeys/record`, { name, url }),
  stateMap: (runId: number) => request<StateMapData>(`/api/runs/${runId}/state-map`),
  exports: (runId: number) => request<ExportSummary[]>(`/api/runs/${runId}/exports`),
  createExport: (runId: number, preset: string) => post<ExportSummary>(`/api/runs/${runId}/exports`, { preset }),
  reportPreview: (runId: number) => request<{ html: string }>(`/api/runs/${runId}/report-preview`),
  settings: () => request<Settings & { hasLogo: boolean; exploreDefaults: { denyLabels: string[] } }>('/api/settings'),
  saveSettings: (settings: Settings) => request<Settings & { hasLogo: boolean }>('/api/settings', { method: 'PUT', body: JSON.stringify(settings) }),
  uploadLogo: (png: string) => request<{ hasLogo: boolean }>('/api/settings/logo', { method: 'PUT', body: JSON.stringify({ png }) }),
  removeLogo: () => request<{ hasLogo: boolean }>('/api/settings/logo', { method: 'DELETE' }),
};

export const exportFileUrl = (exportId: number, file: string) => `/api/exports/${exportId}/files/${file}`;
export const exportZipUrl = (exportId: number) => `/api/exports/${exportId}/zip`;

export const fileUrl = (runId: number, path: string) => `/api/runs/${runId}/files/${path.split(/[\\/]/).map(encodeURIComponent).join('/')}`;
