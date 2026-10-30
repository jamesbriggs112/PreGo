import { describe, expect, it } from 'vitest';
import { CHECK_GROUPS, calibrate, estimateAudit, formatEstimate, groupChecks, type CheckCost } from './estimate.js';

const costs: CheckCost[] = [
  { id: 'axe', seconds: [0.3, 0.8] },
  { id: 'lighthouse', seconds: [6, 12], perPage: true, serial: true, setupSeconds: [3, 6] },
];
const base = { mode: 'crawl' as const, pages: 100, viewports: 1, auditAll: true, perTemplate: 3, delayMs: 500, concurrency: 2 };

describe('test groups', () => {
  it('only include installed checks, and the full audit takes every check', () => {
    const installed = [{ id: 'axe' }, { id: 'links' }, { id: 'ibm' }];
    expect(groupChecks(CHECK_GROUPS.find((g) => g.id === 'quick')!, installed)).toEqual(['axe', 'links']);
    expect(groupChecks(CHECK_GROUPS.find((g) => g.id === 'full')!, installed)).toEqual(['axe', 'links', 'ibm']);
  });
});

describe('time estimates', () => {
  it('grow with pages, viewports and slow checks', () => {
    const quick = estimateAudit({ ...base, checks: [costs[0]] });
    expect(quick.minSeconds).toBeLessThan(quick.maxSeconds);
    expect(estimateAudit({ ...base, viewports: 3, checks: [costs[0]] }).maxSeconds).toBeGreaterThan(quick.maxSeconds);
    const withLighthouse = estimateAudit({ ...base, checks: costs });
    // Lighthouse runs one page at a time: at least 6 seconds for each of 100 pages.
    expect(withLighthouse.minSeconds - quick.minSeconds).toBeGreaterThanOrEqual(600);
  });

  it('assume a sample per template unless every page is audited', () => {
    const sampled = estimateAudit({ ...base, auditAll: false, checks: costs });
    expect(sampled.audited[0]).toBeLessThan(sampled.audited[1]);
    expect(sampled.audited[1]).toBeLessThan(100);
    expect(estimateAudit({ ...base, checks: costs }).audited).toEqual([100, 100]);
  });

  it('read naturally', () => {
    expect(formatEstimate({ minSeconds: 20, maxSeconds: 50 })).toBe('under a minute');
    expect(formatEstimate({ minSeconds: 250, maxSeconds: 400 })).toBe('about 4–7 minutes');
    expect(formatEstimate({ minSeconds: 7200, maxSeconds: 10800 })).toBe('about 2–3 hours');
  });

  it('learn from recorded audits', () => {
    const calibration = calibrate(
      [
        { pageViews: 10, locations: 5, openMs: 20_000, checks: { axe: 5_000, lighthouse: 50_000 } },
        { pageViews: 0, openMs: 0, checks: {} },
      ],
      costs,
    );
    expect(calibration).toEqual({ runs: 1, openSeconds: 2, checks: { axe: 0.5, lighthouse: 10 } });
    expect(calibrate([], costs)).toBeNull();
    const slow = estimateAudit({ ...base, checks: costs, calibration: { ...calibration!, openSeconds: 10 } });
    expect(slow.minSeconds).toBeGreaterThan(estimateAudit({ ...base, checks: costs }).maxSeconds);
  });
});
