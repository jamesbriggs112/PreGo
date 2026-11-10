import { describe, expect, it } from 'vitest';
import type { Location, Ticket } from '../types.js';
import { buildDashboard, legalSignals, scoreLight, type DashboardInput } from './dashboard.js';

const page = (url: string, title: string | null = null): Location =>
  ({ id: 1, runId: 1, kind: 'page', url, stateId: null, title, statusCode: 200, depth: 0, templateKey: null, structureHash: null, audited: true, notAuditedReason: null, screenshots: {}, steps: null, metrics: {} }) as Location;

const ticket = (fields: Partial<Ticket>): Ticket => ({ category: 'A11Y', severity: 'Medium', title: 'An issue', ruleId: 'x', wcagCriterion: null, wcagLevel: null, status: 'Open', ...fields }) as Ticket;

const input = (fields: Partial<DashboardInput> = {}): DashboardInput => ({
  run: { mode: 'crawl', target: 'https://www.example.co.uk/', summary: { pagesAudited: 3, pagesFound: 5, brokenLinks: 0 } },
  locations: [page('https://www.example.co.uk/'), page('https://www.example.co.uk/privacy-policy'), page('https://www.example.co.uk/accessibility', 'Accessibility statement')],
  tickets: [],
  scores: { A11Y: 95, CONT: 70, TECH: 40 },
  checks: ['axe', 'privacy', 'security', 'links'],
  ...fields,
});

describe('the results dashboard', () => {
  it('lights scores like Lighthouse: 90 and up good, 50 to 89 fair, under 50 poor', () => {
    expect([scoreLight(90), scoreLight(89), scoreLight(50), scoreLight(49)]).toEqual(['good', 'fair', 'fair', 'poor']);
    const tiles = buildDashboard(input()).tiles;
    expect(tiles.filter((t) => t.id.startsWith('score-')).map((t) => [t.label, t.rating])).toEqual([
      ['Accessibility score', 'good'],
      ['Content and SEO score', 'fair'],
      ['Markup and technical score', 'poor'],
    ]);
    expect(tiles.find((t) => t.id === 'pages')).toMatchObject({ value: '3 of 5', rating: null });
    expect(tiles.find((t) => t.id === 'links')).toMatchObject({ value: '0', rating: 'good' });
    expect(tiles.find((t) => t.id === 'legal')).toMatchObject({ value: '0', rating: 'good' });
  });

  it('rates tickets by how many are critical or high', () => {
    const tickets = [ticket({ severity: 'Critical' }), ticket({ severity: 'Low' })];
    expect(buildDashboard(input({ tickets })).tiles.find((t) => t.id === 'tickets')).toMatchObject({ value: '2', rating: 'fair', note: '1 critical or high.' });
  });
});

describe('possible legal risks', () => {
  it('finds no signs when the checks found nothing, without claiming the site complies', () => {
    const legal = legalSignals(input());
    expect(legal.signals).toEqual([]);
    expect(legal.clear.join(' ')).toContain('Accessibility statement: found at /accessibility');
    expect(legal.clear.join(' ')).not.toMatch(/\bcompl(y|ies|iant)\b/i);
  });

  it('flags WCAG A and AA failures, tracking before consent and plain HTTP, with the reasons', () => {
    const legal = legalSignals(
      input({
        tickets: [
          ticket({ wcagLevel: 'AA', wcagCriterion: '1.4.3', severity: 'High', title: 'Text has low contrast' }),
          ticket({ category: 'SEC', ruleId: 'trackers-before-consent', title: 'Google Analytics loads before consent' }),
          ticket({ category: 'SEC', ruleId: 'no-https', title: 'The site is served over plain HTTP' }),
        ],
      }),
    );
    expect(legal.signals.map((s) => [s.id, s.level])).toEqual([
      ['accessibility', 'risk'],
      ['consent', 'risk'],
      ['security', 'risk'],
    ]);
    expect(legal.signals[0].evidence).toContain('Criteria affected: 1.4.3.');
    expect(legal.signals[1].laws[0]).toMatch(/PECR/);
    for (const signal of legal.signals) expect(signal.why).not.toMatch(/\b(is|are) (illegal|unlawful|in breach)\b/i);
  });

  it('holds public sector sites to the accessibility regulations, including the statement', () => {
    const legal = legalSignals(input({ run: { mode: 'crawl', target: 'https://www.example.police.uk/', summary: {} }, locations: [page('https://www.example.police.uk/')] }));
    expect(legal.publicSector).toBe(true);
    expect(legal.signals.find((s) => s.id === 'statement')).toMatchObject({ level: 'risk', laws: [expect.stringMatching(/Public Sector Bodies/)] });
    expect(legal.signals.find((s) => s.id === 'privacy-notice')).toMatchObject({ level: 'check' });
  });

  it('counts WCAG failures another check found, and says the accessibility checks didn’t run', () => {
    const legal = legalSignals(input({ checks: ['content'], tickets: [ticket({ wcagLevel: 'A', wcagCriterion: '1.1.1', title: 'Alt text doesn’t describe the image' })] }));
    expect(legal.signals[0]).toMatchObject({ id: 'accessibility', level: 'check' });
    expect(legal.signals[0].evidence.at(-1)).toMatch(/accessibility checks didn’t run/);
  });

  it('says what it couldn’t check', () => {
    const legal = legalSignals(input({ checks: [], run: { mode: 'journey', target: 'https://www.example.co.uk/', summary: {} } }));
    expect(legal.signals).toEqual([]);
    expect(legal.notChecked).toHaveLength(4);
  });
});
