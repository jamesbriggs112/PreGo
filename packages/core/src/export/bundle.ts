import { copyFileSync, existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import type { PregoDb } from '../db/database.js';
import { runDirectory } from '../audit/run-audit.js';
import { defaultDataDir } from '../paths.js';
import { buildExportPlan, type ExportPlan } from './plan.js';
import { writeCsvFiles } from './csv.js';
import { writeReportDocx, type ReportBranding } from './docx.js';

export interface ExportOptions {
  dataDir?: string;
  /** Write here instead of data/exports/{project}-{date}/. */
  outDir?: string;
  /** CSV column preset: prego (default), jira, linear or trello. */
  preset?: string;
  branding?: ReportBranding;
}

export interface ExportResult {
  dir: string;
  files: { report: string; tickets: string; occurrences: string; screenshots: string; runJson: string };
  plan: ExportPlan;
}

/**
 * Write the export bundle for a run: report.docx, tickets.csv, occurrences.csv, screenshots/ and
 * run.json, all in one folder and cross-referenced by ticket ID.
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
    screenshots: join(dir, 'screenshots'),
    runJson: join(dir, 'run.json'),
  };
  mkdirSync(files.screenshots, { recursive: true });

  for (const [name, source] of plan.screenshots) copyFileSync(join(runDir, source), join(files.screenshots, name));
  writeCsvFiles(plan, files, options.preset);
  await writeReportDocx(plan, runDir, files.report, options.branding);
  writeFileSync(
    files.runJson,
    JSON.stringify(
      {
        generatedBy: 'Prego',
        exportedAt: new Date().toISOString(),
        project: plan.project,
        run: plan.run,
        locations: plan.locations,
        tickets: plan.tickets.map(({ occurrenceList, ...ticket }) => ({
          ...ticket,
          occurrences: occurrenceList.map(({ location, ...o }) => ({ ...o, url: location.url })),
        })),
        rawFindings: db.getRawFindings(runId),
      },
      null,
      2,
    ),
  );
  return { dir, files, plan };
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
