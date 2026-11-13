#!/usr/bin/env node
import { Command, InvalidArgumentError, Option } from 'commander';
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { appendFileSync, readFileSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { loadScheduleConfig, type ScheduleConfig } from './config.js';
import {
  CHECK_GROUPS,
  aiSettings,
  groupChecks,
  CSV_PRESETS,
  DEFAULT_DENY_LABELS,
  checkDefinitions,
  getSettings,
  PROFILES,
  PregoDb,
  VERSION,
  defaultDataDir,
  exportRun,
  reExport,
  savedSettings,
  savedReportOptions,
  type ExportedRunJson,
  ensureJourneysDir,
  isProfileName,
  journeyFile,
  listJourneys,
  loadDummyData,
  slugify,
  runAudit,
  verifyExport,
  SEVERITIES,
  type AuditEvent,
  type ProfileName,
  type Run,
} from '@prego/core';

const program = new Command()
  .name('prego')
  .description('Automated UX, UI and accessibility audits')
  .version(VERSION)
  .option('--data-dir <path>', 'where Prego keeps its database, runs and exports', defaultDataDir());

const openDb = () => {
  const dataDir = resolve(program.opts().dataDir);
  return { dataDir, db: new PregoDb(join(dataDir, 'prego.sqlite')) };
};

const int = (value: string) => {
  const n = Number.parseInt(value, 10);
  if (Number.isNaN(n) || n < 0) throw new InvalidArgumentError('Must be a whole number.');
  return n;
};

const viewportList = (value: string): ProfileName[] => {
  const names = value.split(',').map((v) => v.trim());
  const unknown = names.filter((n) => !isProfileName(n));
  if (unknown.length) throw new InvalidArgumentError(`Unknown viewport ${unknown.join(', ')}. Choose from ${Object.keys(PROFILES).join(', ')}.`);
  return names as ProfileName[];
};

const collect = (value: string, previous: string[] = []) => [...previous, value];

program
  .command('audit')
  .description('crawl a site (or a local folder), run the checks and export the report and tickets')
  .argument('<target>', 'URL to audit, or a local folder to serve and audit')
  .option('-p, --project <name>', 'project (client or site) name; defaults to the hostname or folder name')
  .option('--viewports <list>', `comma-separated: ${Object.keys(PROFILES).join(', ')}`, viewportList, ['desktop'] as ProfileName[])
  .addOption(new Option('--mode <mode>', 'crawl a site, explore an interactive (single-page app or kiosk), or replay a recorded journey').choices(['crawl', 'explore', 'journey']).default('crawl'))
  .option('--journey <name>', 'journey mode: the recorded journey to replay (see `prego journey record`)')
  .option('--login-journey <name>', 'replay this recorded journey first to log in')
  .option('--max-pages <n>', 'maximum pages to crawl', int, 100)
  .option('--max-depth <n>', 'maximum link depth (crawl, default 10) or taps from the start (explore, default 8)', int)
  .option('--max-states <n>', 'explore: maximum screens to record', int, 200)
  .option('--mask <selector>', 'explore: ignore this element when telling screens apart, e.g. a clock (repeatable)', collect)
  .option('--deny <label>', `explore: never press actions with this label, as well as: ${DEFAULT_DENY_LABELS.join(', ')} (repeatable)`, collect)
  .option('--deny-selector <selector>', 'explore: never press elements matching this selector (repeatable)', collect)
  .option('--time-budget <minutes>', 'stop discovering pages after this many minutes', int)
  .option('--include <glob>', 'only crawl URLs matching this pattern (repeatable), e.g. /blog/**', collect)
  .option('--exclude <glob>', 'skip URLs matching this pattern (repeatable)', collect)
  .option('--ignore-robots', 'ignore robots.txt (staging sites you own only)')
  .option('--no-sitemap', "don't seed the crawl from sitemap.xml")
  .option('--per-template <n>', 'pages audited per template', int, 3)
  .option('--all', 'audit every page, not a sample per template')
  .option('--concurrency <n>', 'pages open at once', int, 2)
  .option('--delay <ms>', 'delay between page loads', int, 500)
  .option('--user <name>', 'basic auth username; the password is read from PREGO_PASSWORD')
  .addOption(new Option('--preset <name>', 'tickets.csv column preset').choices(Object.keys(CSV_PRESETS)).default('prego'))
  .option('--checks <ids>', `comma-separated checks to run (default: the defaults in Settings): ${checkDefinitions().map((d) => d.id).join(', ')}`)
  .addOption(new Option('--group <id>', 'run a test group instead of choosing checks').choices(CHECK_GROUPS.map((g) => g.id)).conflicts('checks'))
  .option('--no-export', 'store results without writing the export bundle')
  .option('-q, --quiet', 'only print the final summary')
  .action(async (target: string, opts) => {
    const { db, dataDir } = openDb();
    if (opts.user && !process.env.PREGO_PASSWORD) {
      program.error('Set the basic auth password in the PREGO_PASSWORD environment variable (it is never stored or passed on the command line).');
    }
    try {
      const outcome = await auditOnce(db, dataDir, { ...opts, target, password: process.env.PREGO_PASSWORD });
      if (!outcome) process.exitCode = 1;
    } finally {
      db.close();
    }
  });

/** Options for one audit, as `prego audit` takes them (after commander's defaults). */
interface AuditCommandOptions {
  target: string;
  project?: string;
  viewports: ProfileName[];
  mode: 'crawl' | 'explore' | 'journey';
  journey?: string;
  loginJourney?: string;
  maxPages: number;
  maxDepth?: number;
  maxStates: number;
  mask?: string[];
  deny?: string[];
  denySelector?: string[];
  timeBudget?: number;
  include?: string[];
  exclude?: string[];
  ignoreRobots?: boolean;
  sitemap: boolean;
  perTemplate: number;
  all?: boolean;
  concurrency: number;
  delay: number;
  user?: string;
  password?: string;
  preset: string;
  checks?: string | string[];
  group?: string;
  export: boolean;
  quiet?: boolean;
}

/** Run one audit and its export. Returns undefined if the audit didn't complete. */
async function auditOnce(db: PregoDb, dataDir: string, opts: AuditCommandOptions): Promise<{ run: Run; exportDir?: string } | undefined> {
  const { target } = opts;
  const project = opts.project ?? (/^https?:\/\//i.test(target) ? new URL(target).hostname : basename(resolve(target)));
  const log = (line: string) => process.stderr.write(`${line}\n`);
  const projectSlug = slugify(project);
  const findJourney = (name: string) => {
    const found = listJourneys(dataDir, projectSlug).find((j) => j.name === slugify(name));
    if (!found) program.error(`No recorded journey called "${name}" for ${project}. Record one with: prego journey record "${project}" ${name} <url>`);
    return found;
  };
  const journey = opts.mode === 'journey' ? findJourney(opts.journey ?? program.error('Journey mode needs --journey <name>.')) : undefined;
  const loginJourney = opts.loginJourney ? findJourney(opts.loginJourney) : undefined;
  const controller = new AbortController();
  const stop = () => {
    log('\nStopping after the current page…');
    controller.abort();
  };
  process.once('SIGINT', stop);
  try {
    const checks = Array.isArray(opts.checks)
      ? opts.checks
      : opts.checks
        ? opts.checks.split(',').map((c) => c.trim())
        : opts.group
          ? groupChecks(CHECK_GROUPS.find((g) => g.id === opts.group)!, checkDefinitions().filter((d) => d.id !== 'ai' || aiSettings(getSettings(db))))
          : getSettings(db).defaults.checks;
    if (checks.includes('ai') && !aiSettings(getSettings(db))) program.error('AI review is switched off. Turn it on in Settings, with Ollama running on this computer.');
    const { run } = await runAudit(db, {
      project,
      target,
      dataDir,
      ai: aiSettings(getSettings(db)),
      viewports: opts.viewports,
      mode: opts.mode,
      checks,
      journey,
      loginJourney,
      maxPages: opts.maxPages,
      maxDepth: opts.maxDepth,
      maxStates: opts.maxStates,
      maskSelectors: opts.mask,
      denyLabels: [...DEFAULT_DENY_LABELS, ...(opts.deny ?? [])],
      denySelectors: opts.denySelector,
      dummyData: loadDummyData(resolve('config/dummy-data.json')),
      timeBudgetMs: opts.timeBudget ? opts.timeBudget * 60_000 : undefined,
      include: opts.include,
      exclude: opts.exclude,
      respectRobots: !opts.ignoreRobots,
      useSitemap: opts.sitemap,
      perTemplate: opts.perTemplate,
      auditAll: opts.all,
      concurrency: opts.concurrency,
      delayMs: opts.delay,
      basicAuth: opts.user ? { username: opts.user, password: opts.password ?? '' } : undefined,
      signal: controller.signal,
      onEvent: opts.quiet ? undefined : (event) => log(describe(event)),
    });
    if (run.status !== 'complete') {
      log(`Run ${run.id} ${run.status}${run.error ? `: ${run.error}` : ''}`);
      return undefined;
    }
    const s = run.summary as Record<string, number>;
    const found =
      run.mode === 'explore'
        ? `${s.statesFound} screens found and audited`
        : run.mode === 'journey'
          ? `${s.stepsReplayed} of ${s.stepsRecorded} journey steps replayed and audited`
          : `${s.pagesFound} pages found, ${s.pagesAudited} audited`;
    console.log(`Run ${run.id} complete: ${found}, ${s.tickets} tickets from ${s.findings} findings.`);
    if (!opts.export) return { run };
    const exported = await exportRun(db, run.id, { dataDir, preset: opts.preset });
    console.log(`Export: ${exported.dir}`);
    return { run, exportDir: exported.dir };
  } finally {
    process.off('SIGINT', stop);
  }
}

program
  .command('run')
  .description('run every audit in a schedule file, for cron or CI (see docs/scheduled-audits.md)')
  .argument('<config>', 'schedule file (JSON)')
  .option('-q, --quiet', 'only print summaries')
  .action(async (path: string, opts) => {
    let config: ScheduleConfig;
    try {
      config = loadScheduleConfig(path);
    } catch (error) {
      return program.error(error instanceof Error ? error.message : String(error));
    }
    const missing = config.audits.filter((a) => a.passwordEnv && !process.env[a.passwordEnv]).map((a) => a.passwordEnv);
    if (missing.length) return program.error(`Set ${[...new Set(missing)].join(', ')} in the environment (as CI secrets) before running.`);
    const { db, dataDir } = openDb();
    const rows: string[] = [];
    let failed = false;
    try {
      for (const audit of config.audits) {
        const outcome = await auditOnce(db, dataDir, {
          viewports: ['desktop'],
          mode: 'crawl',
          maxPages: 100,
          maxStates: 200,
          sitemap: true,
          perTemplate: 3,
          concurrency: 2,
          delay: 500,
          preset: 'prego',
          export: true,
          quiet: opts.quiet,
          ...audit,
          password: audit.passwordEnv ? process.env[audit.passwordEnv] : undefined,
        });
        if (!outcome) {
          failed = true;
          rows.push(`| ${audit.project} | ${audit.target} | Didn’t complete | | | | | |`);
          continue;
        }
        const tickets = db.getTickets(outcome.run.id);
        const open = tickets.filter((t) => t.status === 'Open');
        const count = (severity: string) => open.filter((t) => t.severity === severity).length;
        const threshold = audit.failOn ? SEVERITIES.indexOf(audit.failOn) : -1;
        const blocking = threshold < 0 ? [] : open.filter((t) => SEVERITIES.indexOf(t.severity) <= threshold);
        if (blocking.length) {
          failed = true;
          console.error(`✗ ${audit.project}: ${blocking.length} ${blocking.length === 1 ? 'issue' : 'issues'} at ${audit.failOn} severity or worse:`);
          for (const t of blocking.slice(0, 20)) console.error(`    ${t.ticketId} ${t.severity}: ${t.title}`);
        }
        rows.push(`| ${audit.project} | ${audit.target} | ${blocking.length ? `✗ ${blocking.length} blocking` : 'Complete'} | ${open.length} | ${SEVERITIES.map(count).join(' | ')} |`);
      }
    } finally {
      db.close();
    }
    const summary = ['## Prego audits', '', '| Project | Target | Result | Issues | Critical | High | Medium | Low |', '|---|---|---|---|---|---|---|---|', ...rows, ''].join('\n');
    console.log(`\n${summary}`);
    // GitHub Actions shows this on the run's summary page.
    if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, `${summary}\n`);
    if (failed) process.exitCode = 1;
  });

const journeys = program.command('journey').description('record and list scripted journeys');

journeys
  .command('record')
  .description("open Playwright's recorder: click through the journey, then close the window to save it")
  .argument('<project>', 'project name')
  .argument('<name>', 'journey name, e.g. book-a-ticket')
  .argument('<url>', 'where the journey starts')
  .action(async (project: string, name: string, url: string) => {
    const { db, dataDir } = openDb();
    const { slug } = db.ensureProject(project);
    db.close();
    ensureJourneysDir(dataDir, slug);
    const file = journeyFile(dataDir, slug, name);
    const cli = join(dirname(createRequire(import.meta.url).resolve('playwright/package.json')), 'cli.js');
    console.log('A browser window is opening. Click through the journey, then close the window to save it.');
    const code = await new Promise<number | null>((done) => {
      const child = spawn(process.execPath, [cli, 'codegen', '--target', 'javascript', '--output', file, url], { stdio: 'inherit' });
      child.on('exit', done);
    });
    const saved = listJourneys(dataDir, slug).find((j) => j.name === slugify(name));
    if (!saved) return program.error(`Nothing was recorded (recorder exited with ${code}).`);
    console.log(`Saved "${saved.name}" with ${saved.steps.length} steps: ${file}`);
    for (const u of saved.unsupported) console.log(`  not replayed: ${u.statement} (${u.reason})`);
  });

journeys
  .command('list')
  .argument('<project>', 'project name')
  .action((project: string) => {
    const { dataDir } = openDb();
    for (const j of listJourneys(dataDir, slugify(project))) {
      console.log(`${j.name}  ${j.steps.length} steps  from ${j.startUrl ?? '?'}  (recorded ${j.recordedAt.slice(0, 16).replace('T', ' ')})`);
      for (const step of j.steps) console.log(`  ${step.index}. ${step.description}`);
    }
  });

program
  .command('export')
  .description('write the export bundle for a finished run (e.g. after editing tickets)')
  .argument('<runId>', 'run number', int)
  .addOption(new Option('--preset <name>', 'tickets.csv column preset').choices(Object.keys(CSV_PRESETS)).default('prego'))
  .option('--out <dir>', 'write to this folder instead of data/exports/')
  .action(async (runId: number, opts) => {
    const { db, dataDir } = openDb();
    try {
      if (!db.getRun(runId)) program.error(`Run ${runId} not found.`);
      const exported = await exportRun(db, runId, { dataDir, preset: opts.preset, outDir: opts.out });
      console.log(`Export: ${exported.dir}`);
    } finally {
      db.close();
    }
  });

program
  .command('re-export')
  .description('rebuild exported runs (their run.json) with the current rules, without crawling again')
  .argument('<runJson...>', 'run.json files, or export folders containing one')
  .requiredOption('--out <dir>', 'folder to write into: one subfolder per run')
  .option('--as-saved', 'keep everything the saved run found, instead of what a fresh audit would find')
  .option('--settings-from <dataDir>', 'read branding (read-only) from this Prego data folder', join(homedir(), 'Library', 'Application Support', 'Prego', 'data'))
  .action(async (inputs: string[], opts) => {
    const saved = savedSettings(resolve(opts.settingsFrom));
    for (const input of inputs) {
      const file = statSync(input).isDirectory() ? join(input, 'run.json') : input;
      const json = JSON.parse(readFileSync(file, 'utf8')) as ExportedRunJson;
      const name = basename(statSync(input).isDirectory() ? input : dirname(input));
      const reportOptions = savedReportOptions(resolve(opts.settingsFrom), json);
      const exported = await reExport(json, join(resolve(opts.out), name), { fresh: !opts.asSaved, settings: saved?.settings, logo: saved?.logo, reportOptions });
      console.log(`${name}: ${exported.dir}`);
    }
  });

program
  .command('verify')
  .description('check an export folder: ticket IDs and screenshots cross-reference correctly')
  .argument('<dir>', 'export folder')
  .action(async (dir: string) => {
    const result = await verifyExport(dir);
    if (result.ok) {
      console.log(`OK: ${result.ticketIds.length} tickets cross-reference correctly.`);
    } else {
      for (const problem of result.problems) console.error(`✗ ${problem}`);
      process.exitCode = 1;
    }
  });

program
  .command('runs')
  .description('list projects and their runs')
  .action(() => {
    const { db } = openDb();
    try {
      for (const project of db.listProjects()) {
        console.log(`${project.name} (${project.slug})`);
        for (const run of db.listRuns(project.id)) {
          const s = run.summary as Record<string, number>;
          console.log(`  #${run.id}  ${run.startedAt.slice(0, 16).replace('T', ' ')}  ${run.status.padEnd(8)}  ${run.target}  ${s.tickets ?? '-'} tickets`);
        }
      }
    } finally {
      db.close();
    }
  });

function describe(event: AuditEvent): string {
  switch (event.type) {
    case 'phase':
      return `▸ ${event.message}`;
    case 'page-found':
      return `  found ${event.url}`;
    case 'state-found':
      return `  screen ${event.count}: ${event.title} (${event.depth} ${event.depth === 1 ? 'tap' : 'taps'} from the start)`;
    case 'location-audited':
      return `  [${event.done}/${event.total}] ${event.url} @ ${event.viewport}: ${event.findings} findings`;
    case 'warning':
      return `  ! ${event.message}`;
    case 'journey-step':
      return event.ok ? `  step ${event.index}/${event.total}: ${event.description}` : `  ✗ step ${event.index}/${event.total} failed: ${event.description} (${event.error})`;
    case 'started':
      return `▸ Run ${event.runId} started`;
  }
}

await program.parseAsync();
