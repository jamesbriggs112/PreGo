import lighthouse, { desktopConfig } from 'lighthouse';
import * as chromeLauncher from 'chrome-launcher';
import { blockTrackersFlag } from '../../browser/trackers.js';
import { chromium } from 'playwright';
import type { Category, Severity } from '../../types.js';
import type { BasicAuth } from '../../browser/session.js';
import type { CheckFinding, CheckModule } from '../types.js';

/** Lighthouse categories Prego uses, and where their findings go. Accessibility is left to axe. */
const CATEGORY_MAP: Record<string, Category> = { performance: 'PERF', 'best-practices': 'TECH', seo: 'CONT' };

/** Audits other Prego checks already cover, so they aren't reported twice. */
const COVERED_ELSEWHERE = new Set(['meta-description', 'document-title', 'image-alt', 'html-has-lang', 'html-lang-valid', 'color-contrast', 'tap-targets', 'target-size']);

/** Core speed metrics: weighted more heavily when they fail. */
const METRICS = new Set(['first-contentful-paint', 'largest-contentful-paint', 'total-blocking-time', 'cumulative-layout-shift', 'speed-index', 'interactive']);

export interface LighthouseScores {
  performance: number | null;
  bestPractices: number | null;
  seo: number | null;
  formFactor: 'mobile' | 'desktop';
}

export interface LighthouseModuleOptions {
  basicAuth?: BasicAuth;
  /** Told the URL of every request Lighthouse's browser made (for the network test). */
  onRequest?: (url: string) => void;
}

/**
 * Lighthouse performance, best-practice and SEO audits, on one page per template (it's slow). Scores
 * are kept on the location for the report; failing audits become findings. Runs Prego's own copy of
 * Chrome for Testing. Lighthouse's error reporting (which would send data out) exists only in its CLI.
 */
export function lighthouseModule(options: LighthouseModuleOptions = {}): CheckModule {
  // A shared promise, so pages checked at the same time never launch a second Chrome.
  let chrome: Promise<chromeLauncher.LaunchedChrome> | undefined;
  const templatesDone = new Set<string>();
  let statesDone = false;
  // Lighthouse keeps global timing marks, so two runs in one process at once break each other.
  let queue: Promise<unknown> = Promise.resolve();
  const oneAtATime = <T>(task: () => Promise<T>): Promise<T> => {
    const next = queue.then(task, task);
    queue = next.catch(() => undefined);
    return next;
  };

  return {
    id: 'lighthouse',
    name: 'Performance and best practice (Lighthouse)',
    perViewport: false,
    async run({ location, touch, recordMetrics }) {
      // One page per template; for interactives and journeys, only the start (Lighthouse loads URLs).
      if (location.kind === 'state') {
        if (statesDone) return [];
        statesDone = true;
      } else {
        const template = location.templateKey ?? location.url;
        if (templatesDone.has(template)) return [];
        templatesDone.add(template);
      }

      chrome ??= chromeLauncher.launch({ chromePath: chromium.executablePath(), chromeFlags: ['--headless=new', '--no-first-run', '--disable-extensions', blockTrackersFlag()] });
      const { port } = await chrome;
      const formFactor = touch ? 'mobile' : 'desktop';
      const extraHeaders = options.basicAuth
        ? { Authorization: `Basic ${Buffer.from(`${options.basicAuth.username}:${options.basicAuth.password}`).toString('base64')}` }
        : undefined;
      const result = await oneAtATime(() =>
        lighthouse(location.url, { port, output: 'json', logLevel: 'error', onlyCategories: Object.keys(CATEGORY_MAP), extraHeaders }, formFactor === 'desktop' ? desktopConfig : undefined),
      );
      const lhr = result?.lhr;
      if (!lhr) return [];

      const requests = (lhr.audits['network-requests']?.details as { items?: { url: string }[] } | undefined)?.items ?? [];
      for (const r of requests) options.onRequest?.(r.url);

      const score = (id: string) => (lhr.categories[id]?.score == null ? null : Math.round(lhr.categories[id].score! * 100));
      const scores: LighthouseScores = { performance: score('performance'), bestPractices: score('best-practices'), seo: score('seo'), formFactor };
      recordMetrics?.({ lighthouse: scores });

      const findings: CheckFinding[] = [];
      const reported = new Set<string>();
      for (const [categoryId, category] of Object.entries(CATEGORY_MAP)) {
        for (const ref of lhr.categories[categoryId]?.auditRefs ?? []) {
          const audit = lhr.audits[ref.id];
          if (!audit || reported.has(ref.id) || COVERED_ELSEWHERE.has(ref.id)) continue;
          if (audit.score === null || audit.score >= 0.9 || !['binary', 'numeric', 'metricSavings'].includes(audit.scoreDisplayMode)) continue;
          // Performance advice only matters if the page is slow, or the audit estimates a real saving.
          if (categoryId === 'performance' && (scores.performance ?? 0) >= 90 && !worthwhile(audit.metricSavings)) continue;
          reported.add(ref.id);
          const { text, url } = plain(audit.description ?? '');
          findings.push({
            module: 'lighthouse',
            engine: 'lighthouse',
            ruleId: ref.id,
            category,
            severity: severityFor(ref.id, audit.score),
            title: audit.title,
            description: text,
            helpUrl: url,
            wcagCriteria: [],
            wcagLevel: null,
            selector: 'html',
            html: '<html>',
            failureSummary: `${audit.displayValue ? `${audit.displayValue}. ` : ''}Lighthouse score ${Math.round(audit.score * 100)}/100 (${formFactor}).`,
            // The same audit failing on several templates is one site-wide problem.
            siteWide: true,
            component: `lighthouse:${ref.id}`,
          });
        }
      }
      return findings;
    },
    async close() {
      const launched = chrome;
      chrome = undefined;
      await (await launched?.catch(() => undefined))?.kill();
    },
  };
}

/** At least 100ms off a timing metric, or 0.01 off layout shift. */
function worthwhile(savings: Record<string, number | undefined> | undefined): boolean {
  if (!savings) return false;
  return Object.entries(savings).some(([metric, value]) => (metric === 'CLS' ? (value ?? 0) >= 0.01 : (value ?? 0) >= 100));
}

/** Average Lighthouse performance score across the locations it ran on, or null if it didn't run. */
export function averagePerformance(locations: { metrics: Record<string, unknown> }[]): number | null {
  const scores = locations
    .map((l) => (l.metrics.lighthouse as LighthouseScores | undefined)?.performance)
    .filter((s): s is number => typeof s === 'number');
  return scores.length ? Math.round(scores.reduce((a, b) => a + b, 0) / scores.length) : null;
}

function severityFor(id: string, score: number): Severity {
  if (METRICS.has(id)) return score < 0.5 ? 'High' : 'Medium';
  return score < 0.5 ? 'Medium' : 'Low';
}

/** Lighthouse descriptions are Markdown with a "Learn more" link: keep the text, return the link. */
function plain(markdown: string): { text: string; url: string | null } {
  const url = /\[[^\]]*\]\((https?:[^)]+)\)/.exec(markdown)?.[1] ?? null;
  const text = markdown
    .replace(/\[(Learn (more|how)[^\]]*)\]\([^)]+\)\.?/gi, '')
    .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1')
    .replace(/`([^`]+)`/g, '$1')
    .trim();
  return { text, url };
}
