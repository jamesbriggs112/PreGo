import { copyFileSync, existsSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import Database from 'better-sqlite3';
import { PregoDb } from '../db/database.js';
import { buildTickets } from '../tickets/build.js';
import { getSettings, logoPath, saveSettings, type PregoSettings } from '../settings.js';
import { exportRun, type ExportResult } from './bundle.js';
import { CLIENT_FILE, DEFAULT_REPORT_OPTIONS, parseReportOptions, type ReportOptions } from './report-options.js';
import type { Location, Project, RawFinding, Run } from '../types.js';
import { looksLikeFeed } from '../crawl/crawler.js';
import { duplicatePages, pageType } from '../crawl/pages.js';

/** The parts of an export's run.json needed to rebuild its tickets. */
export interface RunJson {
  project: Pick<Project, 'name'>;
  run: Pick<Run, 'mode' | 'target' | 'settings' | 'summary'>;
  locations: Location[];
  rawFindings: RawFinding[];
}

/**
 * A saved run as a fresh audit with the current crawler and checks would see it: copies of the same
 * page merged, later pages of lists and feeds not audited, and file links, keyboard traps on players
 * and frames left out. Spelling can't be re-read from a saved run, so it stays as it was.
 */
export function asFreshAudit(json: RunJson): RunJson {
  const pages = json.locations.filter((l) => l.kind === 'page' && l.audited).sort((a, b) => a.depth - b.depth || a.id - b.id);
  const copies = duplicatePages(pages.map((l) => ({ url: l.url, canonical: (l.metrics.sharing as { canonical?: string | null } | undefined)?.canonical ?? null })));
  const dropped = new Set([...copies.keys()].map((i) => pages[i].id));
  for (const l of json.locations) if (looksLikeFeed(l.url)) dropped.add(l.id);
  const unaudited = new Set(json.locations.filter((l) => l.audited && pageType(l.url) === 'pagination').map((l) => l.id));
  return {
    ...json,
    locations: json.locations
      .filter((l) => !dropped.has(l.id))
      .map((l) => (unaudited.has(l.id) ? { ...l, audited: false, notAuditedReason: 'A later page of a list: its links were checked, but it wasn’t audited' } : l)),
    rawFindings: json.rawFindings.filter(
      (f) =>
        !dropped.has(f.locationId) &&
        !unaudited.has(f.locationId) &&
        !(f.ruleId === 'broken-link' && /download is starting/i.test(f.failureSummary ?? '')) &&
        !(f.ruleId === 'element-required-attributes' && /<iframe> is missing required "title"/.test(f.title)) &&
        !(['keyboard-trap', 'focus-not-visible'].includes(f.ruleId) && /^<(iframe|video|audio|object|embed)\b/i.test(f.html)),
    ),
  };
}

/**
 * Load an exported run.json into a database as a new run, so its tickets and scores can be rebuilt
 * with the current rules without crawling the site again. Used to check accuracy changes against real
 * audits. Screenshots aren't restored. Returns the new run's ID.
 */
export function restoreRun(db: PregoDb, json: RunJson, projectName = json.project.name): number {
  const project = db.ensureProject(projectName);
  const run = db.createRun({ projectId: project.id, mode: json.run.mode, target: json.run.target, settings: json.run.settings });
  db.transaction(() => {
    const ids = new Map<number, number>();
    for (const l of json.locations) {
      const added = db.addLocation({
        runId: run.id,
        kind: l.kind,
        url: l.url,
        stateId: l.stateId,
        title: l.title,
        statusCode: l.statusCode,
        depth: l.depth,
        templateKey: l.templateKey,
        structureHash: l.structureHash,
        audited: l.audited,
        notAuditedReason: l.notAuditedReason,
        steps: l.steps,
      });
      db.updateLocation(added.id, { metrics: l.metrics });
      ids.set(l.id, added.id);
    }
    for (const f of json.rawFindings) {
      const { id: _id, fingerprint: _fp, ticketId: _ticket, crop: _crop, ...rest } = f;
      const locationId = ids.get(f.locationId);
      if (locationId !== undefined) db.addRawFinding({ ...rest, runId: run.id, locationId });
    }
  });
  db.finishRun(run.id, 'complete', json.run.summary);
  return run.id;
}

/** A run.json from an export, with the reports that export included. */
export type ExportedRunJson = RunJson & { reports?: string[] };

export interface ReExportOptions {
  /** Treat the saved run as a fresh audit with the current crawler and checks would see it (see `asFreshAudit`). */
  fresh?: boolean;
  /** Branding and defaults to use, e.g. the desktop app's saved settings. */
  settings?: PregoSettings;
  /** A logo file for the reports. */
  logo?: string;
  /** The report options saved for the original run; otherwise worked out from the files the export had. */
  reportOptions?: ReportOptions;
}

/**
 * Rebuild an exported run's tickets and reports with the current rules, into `outDir`, without
 * crawling the site again and without touching any Prego database: it works on a temporary copy.
 * The reports in the original export are the ones written. Screenshots aren't in run.json, so the
 * reports have none.
 */
export async function reExport(json: ExportedRunJson, outDir: string, options: ReExportOptions = {}): Promise<ExportResult> {
  const dataDir = mkdtempSync(join(tmpdir(), 'prego-reexport-'));
  const db = new PregoDb(':memory:');
  try {
    if (options.settings) saveSettings(db, options.settings);
    if (options.logo && existsSync(options.logo)) {
      mkdirSync(dirname(logoPath(dataDir)), { recursive: true });
      copyFileSync(options.logo, logoPath(dataDir));
    }
    const runId = restoreRun(db, options.fresh ? asFreshAudit(json) : json);
    buildTickets(db, runId);
    const has = (file: string) => json.reports?.includes(file) ?? false;
    db.saveReportOptions(
      runId,
      options.reportOptions ?? {
        ...DEFAULT_REPORT_OPTIONS,
        clientFacing: has(CLIENT_FILE),
        reports: { overview: has('overview.docx'), audience: has('audience.docx'), future: has('future.docx') },
      },
    );
    return await exportRun(db, runId, { dataDir, outDir, preset: getSettings(db).defaults.csvPreset });
  } finally {
    db.close();
    rmSync(dataDir, { recursive: true, force: true });
  }
}

/**
 * The report options saved in a Prego data folder for a run, read without changing anything there.
 * Only when the run there belongs to a project of the same name, so a run from elsewhere isn't mixed up.
 */
export function savedReportOptions(dataDir: string, json: ExportedRunJson & { run: { id?: number } }): ReportOptions | undefined {
  const file = join(dataDir, 'prego.sqlite');
  if (!existsSync(file) || json.run.id === undefined) return undefined;
  const sqlite = new Database(file, { readonly: true, fileMustExist: true });
  try {
    const row = sqlite
      .prepare('SELECT o.options FROM report_options o JOIN runs r ON r.id = o.runId JOIN projects p ON p.id = r.projectId WHERE o.runId = ? AND p.name = ?')
      .get(json.run.id, json.project.name) as { options: string } | undefined;
    return row ? parseReportOptions(JSON.parse(row.options)) : undefined;
  } finally {
    sqlite.close();
  }
}

/**
 * The branding and defaults saved in a Prego data folder (such as the desktop app's), read without
 * changing anything there, plus its logo if there is one. Null when there's no database.
 */
export function savedSettings(dataDir: string): { settings: PregoSettings; logo?: string } | null {
  const file = join(dataDir, 'prego.sqlite');
  if (!existsSync(file)) return null;
  const sqlite = new Database(file, { readonly: true, fileMustExist: true });
  try {
    const row = sqlite.prepare("SELECT value FROM settings WHERE key = 'settings'").get() as { value: string } | undefined;
    const temp = new PregoDb(':memory:');
    if (row) temp.setSetting('settings', JSON.parse(row.value));
    const settings = getSettings(temp);
    temp.close();
    return { settings, logo: existsSync(logoPath(dataDir)) ? logoPath(dataDir) : undefined };
  } finally {
    sqlite.close();
  }
}
