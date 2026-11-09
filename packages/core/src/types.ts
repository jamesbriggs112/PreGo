// Shared data model for the audit engine. Storage (db/), checks, tickets and exports all use these.

import type { AudienceProfile } from './audience/types.js';
export type { AudienceProfile, AudienceSuggestion, PageSignals, Persona, PersonaDevice, Purpose, TaskSuccess, UserTask } from './audience/types.js';

export type Category = 'A11Y' | 'UI' | 'UX' | 'CONT' | 'PERF' | 'SEC' | 'TECH';

/** Report order for categories, also used for section numbering (4.1, 4.2, ...). */
export const CATEGORIES: readonly Category[] = ['A11Y', 'UX', 'UI', 'CONT', 'PERF', 'SEC', 'TECH'];

export const CATEGORY_NAMES: Record<Category, string> = {
  A11Y: 'Accessibility',
  UI: 'Visual consistency',
  UX: 'Usability',
  CONT: 'Content and SEO',
  PERF: 'Performance',
  SEC: 'Security',
  TECH: 'Markup and technical',
};

export type Severity = 'Critical' | 'High' | 'Medium' | 'Low';
export const SEVERITIES: readonly Severity[] = ['Critical', 'High', 'Medium', 'Low'];

export type Priority = 'P1' | 'P2' | 'P3' | 'P4';

/** Open tickets are exported; dismissed ones and AI suggestions nobody has approved are not. */
export type TicketStatus = 'Open' | 'Dismissed' | 'Needs review';

export type RunStatus = 'running' | 'complete' | 'failed' | 'stopped';

export type AuditMode = 'crawl' | 'explore' | 'journey';

/** Per-project settings remembered between audits (the explorer's denylist and masks). */
export interface ProjectSettings {
  denyLabels?: string[];
  denySelectors?: string[];
  maskSelectors?: string[];
  /** Figures from a Google Analytics export, for the report's Analytics section. */
  analytics?: AnalyticsSummary;
  /** What the site is for and who it's for: purposes, personas and their tasks. */
  audience?: AudienceProfile;
}

/** What Prego keeps from Google Analytics CSV exports. Figures only; nothing about individual people. */
export interface AnalyticsSummary {
  importedAt: string;
  /** The files the figures came from. */
  files: string[];
  /** The date range the export covers, as GA writes it, if given. */
  period: string | null;
  /** Rows of each report found, largest first: label, users (or sessions) and, where given, engagement. */
  tables: { id: 'channels' | 'devices' | 'pages' | 'countries'; title: string; measure: string; rows: { label: string; value: number; engagementSeconds?: number }[] }[];
  /** Average engagement time per active user, in seconds, if any report gave it. */
  engagementSeconds: number | null;
}

export interface Project {
  id: number;
  name: string;
  slug: string;
  createdAt: string;
  settings: ProjectSettings;
}

export interface Run {
  id: number;
  projectId: number;
  mode: AuditMode;
  target: string;
  status: RunStatus;
  startedAt: string;
  finishedAt: string | null;
  /** Audit options as given, for the report's scope section and for re-runs. */
  settings: Record<string, unknown>;
  /** Totals filled in when the run finishes. */
  summary: Record<string, unknown>;
  error: string | null;
}

/** One action on the way to an interactive screen, replayed by key. */
export interface PathStep {
  /** role|label|n: stable identity of the action on its screen. */
  key: string;
  label: string;
  role: string;
  kind: 'click' | 'fill' | 'select';
  selector: string;
}

export type EdgeOutcome = 'navigated' | 'unchanged' | 'changed' | 'external' | 'skipped' | 'limit' | 'failed';

/** What happened when an action was tried on an explored screen. */
export interface StateEdge {
  id: number;
  runId: number;
  fromLocationId: number;
  /** The screen it led to; null when it led nowhere recorded (skipped, external, limit, failed). */
  toLocationId: number | null;
  step: PathStep;
  outcome: EdgeOutcome;
  reason: string | null;
}

export interface Location {
  id: number;
  runId: number;
  kind: 'page' | 'state';
  url: string;
  /** For interactive states: hash of URL plus normalised accessibility tree. Null for pages. */
  stateId: string | null;
  title: string | null;
  statusCode: number | null;
  depth: number;
  /** Stable, human-readable key for the page's template, e.g. `/news/*`. */
  templateKey: string | null;
  /** Hash of the DOM structure used to group pages into templates. */
  structureHash: string | null;
  audited: boolean;
  /** Why the location wasn't audited, e.g. "Same template as /news/post-1.html". */
  notAuditedReason: string | null;
  /** Full-page screenshot path per viewport name, relative to the run folder. */
  screenshots: Record<string, string>;
  /** For interactive states: the actions from the start screen that reach it. */
  steps: PathStep[] | null;
  /** Measurements recorded by checks, e.g. `{ lighthouse: { performance: 87, ... } }`. */
  metrics: Record<string, unknown>;
}

/** A single result from a check module, before grouping into tickets. */
export interface RawFinding {
  id: number;
  runId: number;
  locationId: number;
  viewport: string;
  module: string;
  engine: string;
  ruleId: string;
  category: Category;
  severity: Severity;
  title: string;
  description: string;
  helpUrl: string | null;
  wcagCriteria: string[];
  wcagLevel: string | null;
  selector: string;
  html: string;
  failureSummary: string | null;
  /** Cropped, outlined image of the element, relative to the run folder. */
  crop: string | null;
  /** Tag-and-class path to the component the element sits in (see tickets/component.ts). */
  component: string | null;
  /** Whether the component is shared site-wide (top-level header, footer or navigation). */
  componentShared: boolean;
  fingerprint: string | null;
  ticketId: string | null;
}

export interface Ticket {
  runId: number;
  ticketId: string;
  fingerprint: string;
  category: Category;
  title: string;
  severity: Severity;
  priority: Priority;
  status: TicketStatus;
  wcagCriterion: string | null;
  wcagLevel: string | null;
  ruleId: string;
  engine: string;
  templateKey: string | null;
  occurrences: number;
  locationsAffected: number;
  exampleLocation: string | null;
  exampleSelector: string | null;
  description: string;
  whyItMatters: string;
  stepsToReproduce: string;
  expected: string;
  actual: string;
  recommendation: string;
  effort: string;
  labels: string[];
  auditorNotes: string;
}

export interface Occurrence {
  id: number;
  runId: number;
  ticketId: string;
  locationId: number;
  rawFindingId: number;
  viewport: string;
  selector: string;
  html: string;
  crop: string | null;
}
