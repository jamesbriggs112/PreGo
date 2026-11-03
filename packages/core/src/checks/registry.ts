import type { Category } from '../types.js';
import type { FailedPage } from '../crawl/crawler.js';
import type { CheckModule } from './types.js';
import type { CheckCost } from './estimate.js';
import { axeModule } from './axe/axe.js';
import { canvasModule } from './canvas/canvas.js';
import { customA11yModule } from './a11y-custom/a11y-custom.js';
import { uiConsistencyModule } from './ui/ui.js';
import { contentModule } from './content/content.js';
import { lighthouseModule } from './lighthouse/lighthouse.js';
import type { BasicAuth } from '../browser/session.js';
import { securityModule } from './security/security.js';
import { markupModule } from './markup/markup.js';
import { brokenLinksModule } from './links/links.js';
import { ibmModule } from './ibm/ibm.js';
import { goLiveModule } from './golive/golive.js';
import { librariesModule } from './libraries/libraries.js';
import { privacyModule } from './privacy/privacy.js';
import { spellingModule } from './spelling/spelling.js';
import { browsersModule } from './browsers/browsers.js';
import { aiModule, type AiSettings } from './ai/ai.js';

/** Everything a check factory may need from the audit. */
export interface CheckFactoryContext {
  startUrl: string;
  /** Crawl only: pages that returned errors, with the page linking to them. */
  failedPages: FailedPage[];
  basicAuth?: BasicAuth;
  /** Ollama on this computer, when AI review is switched on in Settings. */
  ai?: AiSettings;
  /** Told about requests made by browsers that Prego doesn't open through BrowserSession. */
  onRequest?: (url: string) => void;
}

export interface CheckDefinition {
  id: string;
  name: string;
  /** One line for the New audit form. */
  description: string;
  categories: Category[];
  /** Ticked by default in the GUI and CLI. */
  defaultOn: boolean;
  /** Takes long enough that tests and quick runs skip it unless asked (e.g. Lighthouse). */
  slow?: boolean;
  /** Typical time it adds, for estimates before Prego has timed real audits. */
  cost: Omit<CheckCost, 'id'>;
  create: (context: CheckFactoryContext) => CheckModule;
}

const definitions: CheckDefinition[] = [
  {
    id: 'axe',
    name: 'Accessibility (axe-core)',
    description: 'WCAG 2.2 A and AA rules.',
    categories: ['A11Y'],
    defaultOn: true,
    cost: { seconds: [0.3, 0.8] },
    create: () => axeModule(),
  },
  {
    id: 'a11y-custom',
    name: 'Custom accessibility checks',
    description: 'Keyboard traps, visible focus, reflow at 320px, 200% zoom, text spacing, touch target size, skip links, headings, landmarks and duplicate page titles.',
    categories: ['A11Y'],
    defaultOn: true,
    cost: { seconds: [0.6, 1.5] },
    create: () => customA11yModule(),
  },
  {
    id: 'ui',
    name: 'UI consistency',
    description: 'Colours, typefaces, text sizes, line heights and spacing used across the site, with near-duplicates flagged.',
    categories: ['UI'],
    defaultOn: true,
    cost: { seconds: [0.2, 0.5], perPage: true },
    create: () => uiConsistencyModule(),
  },
  {
    id: 'content',
    name: 'Content and SEO',
    description: 'Page titles, meta descriptions, Open Graph tags, and alt text that names a file or just says “image”.',
    categories: ['CONT', 'A11Y'],
    defaultOn: true,
    cost: { seconds: [0.05, 0.15], perPage: true },
    create: () => contentModule(),
  },
  {
    id: 'spelling',
    name: 'Spelling (British English)',
    description: 'Words in the main content that aren’t in the British English dictionary, with suggestions. Names, acronyms and codes are skipped; dismiss a word once and it stays quiet.',
    categories: ['CONT'],
    defaultOn: true,
    cost: { seconds: [0.05, 0.3], perPage: true },
    create: () => spellingModule(),
  },
  {
    id: 'browsers',
    name: 'Firefox and Safari',
    description: 'A page of each template opened again in Firefox and in WebKit (Safari’s engine) at the same window size, and compared with Chrome: script errors, sideways scrolling, content that disappears and layout that shifts.',
    categories: ['UX'],
    defaultOn: false,
    cost: { seconds: [3, 8], perPage: true, setupSeconds: [2, 5] },
    create: (context) => browsersModule({ basicAuth: context.basicAuth, onRequest: context.onRequest }),
  },
  {
    id: 'lighthouse',
    name: 'Performance and best practice (Lighthouse)',
    description: 'Lighthouse performance, best-practice and SEO scores and failing audits, on one page per template.',
    categories: ['PERF', 'TECH', 'CONT'],
    defaultOn: true,
    slow: true,
    cost: { seconds: [6, 12], perPage: true, serial: true, setupSeconds: [3, 6] },
    create: (context) => lighthouseModule({ basicAuth: context.basicAuth, onRequest: context.onRequest }),
  },
  {
    id: 'security',
    name: 'Security headers and certificate',
    description: 'HTTPS, the certificate’s expiry and trust, outdated TLS versions, security headers (with the CSP checked by Google’s CSP Evaluator), cookie flags, mixed content and version disclosure. Passive: nothing is attacked.',
    categories: ['SEC'],
    defaultOn: true,
    cost: { seconds: [0.02, 0.1], perPage: true },
    create: () => securityModule(),
  },
  {
    id: 'libraries',
    name: 'Outdated JavaScript libraries',
    description: 'Scripts the pages load, checked against the Retire.js database of libraries with published vulnerabilities (a copy kept on this computer).',
    categories: ['SEC'],
    defaultOn: true,
    cost: { seconds: [0.05, 0.5], perPage: true },
    create: () => librariesModule(),
  },
  {
    id: 'privacy',
    name: 'Cookies and privacy',
    description: 'Opens a page of each template as a first-time visitor, without touching the cookie banner, and flags trackers and tracking cookies that start before consent. Lists every outside service contacted. Tracker requests are blocked, not sent.',
    categories: ['SEC'],
    defaultOn: true,
    cost: { seconds: [2, 5], perPage: true },
    create: (context) => privacyModule({ basicAuth: context.basicAuth, onRequest: context.onRequest }),
  },
  {
    id: 'html',
    name: 'HTML validity',
    description: 'Markup checked against the HTML standard with html-validate.',
    categories: ['TECH'],
    defaultOn: true,
    cost: { seconds: [0.1, 0.4], perPage: true },
    create: () => markupModule(),
  },
  {
    id: 'links',
    name: 'Broken links',
    description: 'Links found while crawling that lead to errors, shown on the pages that contain them.',
    categories: ['UX'],
    defaultOn: true,
    cost: { seconds: [0, 0.01], perPage: true },
    create: (context) => brokenLinksModule(context.failedPages),
  },
  {
    id: 'golive',
    name: 'Go-live mistakes',
    description: 'Staging leftovers (noindex, robots.txt blocking everything, links to staging addresses), placeholder text, missing pages that don’t return 404, and a missing sitemap, favicon or analytics.',
    categories: ['TECH', 'CONT'],
    defaultOn: true,
    cost: { seconds: [0.05, 0.2], perPage: true },
    create: () => goLiveModule(),
  },
  {
    id: 'ibm',
    name: 'Accessibility, second engine (IBM)',
    description: 'IBM Equal Access rules as a second opinion; anything axe already found on the same element is left out.',
    categories: ['A11Y'],
    defaultOn: false,
    cost: { seconds: [0.5, 1.5] },
    create: () => ibmModule(),
  },
  {
    id: 'ai',
    name: 'AI heuristic review (local)',
    description: 'A vision model running in Ollama on this computer reviews a screenshot of each template against Nielsen’s 10 usability heuristics. Its findings are marked AI-suggested and stay out of reports until you approve them. Switch it on in Settings.',
    categories: ['UX'],
    defaultOn: false,
    slow: true,
    cost: { seconds: [15, 60], perPage: true, serial: true },
    create: (context) => aiModule(context.ai),
  },
  {
    id: 'canvas',
    name: 'Canvas and WebGL detection',
    description: 'Flags large canvas content that automated tools cannot read, for manual review.',
    categories: ['A11Y'],
    defaultOn: true,
    cost: { seconds: [0.03, 0.1] },
    create: () => canvasModule(),
  },
];

/** Add a check to the registry. Modules register themselves here as they're built. */
export function registerCheck(definition: CheckDefinition) {
  const existing = definitions.findIndex((d) => d.id === definition.id);
  if (existing >= 0) definitions.splice(existing, 1, definition);
  else definitions.push(definition);
}

export function checkDefinitions(): readonly CheckDefinition[] {
  return definitions;
}

/** Checks run when none are chosen: everything on by default except the slow ones. */
export function defaultChecks(): string[] {
  return definitions.filter((d) => d.defaultOn && !d.slow).map((d) => d.id);
}

export function checkCosts(ids?: string[]): CheckCost[] {
  return definitions.filter((d) => !ids || ids.includes(d.id)).map((d) => ({ id: d.id, ...d.cost }));
}

export function unknownChecks(ids: string[]): string[] {
  return ids.filter((id) => !definitions.some((d) => d.id === id));
}

export function createChecks(ids: string[], context: CheckFactoryContext): CheckModule[] {
  return ids.map((id) => {
    const definition = definitions.find((d) => d.id === id);
    if (!definition) throw new Error(`Unknown check "${id}"`);
    return definition.create(context);
  });
}
