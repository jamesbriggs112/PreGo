/**
 * Test groups and audit time estimates. No Node or browser imports, so the GUI can use it too.
 */

export interface CheckGroup {
  id: string;
  name: string;
  description: string;
  /** Check IDs; any not installed are skipped. `full` takes every check. */
  checks: string[];
}

export const CHECK_GROUPS: CheckGroup[] = [
  { id: 'quick', name: 'Quick check', description: 'The basics before anything else: accessibility, go-live mistakes, broken links and security headers.', checks: ['axe', 'golive', 'links', 'security'] },
  { id: 'accessibility', name: 'Accessibility', description: 'Both accessibility engines plus the custom keyboard, zoom and spacing checks.', checks: ['axe', 'a11y-custom', 'ibm', 'canvas'] },
  { id: 'content', name: 'Content and SEO', description: 'Titles, descriptions, alt text, HTML validity, spelling and go-live mistakes.', checks: ['content', 'html', 'spelling', 'golive'] },
  { id: 'design', name: 'Design and browsers', description: 'Visual consistency, and Firefox and Safari rendering.', checks: ['ui', 'browsers'] },
  { id: 'performance', name: 'Performance', description: 'Lighthouse performance, best-practice and SEO scores.', checks: ['lighthouse'] },
  { id: 'security', name: 'Security', description: 'Passive checks only: headers, certificate, cookies, CSP, outdated libraries and tracking before consent. Nothing is attacked.', checks: ['security', 'libraries', 'privacy'] },
  { id: 'full', name: 'Full audit', description: 'Every check.', checks: [] },
];

/** The checks in a group, limited to the ones installed. */
export function groupChecks(group: CheckGroup, available: readonly { id: string }[]): string[] {
  const ids = available.map((c) => c.id);
  return group.id === 'full' ? ids : group.checks.filter((id) => ids.includes(id));
}

/** How long a check takes on a typical live site, in seconds. */
export interface CheckCost {
  id: string;
  /** Low and high seconds per page view (or per page, with `perPage`). */
  seconds: [number, number];
  /** Runs once per page rather than at every viewport. */
  perPage?: boolean;
  /** Runs one page at a time even when pages are audited in parallel (Lighthouse). */
  serial?: boolean;
  /** Fixed time per audit (starting a browser or scanner). */
  setupSeconds?: [number, number];
}

/** Averages measured from earlier audits on this machine. */
export interface Calibration {
  runs: number;
  /** Opening a page and taking its screenshot, per page view. */
  openSeconds: number;
  /** Per page view, or per page for per-page checks. */
  checks: Record<string, number>;
}

export interface EstimateInput {
  mode: 'crawl' | 'explore' | 'journey';
  /** Page (or screen, or step) limit. */
  pages: number;
  viewports: number;
  auditAll: boolean;
  perTemplate: number;
  delayMs: number;
  concurrency: number;
  checks: CheckCost[];
  calibration?: Calibration | null;
}

export interface Estimate {
  minSeconds: number;
  maxSeconds: number;
  /** Pages expected to be audited, low and high. */
  audited: [number, number];
}

const OPEN: [number, number] = [1.5, 3];
const SETUP: [number, number] = [5, 15];

export function estimateAudit(input: EstimateInput): Estimate {
  const pages = Math.max(1, input.pages);
  const parallel = input.mode === 'crawl' ? Math.max(1, input.concurrency) : 1;
  // Crawls sample a few pages per template unless told to audit everything; templates vary a lot by site.
  const audited: [number, number] = input.auditAll || input.mode !== 'crawl'
    ? [pages, pages]
    : [Math.min(pages, Math.max(input.perTemplate * 3, Math.round(pages * 0.2))), Math.min(pages, Math.max(input.perTemplate * 10, Math.round(pages * 0.6)))];
  const cal = input.calibration;
  const range = (measured: number | undefined, fallback: [number, number]): [number, number] =>
    measured === undefined ? fallback : [measured * 0.8, measured * 1.3];

  const total = [0, 1].map((i) => {
    const open = range(cal?.openSeconds, OPEN)[i];
    const crawl = input.mode === 'crawl' ? pages * (open / parallel + input.delayMs / 1000) : 0;
    let parallelWork = audited[i] * input.viewports * open;
    let serialWork = 0;
    let setup = SETUP[i];
    for (const check of input.checks) {
      const seconds = range(cal?.checks[check.id], check.seconds)[i];
      const work = audited[i] * (check.perPage ? 1 : input.viewports) * seconds;
      if (check.serial) serialWork += work;
      else parallelWork += work;
      setup += check.setupSeconds?.[i] ?? 0;
    }
    return setup + crawl + parallelWork / parallel + serialWork;
  });
  return { minSeconds: Math.round(total[0]), maxSeconds: Math.round(total[1]), audited };
}

/** "about 4–7 minutes", rounded so it doesn't look more precise than it is. */
export function formatEstimate({ minSeconds, maxSeconds }: Pick<Estimate, 'minSeconds' | 'maxSeconds'>): string {
  if (maxSeconds < 60) return 'under a minute';
  const lo = Math.max(1, Math.floor(minSeconds / 60));
  const hi = Math.max(lo + 1, Math.ceil(maxSeconds / 60));
  if (hi >= 120) return `about ${Math.round(lo / 6) / 10}–${Math.round(hi / 6) / 10} hours`;
  return `about ${lo}–${hi} minutes`;
}

/** What earlier audits' recorded timings say about this machine and the sites it audits. */
export interface RecordedTimings {
  pageViews: number;
  locations?: number;
  openMs: number;
  checks: Record<string, number>;
}

export function calibrate(recorded: RecordedTimings[], costs: CheckCost[]): Calibration | null {
  const usable = recorded.filter((t) => t.pageViews > 0);
  if (!usable.length) return null;
  const views = usable.reduce((n, t) => n + t.pageViews, 0);
  const checks: Record<string, number> = {};
  for (const cost of costs) {
    const withCheck = usable.filter((t) => t.checks[cost.id] !== undefined);
    if (!withCheck.length) continue;
    const units = withCheck.reduce((n, t) => n + (cost.perPage ? (t.locations ?? t.pageViews) : t.pageViews), 0);
    checks[cost.id] = withCheck.reduce((n, t) => n + t.checks[cost.id], 0) / 1000 / Math.max(1, units);
  }
  return { runs: usable.length, openSeconds: usable.reduce((n, t) => n + t.openMs, 0) / 1000 / views, checks };
}
