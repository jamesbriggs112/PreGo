// What goes into report.docx beyond the findings: a client-facing layout with written sections, and
// optional sections (analytics, content and tone, information architecture, competitors). Chosen on
// the Export page and kept per audit.

/** Written text the auditor can add. Empty means Prego's own wording (or the section is left out). */
export const REPORT_TEXT_KEYS = ['summary', 'keyFindings', 'recommendations', 'methodology', 'conclusion', 'analytics', 'content', 'ia', 'competitors'] as const;
export type ReportTextKey = (typeof REPORT_TEXT_KEYS)[number];

export const OPTIONAL_SECTIONS = ['analytics', 'content', 'ia', 'competitors'] as const;
export type OptionalSection = (typeof OPTIONAL_SECTIONS)[number];

export interface ReportOptions {
  /**
   * For clients: a contents page, and an executive summary, key findings, top recommendations,
   * methodology and conclusion in the auditor's own words. Off gives the technical report.
   */
  clientFacing: boolean;
  include: Record<OptionalSection, boolean>;
  text: Partial<Record<ReportTextKey, string>>;
}

export const DEFAULT_REPORT_OPTIONS: ReportOptions = {
  clientFacing: false,
  include: { analytics: false, content: false, ia: false, competitors: false },
  text: {},
};

const MAX_TEXT = 20_000;

/** Report options from stored or submitted JSON, with anything missing or invalid set to the default. */
export function parseReportOptions(value: unknown): ReportOptions {
  const v = (value && typeof value === 'object' ? value : {}) as Partial<ReportOptions>;
  const include = { ...DEFAULT_REPORT_OPTIONS.include };
  for (const key of OPTIONAL_SECTIONS) if (typeof v.include?.[key] === 'boolean') include[key] = v.include[key];
  const text: ReportOptions['text'] = {};
  for (const key of REPORT_TEXT_KEYS) {
    const t = v.text?.[key];
    if (typeof t === 'string' && t.trim()) text[key] = t.slice(0, MAX_TEXT);
  }
  return { clientFacing: v.clientFacing === true, include, text };
}

/** Lines of written text as list items, without any bullet or number the auditor typed. */
export function listItems(text: string): string[] {
  return text
    .split('\n')
    .map((line) => line.replace(/^\s*(?:[-*•]|\d+[.)])\s*/, '').trim())
    .filter(Boolean);
}
