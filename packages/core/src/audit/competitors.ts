import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import lighthouse, { desktopConfig } from 'lighthouse';
import * as chromeLauncher from 'chrome-launcher';
import { chromium } from 'playwright';
import { RobotsTxtFile } from '@crawlee/utils';
import { blockTrackersFlag } from '../browser/trackers.js';
import type { CompetitorResult, CompetitorScores } from '../export/sections.js';

// The competitor comparison: each site's public home page scored by Lighthouse, once at desktop and
// once at mobile settings, the same page any visitor would load. Nothing else on the site is
// requested, and a site whose robots.txt disallows its home page is skipped.

const CATEGORIES = ['performance', 'accessibility', 'best-practices', 'seo'];
export const MAX_COMPETITORS = 8;

/** Competitor addresses typed on the New audit form, as home page URLs. Anything unusable is dropped. */
export function competitorUrls(input: string[]): string[] {
  const out: string[] = [];
  for (const raw of input) {
    const text = raw.trim();
    // Another scheme (ftp:, file:) isn't a website to compare.
    if (!text || (/^[a-z][a-z0-9+.-]*:/i.test(text) && !/^https?:\/\//i.test(text))) continue;
    try {
      const url = new URL(/^https?:\/\//i.test(text) ? text : `https://${text}`);
      if (!/^https?:$/.test(url.protocol)) continue;
      const home = new URL('/', url).href;
      if (!out.includes(home)) out.push(home);
    } catch {
      // Not an address: ignore it.
    }
  }
  return out.slice(0, MAX_COMPETITORS);
}

export async function scoreSites(
  sites: { url: string; own: boolean }[],
  runDir: string,
  options: { respectRobots?: boolean; signal?: AbortSignal; onSite?: (url: string, index: number) => void } = {},
): Promise<CompetitorResult[]> {
  const chrome = await chromeLauncher.launch({ chromePath: chromium.executablePath(), chromeFlags: ['--headless=new', '--no-first-run', '--disable-extensions', blockTrackersFlag()] });
  const results: CompetitorResult[] = [];
  try {
    for (const [i, site] of sites.entries()) {
      if (options.signal?.aborted) break;
      options.onSite?.(site.url, i);
      const result: CompetitorResult = { url: site.url, own: site.own, title: null, desktop: null, mobile: null, screenshot: null };
      try {
        if (!site.own && options.respectRobots !== false && !(await homeAllowed(site.url))) {
          result.error = 'its robots.txt asks crawlers not to load the home page';
        } else {
          const desktop = await run(site.url, chrome.port, 'desktop');
          const mobile = await run(site.url, chrome.port, 'mobile');
          result.desktop = desktop.scores;
          result.mobile = mobile.scores;
          if (desktop.screenshot) {
            mkdirSync(join(runDir, 'competitors'), { recursive: true });
            result.screenshot = join('competitors', `${i + 1}.jpg`);
            writeFileSync(join(runDir, result.screenshot), desktop.screenshot);
          }
        }
      } catch (error) {
        result.error = (error as Error).message.split('\n')[0].slice(0, 160);
      }
      results.push(result);
    }
  } finally {
    await chrome.kill();
  }
  return results;
}

async function homeAllowed(url: string): Promise<boolean> {
  try {
    const robotsUrl = new URL('/robots.txt', url).href;
    const response = await fetch(robotsUrl, { signal: AbortSignal.timeout(15_000) });
    if (!response.ok) return true;
    return RobotsTxtFile.from(robotsUrl, await response.text()).isAllowed(url);
  } catch {
    return true;
  }
}

async function run(url: string, port: number, formFactor: 'desktop' | 'mobile'): Promise<{ scores: CompetitorScores; screenshot: Buffer | null }> {
  const result = await lighthouse(url, { port, output: 'json', logLevel: 'error', onlyCategories: CATEGORIES }, formFactor === 'desktop' ? desktopConfig : undefined);
  const lhr = result?.lhr;
  if (!lhr) throw new Error('Lighthouse returned nothing');
  if (lhr.runtimeError) throw new Error(lhr.runtimeError.message);
  const score = (id: string) => (lhr.categories[id]?.score == null ? null : Math.round(lhr.categories[id].score! * 100));
  const shot = (lhr.audits['final-screenshot']?.details as { data?: string } | undefined)?.data;
  const jpeg = shot?.startsWith('data:image/jpeg;base64,') ? Buffer.from(shot.slice('data:image/jpeg;base64,'.length), 'base64') : null;
  return {
    scores: { performance: score('performance'), accessibility: score('accessibility'), bestPractices: score('best-practices'), seo: score('seo') },
    screenshot: jpeg,
  };
}
