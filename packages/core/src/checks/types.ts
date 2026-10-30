import type { Page } from 'playwright';
import type { Category, Location, Severity } from '../types.js';

/** What a check module sees: one location, open in a browser at one viewport. */
export interface CheckContext {
  page: Page;
  location: Location;
  /** Viewport name, e.g. `desktop` or `mobile+dark`. */
  viewport: string;
}

/**
 * The common finding format every check module returns. The audit runner adds the run, location
 * and viewport, and stores it as a RawFinding.
 */
export interface CheckFinding {
  module: string;
  engine: string;
  ruleId: string;
  category: Category;
  severity: Severity;
  /** Plain-English summary of the problem. */
  title: string;
  description: string;
  helpUrl: string | null;
  /** WCAG success criteria, e.g. `['1.4.3']`. Empty for best-practice rules. */
  wcagCriteria: string[];
  /** `A`, `AA` or `AAA`; null for best-practice rules. */
  wcagLevel: string | null;
  /** CSS selector for the element, or `html` for page-level problems. */
  selector: string;
  /** Outer HTML of the element, trimmed. */
  html: string;
  /** Engine's explanation of why this element failed. */
  failureSummary: string | null;
}

export interface CheckModule {
  id: string;
  name: string;
  run(context: CheckContext): Promise<CheckFinding[]>;
}
