import {
  CHECK_GROUPS,
  aiSettings,
  calibrate,
  checkCosts,
  checkDefinitions,
  estimateAudit,
  formatEstimate,
  getSettings,
  groupChecks,
  understandAuditRequest,
  type PregoDb,
  type RecordedTimings,
} from '@prego/core';

/** Averages from the last 20 timed audits on this computer, for time estimates. */
export function recentCalibration(db: PregoDb) {
  const recent = db
    .listProjects()
    .flatMap((p) => db.listRuns(p.id))
    .filter((r) => r.status === 'complete' && r.summary.timings)
    .sort((a, b) => b.id - a.id)
    .slice(0, 20)
    .map((r) => r.summary.timings as RecordedTimings);
  return calibrate(recent, checkCosts());
}

/**
 * Turn a typed request into the audit it describes, ready to confirm. Anything the request doesn't
 * say comes from the saved defaults. Nothing is started here: the GUI shows the result and starts
 * the audit only when someone confirms it.
 */
export async function planAudit(db: PregoDb, text: string) {
  const settings = getSettings(db);
  const ai = aiSettings(settings);
  const { request, source, note } = await understandAuditRequest(text, ai);
  const problems: string[] = [];
  if (!request.target) problems.push('Say which site to audit, for example “fcn.com” or “https://staging.fcn.com”.');

  // An existing project by name, then by an earlier audit of the same site, then the site's name.
  const projects = db.listProjects();
  const host = request.target ? new URL(request.target).hostname.replace(/^www\./, '') : '';
  const byName = request.project && projects.find((p) => p.name.toLowerCase() === request.project!.toLowerCase());
  const bySite = !request.project && host ? projects.find((p) => db.listRuns(p.id).some((r) => /^https?:/i.test(r.target) && new URL(r.target).hostname.replace(/^www\./, '') === host)) : undefined;
  const project = byName || bySite;
  const projectName = project ? project.name : (request.project ?? host);

  const available = checkDefinitions().filter((c) => c.id !== 'ai' || ai);
  const groups = (request.groups ?? []).map((id) => CHECK_GROUPS.find((g) => g.id === id)!).filter(Boolean);
  const checks = groups.length
    ? [...new Set(groups.flatMap((g) => groupChecks(g, available)))]
    : settings.defaults.checks.filter((id) => available.some((c) => c.id === id));
  const mode = request.mode ?? 'crawl';
  const viewports = request.viewports ?? settings.defaults.viewports;
  const limit = request.maxPages ?? (mode === 'explore' ? 200 : 100);
  const run = {
    project: projectName,
    target: request.target ?? '',
    mode,
    checks,
    viewports,
    ...(mode === 'explore' ? { maxStates: limit } : { maxPages: limit }),
    auditAll: request.auditAll ?? false,
    perTemplate: settings.defaults.perTemplate,
    concurrency: settings.defaults.concurrency,
    delayMs: settings.defaults.delayMs,
    respectRobots: settings.defaults.respectRobots,
  };
  const estimate = estimateAudit({
    mode,
    pages: limit,
    viewports: Math.max(1, viewports.length),
    auditAll: run.auditAll,
    perTemplate: run.perTemplate,
    delayMs: run.delayMs,
    concurrency: run.concurrency,
    checks: checkCosts(checks),
    calibration: recentCalibration(db),
  });
  return {
    source,
    note,
    problems,
    run,
    projectExists: !!project,
    /** What the checks are, in words: the test groups asked for, or the saved defaults. */
    checksLabel: groups.length ? groups.map((g) => g.name).join(', ') : 'Your default checks (from Settings)',
    estimate: formatEstimate(estimate),
  };
}
