import Database from 'better-sqlite3';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { parseReportOptions, type ReportOptions } from '../export/report-options.js';
import type {
  AuditMode,
  Category,
  Location,
  Occurrence,
  Priority,
  Project,
  ProjectSettings,
  RawFinding,
  Run,
  RunStatus,
  Severity,
  StateEdge,
  Ticket,
} from '../types.js';

// Bump when MIGRATIONS gains an entry. Each migration runs once, in order, inside a transaction.
const MIGRATIONS: string[] = [
  `
  CREATE TABLE projects (
    id INTEGER PRIMARY KEY,
    name TEXT NOT NULL,
    slug TEXT NOT NULL UNIQUE,
    createdAt TEXT NOT NULL
  );

  CREATE TABLE runs (
    id INTEGER PRIMARY KEY,
    projectId INTEGER NOT NULL REFERENCES projects(id),
    mode TEXT NOT NULL,
    target TEXT NOT NULL,
    status TEXT NOT NULL,
    startedAt TEXT NOT NULL,
    finishedAt TEXT,
    settings TEXT NOT NULL DEFAULT '{}',
    summary TEXT NOT NULL DEFAULT '{}',
    error TEXT
  );

  CREATE TABLE locations (
    id INTEGER PRIMARY KEY,
    runId INTEGER NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
    kind TEXT NOT NULL,
    url TEXT NOT NULL,
    stateId TEXT,
    title TEXT,
    statusCode INTEGER,
    depth INTEGER NOT NULL DEFAULT 0,
    templateKey TEXT,
    structureHash TEXT,
    audited INTEGER NOT NULL DEFAULT 0,
    notAuditedReason TEXT,
    screenshots TEXT NOT NULL DEFAULT '{}'
  );
  CREATE INDEX locations_run ON locations(runId);

  CREATE TABLE raw_findings (
    id INTEGER PRIMARY KEY,
    runId INTEGER NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
    locationId INTEGER NOT NULL REFERENCES locations(id) ON DELETE CASCADE,
    viewport TEXT NOT NULL,
    module TEXT NOT NULL,
    engine TEXT NOT NULL,
    ruleId TEXT NOT NULL,
    category TEXT NOT NULL,
    severity TEXT NOT NULL,
    title TEXT NOT NULL,
    description TEXT NOT NULL,
    helpUrl TEXT,
    wcagCriteria TEXT NOT NULL DEFAULT '[]',
    wcagLevel TEXT,
    selector TEXT NOT NULL,
    html TEXT NOT NULL,
    failureSummary TEXT,
    crop TEXT,
    fingerprint TEXT,
    ticketId TEXT
  );
  CREATE INDEX raw_findings_run ON raw_findings(runId);

  -- Maps a problem's fingerprint to its ticket ID for the life of the project, so IDs survive re-runs.
  -- Rows are never deleted, which is what stops numbers being reused.
  CREATE TABLE ticket_registry (
    projectId INTEGER NOT NULL REFERENCES projects(id),
    fingerprint TEXT NOT NULL,
    ticketId TEXT NOT NULL,
    category TEXT NOT NULL,
    number INTEGER NOT NULL,
    firstSeenRunId INTEGER NOT NULL,
    PRIMARY KEY (projectId, fingerprint),
    UNIQUE (projectId, ticketId)
  );

  -- A ticket as it stood in one run. Auditor edits are stored here too.
  CREATE TABLE tickets (
    runId INTEGER NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
    ticketId TEXT NOT NULL,
    fingerprint TEXT NOT NULL,
    category TEXT NOT NULL,
    title TEXT NOT NULL,
    severity TEXT NOT NULL,
    priority TEXT NOT NULL,
    status TEXT NOT NULL,
    wcagCriterion TEXT,
    wcagLevel TEXT,
    ruleId TEXT NOT NULL,
    engine TEXT NOT NULL,
    templateKey TEXT,
    occurrences INTEGER NOT NULL,
    locationsAffected INTEGER NOT NULL,
    exampleLocation TEXT,
    exampleSelector TEXT,
    description TEXT NOT NULL,
    whyItMatters TEXT NOT NULL,
    stepsToReproduce TEXT NOT NULL,
    expected TEXT NOT NULL,
    actual TEXT NOT NULL,
    recommendation TEXT NOT NULL,
    effort TEXT NOT NULL,
    labels TEXT NOT NULL DEFAULT '[]',
    auditorNotes TEXT NOT NULL DEFAULT '',
    firstSeen TEXT NOT NULL,
    lastSeen TEXT NOT NULL,
    PRIMARY KEY (runId, ticketId)
  );

  CREATE TABLE occurrences (
    id INTEGER PRIMARY KEY,
    runId INTEGER NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
    ticketId TEXT NOT NULL,
    locationId INTEGER NOT NULL REFERENCES locations(id) ON DELETE CASCADE,
    rawFindingId INTEGER NOT NULL REFERENCES raw_findings(id) ON DELETE CASCADE,
    viewport TEXT NOT NULL,
    selector TEXT NOT NULL,
    html TEXT NOT NULL,
    crop TEXT
  );
  CREATE INDEX occurrences_ticket ON occurrences(runId, ticketId);
  `,
  // 2: the component each finding sits in, for stable ticket fingerprints.
  `
  ALTER TABLE raw_findings ADD COLUMN component TEXT;
  ALTER TABLE raw_findings ADD COLUMN componentShared INTEGER NOT NULL DEFAULT 0;
  `,
  // 3: auditor triage, kept per project so it carries into later runs.
  `
  CREATE TABLE ticket_overrides (
    projectId INTEGER NOT NULL REFERENCES projects(id),
    ticketId TEXT NOT NULL,
    title TEXT,
    severity TEXT,
    priority TEXT,
    dismissed INTEGER NOT NULL DEFAULT 0,
    auditorNotes TEXT,
    updatedAt TEXT NOT NULL,
    PRIMARY KEY (projectId, ticketId)
  );

  CREATE TABLE ticket_merges (
    projectId INTEGER NOT NULL REFERENCES projects(id),
    fromTicketId TEXT NOT NULL,
    intoTicketId TEXT NOT NULL,
    mergedAt TEXT NOT NULL,
    PRIMARY KEY (projectId, fromTicketId)
  );
  `,
  // 4: app settings and a log of exports.
  `
  CREATE TABLE settings (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL
  );

  CREATE TABLE exports (
    id INTEGER PRIMARY KEY,
    runId INTEGER NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
    dir TEXT NOT NULL,
    preset TEXT NOT NULL,
    createdAt TEXT NOT NULL
  );
  `,
  // 5: interactive exploration: how to reach each screen, and what each action did.
  `
  ALTER TABLE locations ADD COLUMN steps TEXT;

  CREATE TABLE state_edges (
    id INTEGER PRIMARY KEY,
    runId INTEGER NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
    fromLocationId INTEGER NOT NULL REFERENCES locations(id) ON DELETE CASCADE,
    toLocationId INTEGER REFERENCES locations(id) ON DELETE CASCADE,
    step TEXT NOT NULL,
    outcome TEXT NOT NULL,
    reason TEXT
  );
  CREATE INDEX state_edges_run ON state_edges(runId);
  `,
  // 6: per-project settings (explorer denylist and masks).
  `
  ALTER TABLE projects ADD COLUMN settings TEXT NOT NULL DEFAULT '{}';
  `,
  // 7: measurements recorded by checks (Lighthouse scores).
  `
  ALTER TABLE locations ADD COLUMN metrics TEXT NOT NULL DEFAULT '{}';
  `,
  // 8: auditor approval of AI-suggested tickets.
  `
  ALTER TABLE ticket_overrides ADD COLUMN approved INTEGER NOT NULL DEFAULT 0;
  `,
  // 9: tickets belong to one audit; Prego no longer tracks them across audits.
  `
  DELETE FROM tickets WHERE status = 'Fixed';
  UPDATE tickets SET status = 'Open' WHERE status IN ('New', 'Recurring', 'Regressed');
  ALTER TABLE tickets DROP COLUMN firstSeen;
  ALTER TABLE tickets DROP COLUMN lastSeen;
  `,
  // 10: report contents chosen on the Export page (client-facing layout, optional sections, written text).
  `
  CREATE TABLE report_options (
    runId INTEGER PRIMARY KEY REFERENCES runs(id) ON DELETE CASCADE,
    options TEXT NOT NULL
  );
  `,
];

export interface ExportRecord {
  id: number;
  runId: number;
  dir: string;
  preset: string;
  createdAt: string;
}

/** Auditor changes to a ticket. Null fields keep the computed value. */
export interface TicketOverride {
  title: string | null;
  severity: Severity | null;
  priority: Priority | null;
  dismissed: boolean;
  /** An AI-suggested ticket the auditor has accepted, so it's treated (and exported) like any other. */
  approved: boolean;
  auditorNotes: string | null;
}

type NewRun = Pick<Run, 'projectId' | 'mode' | 'target'> & { settings?: Record<string, unknown> };
type NewLocation = Omit<Location, 'id' | 'screenshots' | 'audited' | 'notAuditedReason' | 'stateId' | 'steps' | 'metrics'> &
  Partial<Pick<Location, 'screenshots' | 'audited' | 'notAuditedReason' | 'stateId' | 'steps'>>;
type NewRawFinding = Omit<RawFinding, 'id' | 'crop' | 'fingerprint' | 'ticketId' | 'component' | 'componentShared'> &
  Partial<Pick<RawFinding, 'crop' | 'fingerprint' | 'ticketId' | 'component' | 'componentShared'>>;
type NewOccurrence = Omit<Occurrence, 'id'>;

const now = () => new Date().toISOString();

export function slugify(name: string): string {
  return (
    name
      .normalize('NFKD')
      .replace(/[̀-ͯ]/g, '')
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '') || 'project'
  );
}

/** SQLite storage for projects, runs, locations, findings, tickets and occurrences. */
export class PregoDb {
  readonly sqlite: Database.Database;

  constructor(path: string) {
    if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
    this.sqlite = new Database(path);
    this.sqlite.pragma('journal_mode = WAL');
    this.sqlite.pragma('foreign_keys = ON');
    this.migrate();
  }

  close() {
    this.sqlite.close();
  }

  transaction<T>(fn: () => T): T {
    return this.sqlite.transaction(fn)();
  }

  private migrate() {
    const version = this.sqlite.pragma('user_version', { simple: true }) as number;
    for (let i = version; i < MIGRATIONS.length; i++) {
      this.transaction(() => {
        this.sqlite.exec(MIGRATIONS[i]);
        this.sqlite.pragma(`user_version = ${i + 1}`);
      });
    }
  }

  // Projects

  createProject(name: string): Project {
    const base = slugify(name);
    let slug = base;
    for (let n = 2; this.getProjectBySlug(slug); n++) slug = `${base}-${n}`;
    const createdAt = now();
    const { lastInsertRowid } = this.sqlite
      .prepare('INSERT INTO projects (name, slug, createdAt) VALUES (?, ?, ?)')
      .run(name, slug, createdAt);
    return { id: Number(lastInsertRowid), name, slug, createdAt, settings: {} };
  }

  getProject(id: number): Project | undefined {
    const row = this.sqlite.prepare('SELECT * FROM projects WHERE id = ?').get(id) as ProjectRow | undefined;
    return row && toProject(row);
  }

  getProjectBySlug(slug: string): Project | undefined {
    const row = this.sqlite.prepare('SELECT * FROM projects WHERE slug = ?').get(slug) as ProjectRow | undefined;
    return row && toProject(row);
  }

  /** Find a project by name (via its slug) or create it. */
  ensureProject(name: string): Project {
    return this.getProjectBySlug(slugify(name)) ?? this.createProject(name);
  }

  listProjects(): Project[] {
    return (this.sqlite.prepare('SELECT * FROM projects ORDER BY name').all() as ProjectRow[]).map(toProject);
  }

  /**
   * Delete a project and everything recorded for it: runs (and, through them, locations, findings,
   * tickets, occurrences, state maps and the exports log), ticket numbering and triage. Returns the
   * run IDs and export folders, so the caller can remove the files that go with them.
   */
  deleteProject(id: number): { runIds: number[]; exportDirs: string[] } | undefined {
    if (!this.getProject(id)) return undefined;
    return this.transaction(() => {
      const runIds = this.listRuns(id).map((r) => r.id);
      const exportDirs = runIds.flatMap((runId) => this.listExports(runId).map((e) => e.dir));
      for (const table of ['ticket_merges', 'ticket_overrides', 'ticket_registry', 'runs']) {
        this.sqlite.prepare(`DELETE FROM ${table} WHERE projectId = ?`).run(id);
      }
      this.sqlite.prepare('DELETE FROM projects WHERE id = ?').run(id);
      return { runIds, exportDirs };
    });
  }

  saveProjectSettings(id: number, settings: ProjectSettings) {
    const merged = { ...this.getProject(id)?.settings, ...settings };
    this.sqlite.prepare('UPDATE projects SET settings = ? WHERE id = ?').run(JSON.stringify(merged), id);
  }

  // Runs

  createRun(run: NewRun): Run {
    const startedAt = now();
    const settings = run.settings ?? {};
    const { lastInsertRowid } = this.sqlite
      .prepare(
        `INSERT INTO runs (projectId, mode, target, status, startedAt, settings)
         VALUES (?, ?, ?, 'running', ?, ?)`,
      )
      .run(run.projectId, run.mode, run.target, startedAt, JSON.stringify(settings));
    return this.getRun(Number(lastInsertRowid))!;
  }

  getRun(id: number): Run | undefined {
    const row = this.sqlite.prepare('SELECT * FROM runs WHERE id = ?').get(id) as RunRow | undefined;
    return row && toRun(row);
  }

  listRuns(projectId: number): Run[] {
    const rows = this.sqlite
      .prepare('SELECT * FROM runs WHERE projectId = ? ORDER BY id')
      .all(projectId) as RunRow[];
    return rows.map(toRun);
  }

  finishRun(id: number, status: RunStatus, summary: Record<string, unknown> = {}, error: string | null = null) {
    this.sqlite
      .prepare('UPDATE runs SET status = ?, finishedAt = ?, summary = ?, error = ? WHERE id = ?')
      .run(status, now(), JSON.stringify(summary), error, id);
  }

  /**
   * Mark runs still recorded as running as failed. Call on startup: a run can only be running inside
   * the process that started it, so any left over were cut off by a crash or a restart.
   */
  failInterruptedRuns(reason: string): number {
    return this.sqlite
      .prepare("UPDATE runs SET status = 'failed', finishedAt = ?, error = ? WHERE status = 'running'")
      .run(now(), reason).changes;
  }

  // Locations

  addLocation(location: NewLocation): Location {
    const { lastInsertRowid } = this.sqlite
      .prepare(
        `INSERT INTO locations (runId, kind, url, stateId, title, statusCode, depth, templateKey,
           structureHash, audited, notAuditedReason, screenshots, steps)
         VALUES (@runId, @kind, @url, @stateId, @title, @statusCode, @depth, @templateKey,
           @structureHash, @audited, @notAuditedReason, @screenshots, @steps)`,
      )
      .run({
        stateId: null,
        notAuditedReason: null,
        ...location,
        audited: location.audited ? 1 : 0,
        screenshots: JSON.stringify(location.screenshots ?? {}),
        steps: location.steps ? JSON.stringify(location.steps) : null,
      });
    return this.getLocation(Number(lastInsertRowid))!;
  }

  updateLocation(id: number, changes: Partial<Omit<Location, 'id' | 'runId'>>) {
    const entries = Object.entries(changes).map(([key, value]): [string, unknown] => {
      if (key === 'audited') return [key, value ? 1 : 0];
      if (key === 'screenshots' || key === 'metrics') return [key, JSON.stringify(value)];
      return [key, value];
    });
    if (entries.length === 0) return;
    const sets = entries.map(([key]) => `${assertColumn(key)} = @${key}`).join(', ');
    this.sqlite.prepare(`UPDATE locations SET ${sets} WHERE id = @id`).run({ ...Object.fromEntries(entries), id });
  }

  getLocation(id: number): Location | undefined {
    const row = this.sqlite.prepare('SELECT * FROM locations WHERE id = ?').get(id) as LocationRow | undefined;
    return row && toLocation(row);
  }

  getLocations(runId: number): Location[] {
    const rows = this.sqlite
      .prepare('SELECT * FROM locations WHERE runId = ? ORDER BY id')
      .all(runId) as LocationRow[];
    return rows.map(toLocation);
  }

  // State map edges

  addEdge(edge: Omit<StateEdge, 'id'>): StateEdge {
    const { lastInsertRowid } = this.sqlite
      .prepare('INSERT INTO state_edges (runId, fromLocationId, toLocationId, step, outcome, reason) VALUES (?, ?, ?, ?, ?, ?)')
      .run(edge.runId, edge.fromLocationId, edge.toLocationId, JSON.stringify(edge.step), edge.outcome, edge.reason);
    return { ...edge, id: Number(lastInsertRowid) };
  }

  getEdges(runId: number): StateEdge[] {
    const rows = this.sqlite.prepare('SELECT * FROM state_edges WHERE runId = ? ORDER BY id').all(runId) as (Omit<StateEdge, 'step' | 'outcome'> & { step: string; outcome: string })[];
    return rows.map((r) => ({ ...r, step: JSON.parse(r.step), outcome: r.outcome as StateEdge['outcome'] }));
  }

  // Raw findings

  addRawFinding(finding: NewRawFinding): RawFinding {
    const { lastInsertRowid } = this.sqlite
      .prepare(
        `INSERT INTO raw_findings (runId, locationId, viewport, module, engine, ruleId, category, severity,
           title, description, helpUrl, wcagCriteria, wcagLevel, selector, html, failureSummary, crop,
           fingerprint, ticketId, component, componentShared)
         VALUES (@runId, @locationId, @viewport, @module, @engine, @ruleId, @category, @severity,
           @title, @description, @helpUrl, @wcagCriteria, @wcagLevel, @selector, @html, @failureSummary, @crop,
           @fingerprint, @ticketId, @component, @componentShared)`,
      )
      .run({
        crop: null,
        fingerprint: null,
        ticketId: null,
        component: null,
        ...finding,
        componentShared: finding.componentShared ? 1 : 0,
        wcagCriteria: JSON.stringify(finding.wcagCriteria),
      });
    return this.getRawFinding(Number(lastInsertRowid))!;
  }

  getRawFinding(id: number): RawFinding | undefined {
    const row = this.sqlite.prepare('SELECT * FROM raw_findings WHERE id = ?').get(id) as RawFindingRow | undefined;
    return row && toRawFinding(row);
  }

  getRawFindings(runId: number): RawFinding[] {
    const rows = this.sqlite
      .prepare('SELECT * FROM raw_findings WHERE runId = ? ORDER BY id')
      .all(runId) as RawFindingRow[];
    return rows.map(toRawFinding);
  }

  /** Remove a run's tickets and occurrences so they can be rebuilt from its raw findings. */
  clearTickets(runId: number) {
    this.sqlite.prepare('DELETE FROM occurrences WHERE runId = ?').run(runId);
    this.sqlite.prepare('DELETE FROM tickets WHERE runId = ?').run(runId);
  }

  setRawFindingTicket(id: number, fingerprint: string, ticketId: string) {
    this.sqlite.prepare('UPDATE raw_findings SET fingerprint = ?, ticketId = ? WHERE id = ?').run(fingerprint, ticketId, id);
  }

  // Ticket registry

  /** Return the project's ticket ID for this fingerprint, allocating the next number if it's new. */
  ticketIdFor(projectId: number, fingerprint: string, category: Category, runId: number): { ticketId: string; isNew: boolean } {
    const existing = this.sqlite
      .prepare('SELECT ticketId FROM ticket_registry WHERE projectId = ? AND fingerprint = ?')
      .get(projectId, fingerprint) as { ticketId: string } | undefined;
    if (existing) return { ticketId: existing.ticketId, isNew: false };
    const { next } = this.sqlite
      .prepare('SELECT COALESCE(MAX(number), 0) + 1 AS next FROM ticket_registry WHERE projectId = ? AND category = ?')
      .get(projectId, category) as { next: number };
    const ticketId = `PRG-${category}-${String(next).padStart(3, '0')}`;
    this.sqlite
      .prepare(
        `INSERT INTO ticket_registry (projectId, fingerprint, ticketId, category, number, firstSeenRunId)
         VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .run(projectId, fingerprint, ticketId, category, next, runId);
    return { ticketId, isNew: true };
  }


  // Settings

  getSetting<T>(key: string): T | undefined {
    const row = this.sqlite.prepare('SELECT value FROM settings WHERE key = ?').get(key) as { value: string } | undefined;
    return row ? (JSON.parse(row.value) as T) : undefined;
  }

  setSetting(key: string, value: unknown) {
    this.sqlite.prepare('INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)').run(key, JSON.stringify(value));
  }

  // Exports

  getReportOptions(runId: number): ReportOptions {
    const row = this.sqlite.prepare('SELECT options FROM report_options WHERE runId = ?').get(runId) as { options: string } | undefined;
    return parseReportOptions(row ? JSON.parse(row.options) : undefined);
  }

  saveReportOptions(runId: number, options: ReportOptions) {
    this.sqlite.prepare('INSERT OR REPLACE INTO report_options (runId, options) VALUES (?, ?)').run(runId, JSON.stringify(parseReportOptions(options)));
  }

  addExport(runId: number, dir: string, preset: string): ExportRecord {
    const createdAt = now();
    const { lastInsertRowid } = this.sqlite.prepare('INSERT INTO exports (runId, dir, preset, createdAt) VALUES (?, ?, ?, ?)').run(runId, dir, preset, createdAt);
    return { id: Number(lastInsertRowid), runId, dir, preset, createdAt };
  }

  getExport(id: number): ExportRecord | undefined {
    return this.sqlite.prepare('SELECT * FROM exports WHERE id = ?').get(id) as ExportRecord | undefined;
  }

  listExports(runId: number): ExportRecord[] {
    return this.sqlite.prepare('SELECT * FROM exports WHERE runId = ? ORDER BY id DESC').all(runId) as ExportRecord[];
  }

  // Triage

  getOverride(projectId: number, ticketId: string): TicketOverride | undefined {
    const row = this.sqlite
      .prepare('SELECT title, severity, priority, dismissed, approved, auditorNotes FROM ticket_overrides WHERE projectId = ? AND ticketId = ?')
      .get(projectId, ticketId) as (Omit<TicketOverride, 'dismissed' | 'approved'> & { dismissed: number; approved: number }) | undefined;
    return row && { ...row, dismissed: row.dismissed === 1, approved: row.approved === 1 };
  }

  /** Merge changes into a ticket's saved triage. `null` clears a field back to the computed value. */
  saveOverride(projectId: number, ticketId: string, changes: Partial<TicketOverride>) {
    const merged = { title: null, severity: null, priority: null, dismissed: false, approved: false, auditorNotes: null, ...this.getOverride(projectId, ticketId), ...changes };
    this.sqlite
      .prepare(
        `INSERT OR REPLACE INTO ticket_overrides (projectId, ticketId, title, severity, priority, dismissed, approved, auditorNotes, updatedAt)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(projectId, ticketId, merged.title, merged.severity, merged.priority, merged.dismissed ? 1 : 0, merged.approved ? 1 : 0, merged.auditorNotes, now());
  }

  addMerge(projectId: number, fromTicketId: string, intoTicketId: string) {
    this.sqlite
      .prepare('INSERT OR REPLACE INTO ticket_merges (projectId, fromTicketId, intoTicketId, mergedAt) VALUES (?, ?, ?, ?)')
      .run(projectId, fromTicketId, intoTicketId, now());
  }

  /** Follow merges to the ticket this one now lives in (itself if never merged). */
  resolveMerge(projectId: number, ticketId: string): string {
    const seen = new Set<string>();
    let current = ticketId;
    const lookup = this.sqlite.prepare('SELECT intoTicketId FROM ticket_merges WHERE projectId = ? AND fromTicketId = ?');
    for (;;) {
      const row = lookup.get(projectId, current) as { intoTicketId: string } | undefined;
      if (!row || seen.has(row.intoTicketId)) return current;
      seen.add(current);
      current = row.intoTicketId;
    }
  }

  /** Move a run's occurrences and findings from one ticket to another, and drop the emptied ticket. */
  moveTicketContents(runId: number, fromTicketId: string, intoTicketId: string) {
    this.sqlite.prepare('UPDATE occurrences SET ticketId = ? WHERE runId = ? AND ticketId = ?').run(intoTicketId, runId, fromTicketId);
    this.sqlite.prepare('UPDATE raw_findings SET ticketId = ? WHERE runId = ? AND ticketId = ?').run(intoTicketId, runId, fromTicketId);
    this.sqlite.prepare('DELETE FROM tickets WHERE runId = ? AND ticketId = ?').run(runId, fromTicketId);
  }

  // Tickets

  saveTicket(ticket: Ticket) {
    this.sqlite
      .prepare(
        `INSERT OR REPLACE INTO tickets (runId, ticketId, fingerprint, category, title, severity, priority, status,
           wcagCriterion, wcagLevel, ruleId, engine, templateKey, occurrences, locationsAffected, exampleLocation,
           exampleSelector, description, whyItMatters, stepsToReproduce, expected, actual, recommendation, effort,
           labels, auditorNotes)
         VALUES (@runId, @ticketId, @fingerprint, @category, @title, @severity, @priority, @status,
           @wcagCriterion, @wcagLevel, @ruleId, @engine, @templateKey, @occurrences, @locationsAffected, @exampleLocation,
           @exampleSelector, @description, @whyItMatters, @stepsToReproduce, @expected, @actual, @recommendation, @effort,
           @labels, @auditorNotes)`,
      )
      .run({ ...ticket, labels: JSON.stringify(ticket.labels) });
  }

  getTicket(runId: number, ticketId: string): Ticket | undefined {
    const row = this.sqlite
      .prepare('SELECT * FROM tickets WHERE runId = ? AND ticketId = ?')
      .get(runId, ticketId) as TicketRow | undefined;
    return row && toTicket(row);
  }

  getTickets(runId: number): Ticket[] {
    const rows = this.sqlite
      .prepare('SELECT * FROM tickets WHERE runId = ? ORDER BY ticketId')
      .all(runId) as TicketRow[];
    return rows.map(toTicket);
  }

  // Occurrences

  addOccurrence(occurrence: NewOccurrence): Occurrence {
    const { lastInsertRowid } = this.sqlite
      .prepare(
        `INSERT INTO occurrences (runId, ticketId, locationId, rawFindingId, viewport, selector, html, crop)
         VALUES (@runId, @ticketId, @locationId, @rawFindingId, @viewport, @selector, @html, @crop)`,
      )
      .run(occurrence);
    return { ...occurrence, id: Number(lastInsertRowid) };
  }

  getOccurrences(runId: number, ticketId?: string): Occurrence[] {
    return ticketId
      ? (this.sqlite
          .prepare('SELECT * FROM occurrences WHERE runId = ? AND ticketId = ? ORDER BY id')
          .all(runId, ticketId) as Occurrence[])
      : (this.sqlite.prepare('SELECT * FROM occurrences WHERE runId = ? ORDER BY ticketId, id').all(runId) as Occurrence[]);
  }
}

// Row types are what SQLite returns: JSON as text, booleans as integers.
type ProjectRow = Omit<Project, 'settings'> & { settings: string };
const toProject = (row: ProjectRow): Project => ({ ...row, settings: JSON.parse(row.settings) });
type RunRow = Omit<Run, 'settings' | 'summary' | 'mode' | 'status'> & {
  mode: string;
  status: string;
  settings: string;
  summary: string;
};
type LocationRow = Omit<Location, 'audited' | 'screenshots' | 'kind' | 'steps' | 'metrics'> & { kind: string; audited: number; screenshots: string; steps: string | null; metrics: string };
type RawFindingRow = Omit<RawFinding, 'wcagCriteria' | 'componentShared'> & { wcagCriteria: string; componentShared: number };
type TicketRow = Omit<Ticket, 'labels'> & { labels: string };

const toRun = (row: RunRow): Run => ({
  ...row,
  mode: row.mode as AuditMode,
  status: row.status as RunStatus,
  settings: JSON.parse(row.settings),
  summary: JSON.parse(row.summary),
});
const toLocation = (row: LocationRow): Location => ({
  ...row,
  kind: row.kind as Location['kind'],
  audited: row.audited === 1,
  screenshots: JSON.parse(row.screenshots),
  steps: row.steps ? JSON.parse(row.steps) : null,
  metrics: JSON.parse(row.metrics ?? '{}'),
});
const toRawFinding = (row: RawFindingRow): RawFinding => ({
  ...row,
  wcagCriteria: JSON.parse(row.wcagCriteria),
  componentShared: row.componentShared === 1,
});
const toTicket = (row: TicketRow): Ticket => ({ ...row, labels: JSON.parse(row.labels) });

const LOCATION_COLUMNS = new Set([
  'kind', 'url', 'stateId', 'title', 'statusCode', 'depth', 'templateKey', 'structureHash', 'audited',
  'notAuditedReason', 'screenshots', 'metrics',
]);
function assertColumn(key: string): string {
  if (!LOCATION_COLUMNS.has(key)) throw new Error(`Unknown location column: ${key}`);
  return key;
}
