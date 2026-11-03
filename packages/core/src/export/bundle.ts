import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import type { PregoDb } from '../db/database.js';
import { runDirectory } from '../audit/run-audit.js';
import { defaultDataDir } from '../paths.js';
import { buildExportPlan, stateMapStates, type ExportPlan } from './plan.js';
import { stateMapPng } from './state-map-image.js';
import { writeCsvFiles } from './csv.js';
import { writeReportDocx, type ReportBranding } from './docx.js';
import { getSettings, reportBranding } from '../settings.js';

export interface ExportOptions {
  dataDir?: string;
  /** Write here instead of data/exports/{project}-{date}/. */
  outDir?: string;
  /** CSV column preset: prego, jira, linear or trello. Defaults to the saved setting. */
  preset?: string;
  /** Defaults to the saved branding settings and logo. */
  branding?: ReportBranding;
}

export interface ExportResult {
  /** The export's ID in the exports log. */
  id: number;
  dir: string;
  files: { report: string; tickets: string; occurrences: string; runJson: string };
  plan: ExportPlan;
}

/**
 * Write the export bundle for a run: report.docx, tickets.csv, occurrences.csv and run.json, all in
 * one folder and cross-referenced by ticket ID. Screenshots go into the report and nowhere else: once
 * it's written, the run's screenshots are deleted from Prego.
 */
export async function exportRun(db: PregoDb, runId: number, options: ExportOptions = {}): Promise<ExportResult> {
  const dataDir = resolve(options.dataDir ?? defaultDataDir());
  const plan = buildExportPlan(db, runId);
  const runDir = runDirectory(dataDir, runId);
  const dir = options.outDir ? resolve(options.outDir) : uniqueDir(join(dataDir, 'exports', `${plan.project.slug}-${stamp(new Date())}`));
  const files = {
    report: join(dir, 'report.docx'),
    tickets: join(dir, 'tickets.csv'),
    occurrences: join(dir, 'occurrences.csv'),
    runJson: join(dir, 'run.json'),
  };
  mkdirSync(dir, { recursive: true });

  const preset = options.preset ?? getSettings(db).defaults.csvPreset;
  writeCsvFiles(plan, files, preset);
  // Interactive audits get a state map diagram, in the report and as its own file.
  let stateMap: Buffer | undefined;
  if (plan.run.mode === 'explore') {
    stateMap = await stateMapPng(stateMapStates(plan), plan.edges.map((e) => ({ from: e.fromLocationId, to: e.toLocationId, label: e.step.label, outcome: e.outcome })));
    writeFileSync(join(dir, 'state-map.png'), stateMap);
  }
  await writeReportDocx(plan, runDir, files.report, options.branding ?? reportBranding(db, dataDir), { stateMap });
  writeFileSync(
    files.runJson,
    JSON.stringify(
      {
        generatedBy: 'Prego',
        exportedAt: new Date().toISOString(),
        project: plan.project,
        run: plan.run,
        locations: plan.locations,
        tickets: plan.tickets.map(({ occurrenceList, screenshotFile: _file, ...ticket }) => ({
          ...ticket,
          occurrences: occurrenceList.map(({ location, crop: _crop, screenshotFile: _shot, ...o }) => ({ ...o, url: location.url })),
        })),
        rawFindings: db.getRawFindings(runId),
      },
      null,
      2,
    ),
  );
  const record = db.addExport(runId, dir, preset);
  deleteRunImages(dataDir, runId);
  return { id: record.id, dir, files, plan };
}

/** Delete a run's screenshots and crops. Exporting does this once the report holds them. */
export function deleteRunImages(dataDir: string, runId: number) {
  const runDir = runDirectory(dataDir, runId);
  for (const folder of ['screenshots', 'crops']) rmSync(join(runDir, folder), { recursive: true, force: true });
}

/** Whether a run's screenshots have been deleted, which happens when it's first exported. */
export function runImagesDeleted(db: PregoDb, runId: number): boolean {
  return db.listExports(runId).length > 0;
}

/** YYYY-MM-DD-HHmm in local time. */
function stamp(date: Date): string {
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}-${pad(date.getHours())}${pad(date.getMinutes())}`;
}

function uniqueDir(base: string): string {
  let dir = base;
  for (let n = 2; existsSync(dir); n++) dir = `${base}-${n}`;
  return dir;
}
