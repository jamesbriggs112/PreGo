import type { AudienceProfile } from '../audience/types.js';
import { CATEGORY_NAMES, type AnalyticsSummary, type Category, type Location, type Run, type Ticket } from '../types.js';
import { assessReadiness } from '../export/readiness.js';
import { treeTest, type TaskOutcome } from '../tasks/tree.js';
import type { WalkResult } from '../tasks/walkthrough.js';

// The figures at the top of an audit's results, each with a traffic light, and signs that the site
// may not be meeting a legal obligation. Everything here comes from what the audit already recorded:
// nothing is fetched or tested to work it out.

/** Good (green), fair (amber) or poor (red). Null for figures that are context, not a judgement. */
export type Rating = 'good' | 'fair' | 'poor';

export interface DashboardTile {
  id: string;
  label: string;
  value: string;
  /** Shown smaller after the value, e.g. "/ 100". */
  suffix?: string;
  rating: Rating | null;
  /** What the figure means or how it was worked out, in a short sentence. */
  note?: string;
}

/** Possible risk (red) when the signs are strong, worth checking (amber) when they're weaker. */
export type LegalLevel = 'risk' | 'check';

export interface LegalSignal {
  id: string;
  area: string;
  level: LegalLevel;
  /** The laws or regulations it may touch, by name. UK law. */
  laws: string[];
  /** Why it may matter, in plain words. Never says the law is broken. */
  why: string;
  /** What Prego found, a line each. */
  evidence: string[];
}

export interface LegalSummary {
  signals: LegalSignal[];
  /** Areas Prego looked at and found no sign of a problem. Not a statement that the site complies. */
  clear: string[];
  /** Areas it couldn't look at in this audit, and why. */
  notChecked: string[];
  /** The address looks like a UK public sector body, which has extra accessibility duties. */
  publicSector: boolean;
}

export interface Dashboard {
  tiles: DashboardTile[];
  legal: LegalSummary;
}

export interface DashboardInput {
  run: Pick<Run, 'mode' | 'target' | 'summary'>;
  locations: Location[];
  /** Open tickets only. */
  tickets: Ticket[];
  scores: Partial<Record<Category, number>>;
  /** IDs of the check modules that ran. */
  checks: string[];
  audience?: AudienceProfile;
  analytics?: AnalyticsSummary;
}

/** Scores out of 100, rated like Lighthouse: 90 and up good, 50 to 89 fair, under 50 poor. */
export const scoreLight = (score: number): Rating => (score >= 90 ? 'good' : score >= 50 ? 'fair' : 'poor');
/** Counts of problems: none good, a few fair, more poor. */
const countRating = (count: number, few: number): Rating => (count === 0 ? 'good' : count <= few ? 'fair' : 'poor');
const plural = (n: number, word: string, many = `${word}s`) => `${n} ${n === 1 ? word : many}`;

export function buildDashboard(input: DashboardInput): Dashboard {
  const legal = legalSignals(input);
  return { tiles: dashboardTiles(input, legal), legal };
}

export function dashboardTiles(input: DashboardInput, legal: LegalSummary = legalSignals(input)): DashboardTile[] {
  const { run, locations, tickets, scores } = input;
  const s = run.summary as Record<string, number>;
  const tiles: DashboardTile[] = Object.entries(scores).map(([category, score]) => ({
    id: `score-${category}`,
    label: `${CATEGORY_NAMES[category as Category]} score`,
    value: String(score),
    suffix: '/ 100',
    rating: scoreLight(score),
    note: category === 'PERF' ? 'Lighthouse’s average performance score.' : undefined,
  }));

  const readiness = assessReadiness(locations);
  if (readiness) {
    tiles.push({ id: 'readiness', label: 'Future readiness', value: String(readiness.score), suffix: '/ 100', rating: scoreLight(readiness.score), note: 'Search, sharing, AI assistants and voice search.' });
  }

  const serious = tickets.filter((t) => t.severity === 'Critical' || t.severity === 'High').length;
  tiles.push({ id: 'tickets', label: 'Tickets', value: String(tickets.length), rating: countRating(serious, 3), note: `${serious} critical or high.` });

  if (input.audience?.tasks.length && input.audience.personas.length) {
    const tree = treeTest(input.audience, locations);
    const walk = (run.summary.walkthrough as WalkResult[] | undefined) ?? [];
    const outcome = (taskId: string): TaskOutcome => {
      const found = [tree.find((r) => r.taskId === taskId)?.outcome, walk.find((r) => r.taskId === taskId)?.outcome].filter((o): o is TaskOutcome => !!o && o !== 'unchecked');
      return found.includes('failed') ? 'failed' : found.includes('partial') ? 'partial' : found.includes('success') ? 'success' : 'unchecked';
    };
    const tested = input.audience.tasks.map((t) => outcome(t.id)).filter((o) => o !== 'unchecked');
    if (tested.length) {
      const done = tested.filter((o) => o === 'success').length;
      tiles.push({
        id: 'tasks',
        label: 'Tasks people can complete',
        value: `${done} of ${tested.length}`,
        rating: done === tested.length ? 'good' : done * 2 >= tested.length ? 'fair' : 'poor',
        note: 'From the navigation test of each persona’s tasks.',
      });
    }
  }

  const risks = legal.signals.filter((l) => l.level === 'risk').length;
  tiles.push({
    id: 'legal',
    label: 'Possible legal risks',
    value: String(risks),
    rating: risks ? 'poor' : legal.signals.length ? 'fair' : 'good',
    note: legal.signals.length > risks ? `And ${plural(legal.signals.length - risks, 'thing')} worth checking.` : 'Signs only, not legal advice.',
  });

  if (run.mode === 'explore') tiles.push({ id: 'screens', label: 'Screens audited', value: String(s.statesAudited ?? 0), rating: null });
  else if (run.mode === 'journey') tiles.push({ id: 'steps', label: 'Journey steps audited', value: `${s.stepsReplayed} of ${s.stepsRecorded}`, rating: null });
  else {
    tiles.push({ id: 'pages', label: 'Pages audited', value: `${s.pagesAudited} of ${s.pagesFound}`, rating: null });
    tiles.push({ id: 'links', label: 'Broken links', value: String(s.brokenLinks ?? 0), rating: countRating(s.brokenLinks ?? 0, 5) });
  }

  const devices = input.analytics?.tables.find((t) => t.id === 'devices');
  const total = devices?.rows.reduce((sum, r) => sum + r.value, 0) ?? 0;
  if (devices && total) {
    const mobile = Math.round(((devices.rows.find((r) => /mobile/i.test(r.label))?.value ?? 0) / total) * 100);
    tiles.push({ id: 'mobile', label: 'Visitors on phones', value: `${mobile}%`, rating: null, note: 'From the imported Google Analytics figures.' });
  }
  return tiles;
}

/** UK public sector domains, which come under the Public Sector Bodies Accessibility Regulations. */
const PUBLIC_SECTOR = /\.(gov|police|nhs|ac|sch|mod|parliament)\.uk$|\.gov\.(scot|wales)$|\.llyw\.cymru$|\.nhs\.scot$/i;
const STATEMENT = /accessib/i;
const PRIVACY = /privacy|data[\s-]?protection|gdpr/i;

/** Whether any page the audit found looks like it, from its address or title. */
const foundPage = (locations: Location[], pattern: RegExp) => locations.find((l) => l.kind === 'page' && (pattern.test(l.url) || pattern.test(l.title ?? '')));

/**
 * Signs that the site may not be meeting a legal obligation, from the audit's findings. These are
 * prompts to check with someone qualified, never a finding that the law is broken, and say nothing
 * about compliance. UK law.
 */
export function legalSignals(input: DashboardInput): LegalSummary {
  const { tickets, locations, checks, run } = input;
  let host = '';
  try {
    host = new URL(run.target).hostname;
  } catch {
    // A journey or an unusual target: treat as not public sector.
  }
  const publicSector = PUBLIC_SECTOR.test(host);
  const signals: LegalSignal[] = [];
  const clear: string[] = [];
  const notChecked: string[] = [];
  const ran = (...ids: string[]) => ids.some((id) => checks.includes(id));
  const crawl = run.mode === 'crawl';
  const pagesFound = locations.filter((l) => l.kind === 'page').length;

  // Accessibility: WCAG level A and AA failures, from the accessibility checks or any other check that found them.
  const engines = ran('axe', 'ibm', 'a11y-custom');
  const failing = tickets.filter((t) => t.category === 'A11Y' && (t.wcagLevel === 'A' || t.wcagLevel === 'AA'));
  if (engines || failing.length) {
    if (failing.length) {
      const serious = failing.filter((t) => t.severity === 'Critical' || t.severity === 'High');
      const criteria = [...new Set(failing.map((t) => t.wcagCriterion).filter((c): c is string => !!c))].sort();
      signals.push({
        id: 'accessibility',
        area: 'Accessibility for disabled people',
        level: serious.length || publicSector ? 'risk' : 'check',
        laws: publicSector
          ? ['Public Sector Bodies (Websites and Mobile Applications) Accessibility Regulations 2018', 'Equality Act 2010']
          : ['Equality Act 2010', 'European Accessibility Act, if the site sells certain services to people in the EU'],
        why: publicSector
          ? 'Public sector websites must meet WCAG 2.2 level AA unless meeting it would be a disproportionate burden. Issues at level A or AA suggest parts of the site may fall short.'
          : 'Service providers must make reasonable adjustments so disabled people aren’t put at a substantial disadvantage, and an inaccessible website is a common reason for complaints. WCAG level A and AA is the usual yardstick.',
        evidence: [
          `${plural(failing.length, 'issue')} fail a WCAG level A or AA success criterion${serious.length ? `, ${serious.length} of them critical or high` : ''}.`,
          ...(criteria.length ? [`Criteria affected: ${criteria.slice(0, 8).join(', ')}${criteria.length > 8 ? ` and ${criteria.length - 8} more` : ''}.`] : []),
          ...serious.slice(0, 3).map((t) => `${t.severity}: ${t.title}`),
          ...(engines ? [] : ['The accessibility checks didn’t run, so there may be more.']),
        ],
      });
    } else clear.push('Accessibility: no WCAG level A or AA issues were found by the automated checks, which catch only part of what WCAG asks.');
  } else notChecked.push('Accessibility: no accessibility check ran in this audit.');

  // Accessibility statement.
  if (crawl) {
    const statement = foundPage(locations, STATEMENT);
    if (statement) clear.push(`Accessibility statement: found at ${new URL(statement.url).pathname}.`);
    else if (publicSector) {
      signals.push({
        id: 'statement',
        area: 'Accessibility statement',
        level: 'risk',
        laws: ['Public Sector Bodies (Websites and Mobile Applications) Accessibility Regulations 2018'],
        why: 'Public sector websites must publish an accessibility statement in the required format and keep it up to date.',
        evidence: [`No page with “accessibility” in its address or title was among the ${plural(pagesFound, 'page')} Prego found. It may exist on a page the crawl didn’t reach.`],
      });
    } else {
      signals.push({
        id: 'statement',
        area: 'Accessibility statement',
        level: 'check',
        laws: ['European Accessibility Act, if the site sells certain services to people in the EU'],
        why: 'An accessibility statement isn’t required of every private site in the UK, but it’s expected under the European Accessibility Act for some services, and it shows disabled visitors how to get help.',
        evidence: [`No page with “accessibility” in its address or title was among the ${plural(pagesFound, 'page')} Prego found.`],
      });
    }
  } else notChecked.push('Accessibility statement and privacy notice: only a site crawl finds enough pages to look for them.');

  // Cookies and tracking before consent.
  if (ran('privacy')) {
    const before = tickets.filter((t) => t.ruleId === 'trackers-before-consent' || t.ruleId === 'tracking-cookies-before-consent');
    if (before.length) {
      signals.push({
        id: 'consent',
        area: 'Cookies and tracking before consent',
        level: 'risk',
        laws: ['Privacy and Electronic Communications Regulations 2003 (PECR), regulation 6', 'UK GDPR'],
        why: 'Non-essential cookies and similar tracking, such as analytics and advertising, need the visitor’s consent before they’re set or load. Prego saw them on a first visit before anything on the cookie banner was clicked.',
        evidence: before.map((t) => t.title),
      });
    } else clear.push('Cookies and tracking: no known trackers or tracking cookies loaded before consent on the pages checked.');
  } else notChecked.push('Cookies and tracking before consent: the Cookies and privacy check didn’t run.');

  // Privacy notice.
  if (crawl) {
    const notice = foundPage(locations, PRIVACY);
    if (notice) clear.push(`Privacy notice: found at ${new URL(notice.url).pathname}.`);
    else {
      signals.push({
        id: 'privacy-notice',
        area: 'Privacy notice',
        level: 'check',
        laws: ['UK GDPR, articles 13 and 14'],
        why: 'If the site collects personal data, through forms, accounts, newsletters or analytics, people must be told clearly what is collected and why. That’s usually a privacy notice linked from every page.',
        evidence: [`No page with “privacy” or “data protection” in its address or title was among the ${plural(pagesFound, 'page')} Prego found.`],
      });
    }
  }

  // Security of personal data in transit.
  if (ran('security')) {
    const insecure = tickets.filter((t) => ['no-https', 'mixed-content', 'certificate-expired', 'old-tls'].includes(t.ruleId));
    if (insecure.length) {
      signals.push({
        id: 'security',
        area: 'Keeping personal data secure',
        level: insecure.some((t) => t.ruleId === 'no-https' || t.ruleId === 'certificate-expired') ? 'risk' : 'check',
        laws: ['UK GDPR, article 32 (security of processing)'],
        why: 'Organisations must protect personal data with appropriate security. Pages, forms or files sent without working encryption could expose what visitors send.',
        evidence: insecure.map((t) => t.title),
      });
    } else clear.push('Security: the site uses HTTPS with a valid certificate and no insecure content was found.');
  } else notChecked.push('Keeping personal data secure: the security check didn’t run.');

  return { signals, clear, notChecked, publicSector };
}
