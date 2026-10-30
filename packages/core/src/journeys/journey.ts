import { existsSync, mkdirSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import type { Page } from 'playwright';
import { slugify } from '../db/database.js';

/** One recorded action, as Playwright's code generator wrote it, e.g. `await page.getByRole(...).click();`. */
export interface JourneyStep {
  index: number;
  statement: string;
  /** Plain-English version, e.g. `Click the "Book now" button`. */
  description: string;
}

export interface Journey {
  name: string;
  file: string;
  startUrl: string | null;
  steps: JourneyStep[];
  /** Statements Prego won't replay (popups, unsupported calls), with the reason. */
  unsupported: { statement: string; reason: string }[];
  recordedAt: string;
}

/** Page methods a journey may call, first in the chain. */
const ALLOWED_START = /^await page\.(goto|getBy(Role|Text|Label|Placeholder|AltText|Title|TestId)|locator|frameLocator|click|dblclick|fill|press|type|check|uncheck|selectOption|hover|focus|keyboard|mouse|waitForURL|waitForLoadState|waitForTimeout)\b/;
/** Anything that reaches outside the page. A journey is replayed, never run as a program. */
const FORBIDDEN = /\b(process|require|import|eval|Function|globalThis|global|window|document|fetch|constructor|prototype|__proto__|child_process|fs)\b|`|\$\{/;

/** Where a project's journeys are kept. Inside the git-ignored data folder. */
export function journeysDir(dataDir: string, projectSlug: string): string {
  return join(dataDir, 'journeys', projectSlug);
}

export function journeyFile(dataDir: string, projectSlug: string, name: string): string {
  return join(journeysDir(dataDir, projectSlug), `${slugify(name)}.js`);
}

/**
 * Split a script from `playwright codegen --target javascript` into replayable steps. Only single
 * `await page.…;` statements using Playwright actions are kept; setup and teardown lines are skipped,
 * and anything else is listed as unsupported rather than run.
 */
export function parseJourney(source: string): Pick<Journey, 'steps' | 'unsupported' | 'startUrl'> {
  const steps: JourneyStep[] = [];
  const unsupported: Journey['unsupported'] = [];
  const SETUP = /^(const|let|var)\s+(\{\s*chromium|\{\s*firefox|\{\s*webkit|browser|context|page)\b|^\(async|^\}\)\(\);?$|^\}\);?$|^headless:|^await (context|browser)\.close\(\);?$|^\/\//;
  let inLaunch = false;
  for (const raw of source.split('\n')) {
    const line = raw.trim();
    if (!line) continue;
    if (inLaunch) {
      if (line.startsWith('});')) inLaunch = false;
      continue;
    }
    if (SETUP.test(line)) {
      // Setup calls with options span several lines (launch({ headless: false }), newContext({ ... })).
      if (line.endsWith('({')) inLaunch = true;
      continue;
    }
    if (!line.startsWith('await page.')) {
      unsupported.push({ statement: line, reason: /page\d+|popup/.test(line) ? 'Popups and new tabs are not replayed' : 'Not a single page action' });
      continue;
    }
    if (!ALLOWED_START.test(line) || FORBIDDEN.test(line) || !line.endsWith(';') || line.slice(0, -1).includes(';')) {
      unsupported.push({ statement: line, reason: 'Uses something other than Playwright page actions' });
      continue;
    }
    steps.push({ index: steps.length + 1, statement: line, description: describeStatement(line) });
  }
  const goto = steps.find((s) => s.statement.startsWith('await page.goto('));
  const startUrl = goto ? (/goto\(\s*['"]([^'"]+)['"]/.exec(goto.statement)?.[1] ?? null) : null;
  return { steps, unsupported, startUrl };
}

/** A readable description of a recorded statement, for screen titles and steps to reproduce. */
export function describeStatement(statement: string): string {
  const goto = /^await page\.goto\(\s*['"]([^'"]+)['"]/.exec(statement);
  if (goto) return `Open ${goto[1]}`;
  const role = /getByRole\(\s*'([^']+)'\s*,\s*\{\s*name:\s*'([^']*)'/.exec(statement);
  const target =
    (role && `the “${role[2]}” ${role[1]}`) ??
    /getBy(?:Text|Label|Placeholder|AltText|Title|TestId)\(\s*'([^']*)'/.exec(statement)?.[1]?.replace(/^(.*)$/, '“$1”') ??
    /locator\(\s*'([^']*)'/.exec(statement)?.[1] ??
    'the page';
  const action = /\.(\w+)\(([^)]*)\);$/.exec(statement);
  const verb = action?.[1] ?? 'use';
  const value = action?.[2]?.match(/^'([^']*)'/)?.[1];
  switch (verb) {
    case 'click':
      return `Click ${target}`;
    case 'dblclick':
      return `Double-click ${target}`;
    case 'fill':
    case 'type':
      return `Type “${value ?? ''}” into ${target}`;
    case 'press':
      return `Press ${value ?? 'a key'} in ${target}`;
    case 'check':
      return `Tick ${target}`;
    case 'uncheck':
      return `Untick ${target}`;
    case 'selectOption':
      return `Choose “${value ?? ''}” in ${target}`;
    case 'hover':
      return `Hover over ${target}`;
    default:
      return `${verb} ${target}`;
  }
}

/** How long a step may wait for its element before the journey is treated as broken. */
export const STEP_TIMEOUT_MS = 10_000;

/** Run one parsed step against a page. The statement is evaluated with only `page` in scope. */
export async function runStep(page: Page, step: JourneyStep): Promise<void> {
  page.setDefaultTimeout(STEP_TIMEOUT_MS);
  const { statement } = parseJourney(step.statement).steps[0] ?? {};
  if (statement !== step.statement) throw new Error(`Refusing to run an unsupported journey statement: ${step.statement}`);
  const run = new Function('page', `"use strict"; return (async () => { ${statement} })();`) as (page: Page) => Promise<void>;
  await run(page);
  await page.waitForLoadState('load').catch(() => undefined);
  await page.waitForLoadState('networkidle', { timeout: 3_000 }).catch(() => undefined);
}

export function loadJourney(file: string, name: string): Journey {
  const parsed = parseJourney(readFileSync(file, 'utf8'));
  return { name, file, ...parsed, recordedAt: statSync(file).mtime.toISOString() };
}

/** A project's recorded journeys, newest first. */
export function listJourneys(dataDir: string, projectSlug: string): Journey[] {
  const dir = journeysDir(dataDir, projectSlug);
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((f) => f.endsWith('.js'))
    .map((f) => loadJourney(join(dir, f), f.replace(/\.js$/, '')))
    .sort((a, b) => b.recordedAt.localeCompare(a.recordedAt));
}

export function ensureJourneysDir(dataDir: string, projectSlug: string): string {
  const dir = journeysDir(dataDir, projectSlug);
  mkdirSync(dir, { recursive: true });
  return dir;
}
