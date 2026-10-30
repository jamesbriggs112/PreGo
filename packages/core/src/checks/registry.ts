import type { Category } from '../types.js';
import type { FailedPage } from '../crawl/crawler.js';
import type { CheckModule } from './types.js';
import { axeModule } from './axe/axe.js';
import { canvasModule } from './canvas/canvas.js';

/** Everything a check factory may need from the audit. */
export interface CheckFactoryContext {
  startUrl: string;
  /** Crawl only: pages that returned errors, with the page linking to them. */
  failedPages: FailedPage[];
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
