#!/usr/bin/env node
import { Command, InvalidArgumentError, Option } from 'commander';
import { basename, join, resolve } from 'node:path';
import {
  CSV_PRESETS,
  PROFILES,
  PregoDb,
  VERSION,
  defaultDataDir,
  exportRun,
  isProfileName,
  runAudit,
  verifyExport,
  type AuditEvent,
  type ProfileName,
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
  .option('--max-pages <n>', 'maximum pages to crawl', int, 100)
  .option('--max-depth <n>', 'maximum link depth', int, 10)
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
  .option('--no-export', 'store results without writing the export bundle')
  .option('-q, --quiet', 'only print the final summary')
  .action(async (target: string, opts) => {
    const { db, dataDir } = openDb();
    const project = opts.project ?? (/^https?:\/\//i.test(target) ? new URL(target).hostname : basename(resolve(target)));
    if (opts.user && !process.env.PREGO_PASSWORD) {
      program.error('Set the basic auth password in the PREGO_PASSWORD environment variable (it is never stored or passed on the command line).');
    }
    const log = (line: string) => process.stderr.write(`${line}\n`);
    const controller = new AbortController();
    process.once('SIGINT', () => {
      log('\nStopping after the current page…');
      controller.abort();
    });
    try {
      const result = await runAudit(db, {
        project,
        target,
        dataDir,
        viewports: opts.viewports,
        maxPages: opts.maxPages,
        maxDepth: opts.maxDepth,
        timeBudgetMs: opts.timeBudget ? opts.timeBudget * 60_000 : undefined,
        include: opts.include,
        exclude: opts.exclude,
        respectRobots: !opts.ignoreRobots,
        useSitemap: opts.sitemap,
        perTemplate: opts.perTemplate,
        auditAll: opts.all,
        concurrency: opts.concurrency,
        delayMs: opts.delay,
        basicAuth: opts.user ? { username: opts.user, password: process.env.PREGO_PASSWORD! } : undefined,
        signal: controller.signal,
        onEvent: opts.quiet ? undefined : (event) => log(describe(event)),
      });
      const { run } = result;
      if (run.status !== 'complete') {
        log(`Run ${run.id} ${run.status}${run.error ? `: ${run.error}` : ''}`);
        process.exitCode = 1;
        return;
      }
      const s = run.summary as Record<string, number>;
      console.log(`Run ${run.id} complete: ${s.pagesFound} pages found, ${s.pagesAudited} audited, ${s.tickets} tickets from ${s.findings} findings.`);
      if (opts.export) {
        const exported = await exportRun(db, run.id, { dataDir, preset: opts.preset });
        console.log(`Export: ${exported.dir}`);
      }
    } finally {
      db.close();
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
    case 'location-audited':
      return `  [${event.done}/${event.total}] ${event.url} @ ${event.viewport}: ${event.findings} findings`;
    case 'warning':
      return `  ! ${event.message}`;
  }
}

await program.parseAsync();
