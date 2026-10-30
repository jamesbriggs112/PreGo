import type { Category } from '../types.js';
import type { FailedPage } from '../crawl/crawler.js';
import type { CheckModule } from './types.js';
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

/** Everything a check factory may need from the audit. */
export interface CheckFactoryContext {
  startUrl: string;
  /** Crawl only: pages that returned errors, with the page linking to them. */
  failedPages: FailedPage[];
  basicAuth?: BasicAuth;
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
  create: (context: CheckFactoryContext) => CheckModule;
}

const definitions: CheckDefinition[] = [
  {
    id: 'axe',
    name: 'Accessibility (axe-core)',
    description: 'WCAG 2.2 A and AA rules.',
    categories: ['A11Y'],
    defaultOn: true,
    create: () => axeModule(),
  },
  {
    id: 'a11y-custom',
    name: 'Custom accessibility checks',
    description: 'Keyboard traps, visible focus, reflow at 320px, 200% zoom, text spacing, touch target size, skip links, headings, landmarks and duplicate page titles.',
    categories: ['A11Y'],
    defaultOn: true,
    create: () => customA11yModule(),
  },
  {
    id: 'ui',
    name: 'UI consistency',
    description: 'Colours, typefaces, text sizes, line heights and spacing used across the site, with near-duplicates flagged.',
    categories: ['UI'],
    defaultOn: true,
    create: () => uiConsistencyModule(),
  },
  {
    id: 'content',
    name: 'Content and SEO',
    description: 'Page titles, meta descriptions, Open Graph tags, and alt text that names a file or just says “image”.',
    categories: ['CONT', 'A11Y'],
    defaultOn: true,
    create: () => contentModule(),
  },
  {
    id: 'lighthouse',
    name: 'Performance and best practice (Lighthouse)',
    description: 'Lighthouse performance, best-practice and SEO scores and failing audits, on one page per template.',
    categories: ['PERF', 'TECH', 'CONT'],
    defaultOn: true,
    slow: true,
    create: (context) => lighthouseModule({ basicAuth: context.basicAuth, onRequest: context.onRequest }),
  },
  {
    id: 'security',
    name: 'Security headers',
    description: 'HTTPS, security headers (CSP, HSTS, framing, referrer, permissions, nosniff), cookie flags, mixed content and version disclosure.',
    categories: ['SEC'],
    defaultOn: true,
    create: () => securityModule(),
  },
  {
    id: 'html',
    name: 'HTML validity',
    description: 'Markup checked against the HTML standard with html-validate.',
    categories: ['TECH'],
    defaultOn: true,
    create: () => markupModule(),
  },
  {
    id: 'links',
    name: 'Broken links',
    description: 'Links found while crawling that lead to errors, shown on the pages that contain them.',
    categories: ['UX'],
    defaultOn: true,
    create: (context) => brokenLinksModule(context.failedPages),
  },
  {
    id: 'ibm',
    name: 'Accessibility, second engine (IBM)',
    description: 'IBM Equal Access rules as a second opinion; anything axe already found on the same element is left out.',
    categories: ['A11Y'],
    defaultOn: false,
    create: () => ibmModule(),
  },
  {
    id: 'canvas',
    name: 'Canvas and WebGL detection',
    description: 'Flags large canvas content that automated tools cannot read, for manual review.',
    categories: ['A11Y'],
    defaultOn: true,
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
