import Database from 'better-sqlite3';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import type {
  AuditMode,
  Category,
  Location,
  Occurrence,
  Project,
  RawFinding,
  Run,
  RunStatus,
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
];

type NewRun = Pick<Run, 'projectId' | 'mode' | 'target'> & { settings?: Record<string, unknown> };
type NewLocation = Omit<Location, 'id' | 'screenshots' | 'audited' | 'notAuditedReason' | 'stateId'> &
  Partial<Pick<Location, 'screenshots' | 'audited' | 'notAuditedReason' | 'stateId'>>;
type NewRawFinding = Omit<RawFinding, 'id' | 'crop' | 'fingerprint' | 'ticketId'> &
  Partial<Pick<RawFinding, 'crop' | 'fingerprint' | 'ticketId'>>;
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
    return { id: Number(lastInsertRowid), name, slug, createdAt };
  }

  getProject(id: number): Project | undefined {
    return this.sqlite.prepare('SELECT * FROM projects WHERE id = ?').get(id) as Project | undefined;
  }

  getProjectBySlug(slug: string): Project | undefined {
    return this.sqlite.prepare('SELECT * FROM projects WHERE slug = ?').get(slug) as Project | undefined;
  }

  /** Find a project by name (via its slug) or create it. */
  ensureProject(name: string): Project {
    return this.getProjectBySlug(slugify(name)) ?? this.createProject(name);
  }

  listProjects(): Project[] {
    return this.sqlite.prepare('SELECT * FROM projects ORDER BY name').all() as Project[];
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

  /** The most recent finished run of the same project before this one. */
  previousRun(runId: number): Run | undefined {
    const row = this.sqlite
      .prepare(
        `SELECT * FROM runs WHERE projectId = (SELECT projectId FROM runs WHERE id = ?)
         AND id < ? AND status = 'complete' ORDER BY id DESC LIMIT 1`,
      )
      .get(runId, runId) as RunRow | undefined;
    return row && toRun(row);
  }

  finishRun(id: number, status: RunStatus, summary: Record<string, unknown> = {}, error: string | null = null) {
    this.sqlite
      .prepare('UPDATE runs SET status = ?, finishedAt = ?, summary = ?, error = ? WHERE id = ?')
      .run(status, now(), JSON.stringify(summary), error, id);
  }

  // Locations

  addLocation(location: NewLocation): Location {
    const { lastInsertRowid } = this.sqlite
      .prepare(
        `INSERT INTO locations (runId, kind, url, stateId, title, statusCode, depth, templateKey,
           structureHash, audited, notAuditedReason, screenshots)
         VALUES (@runId, @kind, @url, @stateId, @title, @statusCode, @depth, @templateKey,
           @structureHash, @audited, @notAuditedReason, @screenshots)`,
      )
      .run({
        stateId: null,
        notAuditedReason: null,
        ...location,
        audited: location.audited ? 1 : 0,
        screenshots: JSON.stringify(location.screenshots ?? {}),
      });
    return this.getLocation(Number(lastInsertRowid))!;
  }

  updateLocation(id: number, changes: Partial<Omit<Location, 'id' | 'runId'>>) {
    const entries = Object.entries(changes).map(([key, value]): [string, unknown] => {
      if (key === 'audited') return [key, value ? 1 : 0];
      if (key === 'screenshots') return [key, JSON.stringify(value)];
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

  // Raw findings

  addRawFinding(finding: NewRawFinding): RawFinding {
    const { lastInsertRowid } = this.sqlite
      .prepare(
        `INSERT INTO raw_findings (runId, locationId, viewport, module, engine, ruleId, category, severity,
           title, description, helpUrl, wcagCriteria, wcagLevel, selector, html, failureSummary, crop,
           fingerprint, ticketId)
         VALUES (@runId, @locationId, @viewport, @module, @engine, @ruleId, @category, @severity,
           @title, @description, @helpUrl, @wcagCriteria, @wcagLevel, @selector, @html, @failureSummary, @crop,
           @fingerprint, @ticketId)`,
      )
      .run({
        crop: null,
        fingerprint: null,
        ticketId: null,
        ...finding,
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

  /** The run in which a ticket was first seen, from the registry. */
  ticketFirstSeenRun(projectId: number, ticketId: string): number | undefined {
    const row = this.sqlite
      .prepare('SELECT firstSeenRunId FROM ticket_registry WHERE projectId = ? AND ticketId = ?')
      .get(projectId, ticketId) as { firstSeenRunId: number } | undefined;
    return row?.firstSeenRunId;
  }

  // Tickets

  saveTicket(ticket: Ticket) {
    this.sqlite
      .prepare(
        `INSERT OR REPLACE INTO tickets (runId, ticketId, fingerprint, category, title, severity, priority, status,
           wcagCriterion, wcagLevel, ruleId, engine, templateKey, occurrences, locationsAffected, exampleLocation,
           exampleSelector, description, whyItMatters, stepsToReproduce, expected, actual, recommendation, effort,
           labels, auditorNotes, firstSeen, lastSeen)
         VALUES (@runId, @ticketId, @fingerprint, @category, @title, @severity, @priority, @status,
           @wcagCriterion, @wcagLevel, @ruleId, @engine, @templateKey, @occurrences, @locationsAffected, @exampleLocation,
           @exampleSelector, @description, @whyItMatters, @stepsToReproduce, @expected, @actual, @recommendation, @effort,
           @labels, @auditorNotes, @firstSeen, @lastSeen)`,
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
type RunRow = Omit<Run, 'settings' | 'summary' | 'mode' | 'status'> & {
  mode: string;
  status: string;
  settings: string;
  summary: string;
};
type LocationRow = Omit<Location, 'audited' | 'screenshots' | 'kind'> & { kind: string; audited: number; screenshots: string };
type RawFindingRow = Omit<RawFinding, 'wcagCriteria'> & { wcagCriteria: string };
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
});
const toRawFinding = (row: RawFindingRow): RawFinding => ({ ...row, wcagCriteria: JSON.parse(row.wcagCriteria) });
const toTicket = (row: TicketRow): Ticket => ({ ...row, labels: JSON.parse(row.labels) });

const LOCATION_COLUMNS = new Set([
  'kind', 'url', 'stateId', 'title', 'statusCode', 'depth', 'templateKey', 'structureHash', 'audited',
  'notAuditedReason', 'screenshots',
]);
function assertColumn(key: string): string {
  if (!LOCATION_COLUMNS.has(key)) throw new Error(`Unknown location column: ${key}`);
  return key;
}
