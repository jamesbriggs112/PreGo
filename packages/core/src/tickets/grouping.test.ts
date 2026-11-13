import { describe, expect, it } from 'vitest';
import { PregoDb } from '../db/database.js';
import { restoreRun, type RunJson } from '../export/restore.js';
import { buildTickets, fingerprint, normaliseComponent } from './build.js';
import { isAdvisory } from './advisory.js';
import { templateName } from './component.js';
import type { Location, RawFinding } from '../types.js';

// One problem, one ticket: the same component failing the same check on every page template is one
// ticket, and the same check from axe and IBM is one ticket. Built from small made-up runs.

const location = (id: number, path: string, templateKey: string): Location =>
  ({
    id,
    runId: 1,
    kind: 'page',
    url: `https://example.org${path}`,
    stateId: null,
    title: path,
    statusCode: 200,
    depth: 1,
    templateKey,
    structureHash: templateKey,
    audited: true,
    notAuditedReason: null,
    screenshots: [],
    steps: null,
    metrics: {},
  }) as Location;

const finding = (id: number, locationId: number, ruleId: string, component: string, extra: Partial<RawFinding> = {}): RawFinding =>
  ({
    id,
    runId: 1,
    locationId,
    viewport: 'desktop',
    module: 'axe',
    engine: 'axe-core',
    ruleId,
    category: 'A11Y',
    severity: 'Critical',
    title: ruleId,
    description: '',
    helpUrl: null,
    wcagCriteria: ['4.1.2'],
    wcagLevel: 'A',
    selector: 'button.hamburger',
    html: '<button class="hamburger">',
    failureSummary: '',
    crop: null,
    fingerprint: null,
    ticketId: null,
    component,
    componentShared: true,
    ...extra,
  }) as RawFinding;

// A header button on three page types, whose <body> classes change with the page type (as Drupal's do).
const HEADER = (type: string) => `body.not-logged-in.page-node-type-${type}>div.canvas>header.top-layout`;
const json: RunJson = {
  project: { name: 'Example' },
  run: { mode: 'crawl', target: 'https://example.org', settings: {}, summary: {} },
  locations: [location(1, '/', '/'), location(2, '/news/one', '/news/*'), location(3, '/about', '/about')],
  rawFindings: [
    finding(1, 1, 'button-name', HEADER('page')),
    finding(2, 2, 'button-name', HEADER('article')),
    finding(3, 3, 'button-name', HEADER('publication')),
    // The same missing label, from both engines.
    finding(4, 2, 'label', 'body.page-node-type-article>main>form.search', { componentShared: false, wcagCriteria: ['4.1.2'] }),
    finding(5, 2, 'input_label_exists', 'body.page-node-type-article>main>form.search', { componentShared: false, engine: 'ibm', module: 'ibm', wcagCriteria: ['4.1.2'] }),
  ],
};

describe('one problem, one ticket', () => {
  it('ignores <body> classes when matching components', () => {
    expect(normaliseComponent(HEADER('page'))).toBe('body>div.canvas>header.top-layout');
    expect(normaliseComponent('body.home')).toBe('body');
    expect(normaliseComponent('html')).toBe('html');
  });

  it('makes one ticket for a header problem on every page type, and one for a problem both engines found', () => {
    const db = new PregoDb(':memory:');
    const tickets = buildTickets(db, restoreRun(db, json));
    expect(tickets.filter((t) => t.ruleId === 'button-name')).toMatchObject([
      { locationsAffected: 3, occurrences: 3, title: expect.stringMatching(/\(site header, every page\)$/) },
    ]);
    expect(tickets.filter((t) => t.engine === 'ibm')).toEqual([]);
    expect(tickets.find((t) => t.ruleId === 'label')).toMatchObject({ occurrences: 2, labels: expect.arrayContaining(['found-by-two-engines']) });
    db.close();
  });

  it('keeps the ticket ID, and the auditor’s triage, from the old one-per-template grouping', () => {
    const db = new PregoDb(':memory:');
    const project = db.ensureProject('Example');
    // The old grouping gave the header button one ticket per page type; the auditor dismissed the second.
    const legacy = (l: Location, f: RawFinding) => db.ticketIdFor(project.id, fingerprint(f, l.templateKey), 'A11Y', 1).ticketId;
    const [, , first] = [
      db.ticketIdFor(project.id, 'unrelated-a', 'A11Y', 1),
      db.ticketIdFor(project.id, 'unrelated-b', 'A11Y', 1),
      legacy(json.locations[1], json.rawFindings[1]),
    ];
    legacy(json.locations[0], json.rawFindings[0]);
    db.saveOverride(project.id, first, { dismissed: true });
    const tickets = buildTickets(db, restoreRun(db, json));
    expect(tickets.find((t) => t.ruleId === 'button-name')).toMatchObject({ ticketId: first, status: 'Dismissed' });
    db.close();
  });

  it('treats AAA, best practice and spelling as advice', () => {
    expect(isAdvisory({ category: 'A11Y', ruleId: 'target-size-touch', wcagCriterion: '2.5.5', wcagLevel: 'AAA' })).toBe(true);
    expect(isAdvisory({ category: 'A11Y', ruleId: 'region', wcagCriterion: null, wcagLevel: null })).toBe(true);
    expect(isAdvisory({ category: 'CONT', ruleId: 'spelling', wcagCriterion: null, wcagLevel: null })).toBe(true);
    expect(isAdvisory({ category: 'A11Y', ruleId: 'target-size', wcagCriterion: '2.5.8', wcagLevel: 'AA' })).toBe(false);
    expect(isAdvisory({ category: 'SEC', ruleId: 'missing-csp', wcagCriterion: null, wcagLevel: null })).toBe(false);
  });

  it('describes page templates in words', () => {
    expect(templateName('/')).toBe('home page');
    expect(templateName('/news/*/*')).toBe('pages under /news/');
    expect(templateName('/about.html')).toBe('/about.html');
    expect(templateName('/*')).toBe('top-level pages');
    expect(templateName('/*/*')).toBe('second-level pages');
    expect(templateName('/**')).toBe('pages across the site');
  });
});
