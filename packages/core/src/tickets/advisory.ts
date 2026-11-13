import type { Ticket } from '../types.js';

// Advisory findings are worth improving but aren't failures of a standard, so they don't count
// against the scores or lead the recommendations. They're still listed as tickets.

/** Rules that are advice whatever their engine says. */
const ADVISORY_RULES = new Set([
  // Spelling: often names, jargon or other languages.
  'spelling',
  // IBM's orientation rule fires on decorative SVGs sized to their container.
  'element_orientation_unlocked',
]);

/**
 * Whether a ticket is advice rather than a failure: WCAG AAA (such as 44-pixel touch targets), an
 * accessibility best practice with no WCAG criterion behind it (content outside landmarks, heading
 * order), or spelling.
 */
export function isAdvisory(ticket: Pick<Ticket, 'category' | 'ruleId' | 'wcagCriterion' | 'wcagLevel'>): boolean {
  if (ADVISORY_RULES.has(ticket.ruleId)) return true;
  if (ticket.category !== 'A11Y') return false;
  return ticket.wcagLevel === 'AAA' || !ticket.wcagCriterion;
}
