import { readFileSync } from 'node:fs';
import { CHECK_GROUPS, CSV_PRESETS, PROFILES, SEVERITIES, checkDefinitions, type ProfileName, type Severity } from '@prego/core';

/**
 * One audit in a schedule file. Names match the `prego audit` options. Passwords are never stored
 * in the file: `passwordEnv` names the environment variable (a CI secret) that holds it.
 */
export interface ScheduledAudit {
  project: string;
  target: string;
  mode?: 'crawl' | 'explore' | 'journey';
  journey?: string;
  loginJourney?: string;
  group?: string;
  checks?: string[];
  viewports?: ProfileName[];
  maxPages?: number;
  maxDepth?: number;
  maxStates?: number;
  perTemplate?: number;
  all?: boolean;
  include?: string[];
  exclude?: string[];
  ignoreRobots?: boolean;
  sitemap?: boolean;
  concurrency?: number;
  delay?: number;
  timeBudget?: number;
  user?: string;
  passwordEnv?: string;
  preset?: string;
  export?: boolean;
  /** Fail the run (exit code 1) if any issue is at this severity or worse. */
  failOn?: Severity;
}

export interface ScheduleConfig {
  audits: ScheduledAudit[];
}

const KEYS = new Set([
  'project', 'target', 'mode', 'journey', 'loginJourney', 'group', 'checks', 'viewports', 'maxPages', 'maxDepth', 'maxStates', 'perTemplate',
  'all', 'include', 'exclude', 'ignoreRobots', 'sitemap', 'concurrency', 'delay', 'timeBudget', 'user', 'passwordEnv', 'preset', 'export', 'failOn',
]);

/** Read and check a schedule file, with every problem listed at once. */
export function loadScheduleConfig(path: string): ScheduleConfig {
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(path, 'utf8'));
  } catch (error) {
    throw new Error(`Couldn't read ${path}: ${error instanceof Error ? error.message : error}`);
  }
  const problems: string[] = [];
  const audits = (raw as { audits?: unknown })?.audits;
  if (!Array.isArray(audits) || audits.length === 0) throw new Error(`${path} needs an "audits" list with at least one audit.`);
  const checks = checkDefinitions().map((d) => d.id);
  audits.forEach((a: Record<string, unknown>, i) => {
    const at = `audits[${i}]`;
    if (typeof a !== 'object' || a === null) return problems.push(`${at} must be an object.`);
    for (const key of Object.keys(a)) if (!KEYS.has(key)) problems.push(`${at}: unknown setting "${key}".`);
    if (typeof a.project !== 'string' || !a.project.trim()) problems.push(`${at}: "project" is required.`);
    if (typeof a.target !== 'string' || !a.target.trim()) problems.push(`${at}: "target" is required.`);
    if (a.mode !== undefined && !['crawl', 'explore', 'journey'].includes(a.mode as string)) problems.push(`${at}: "mode" must be crawl, explore or journey.`);
    if (a.mode === 'journey' && typeof a.journey !== 'string') problems.push(`${at}: journey mode needs "journey".`);
    if (a.group !== undefined && !CHECK_GROUPS.some((g) => g.id === a.group)) problems.push(`${at}: unknown group "${a.group}". Choose from ${CHECK_GROUPS.map((g) => g.id).join(', ')}.`);
    if (a.group !== undefined && a.checks !== undefined) problems.push(`${at}: use "group" or "checks", not both.`);
    if (a.checks !== undefined && (!Array.isArray(a.checks) || a.checks.some((c) => !checks.includes(c as string)))) problems.push(`${at}: "checks" must list check IDs from ${checks.join(', ')}.`);
    if (a.viewports !== undefined && (!Array.isArray(a.viewports) || a.viewports.some((v) => !(v in PROFILES)))) problems.push(`${at}: "viewports" must list ${Object.keys(PROFILES).join(', ')}.`);
    for (const key of ['maxPages', 'maxDepth', 'maxStates', 'perTemplate', 'concurrency', 'delay', 'timeBudget']) {
      if (a[key] !== undefined && (!Number.isInteger(a[key]) || (a[key] as number) < 0)) problems.push(`${at}: "${key}" must be a whole number.`);
    }
    if (a.preset !== undefined && !CSV_PRESETS[a.preset as string]) problems.push(`${at}: unknown CSV preset "${a.preset}". Choose from ${Object.keys(CSV_PRESETS).join(', ')}.`);
    if (a.failOn !== undefined && !SEVERITIES.includes(a.failOn as Severity)) problems.push(`${at}: "failOn" must be one of ${SEVERITIES.join(', ')}.`);
    if (a.user !== undefined && typeof a.passwordEnv !== 'string') problems.push(`${at}: "user" needs "passwordEnv", the environment variable that holds the password.`);
    if ('password' in a) problems.push(`${at}: never put a password in the file. Use "passwordEnv" with a secret.`);
  });
  if (problems.length) throw new Error(`${path} has problems:\n${problems.map((p) => `  - ${p}`).join('\n')}`);
  return { audits: audits as ScheduledAudit[] };
}
