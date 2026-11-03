import type { Page } from 'playwright';
import type { Category, Location, Severity } from '../types.js';

/** What a check module sees: one location, open in a browser at one viewport. */
export interface CheckContext {
  page: Page;
  location: Location;
  /** Viewport name, e.g. `desktop` or `mobile+dark`. */
  viewport: string;
  /** Whether the screen is touch (mobile, tablet, kiosk profiles). */
  touch: boolean;
  /** True at the run's first viewport: for checks that should report once per location. */
  firstViewport: boolean;
  /** Keep measurements (such as Lighthouse scores) on the location, for the report. */
  recordMetrics?: (metrics: Record<string, unknown>) => void;
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
  /**
   * The problem belongs to the whole site, not one page or component (a missing security header,
   * colour drift): one ticket site-wide. `component` then says what it's about.
   */
  siteWide?: boolean;
  /** Override the component the finding is grouped under (e.g. the broken link's address). */
  component?: string;
}

/** A finding from a module's finish step, which runs once every location has been checked. */
export interface LocatedFinding extends CheckFinding {
  locationId: number;
  viewport: string;
}

export interface CheckModule {
  id: string;
  name: string;
  /** Run at every viewport (default), or only the first: for checks that don't depend on screen size. */
  perViewport?: boolean;
  run(context: CheckContext): Promise<CheckFinding[]>;
  /** Cross-location findings once everything is checked (duplicate titles, colour drift). */
  finish?(): Promise<LocatedFinding[]>;
  /** Release anything the module opened (a browser), whether the audit finished or not. */
  close?(): Promise<void>;
  /** Given the other modules' findings on the same page, return which of this module's to keep. */
  dedupe?(page: Page, own: CheckFinding[], others: CheckFinding[]): Promise<CheckFinding[]>;
}
