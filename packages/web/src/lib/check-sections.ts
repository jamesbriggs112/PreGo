import type { CheckInfo } from '@/lib/api';

/** Headings for the checks list on New audit, in order. A check not listed here goes under Other. */
export const CHECK_SECTIONS: { name: string; ids: string[] }[] = [
  { name: 'Accessibility', ids: ['axe', 'a11y-custom', 'ibm', 'canvas'] },
  { name: 'Content and SEO', ids: ['content', 'html', 'spelling', 'links', 'golive', 'structure'] },
  { name: 'Search, sharing and future readiness', ids: ['sharing', 'future'] },
  { name: 'Design and browsers', ids: ['ui', 'browsers'] },
  { name: 'Performance', ids: ['lighthouse'] },
  { name: 'Security and privacy', ids: ['security', 'libraries', 'software', 'privacy'] },
  { name: 'AI on this computer', ids: ['ai', 'tasks'] },
];

/** The reports a check feeds that need it, so it's clear why to tick it. */
export const CHECK_FEEDS: Record<string, string> = {
  structure: 'Needed for the Content and tone section of the reports.',
  sharing: 'Needed for the Search and future readiness report.',
  future: 'Needed for the Search and future readiness report.',
  tasks: 'Adds the AI walkthrough to the Audience and tasks report.',
};

/** The checks under each heading, keeping the server's order within a heading. Empty headings are left out. */
export function sectionChecks(checks: CheckInfo[]): { name: string; checks: CheckInfo[] }[] {
  const listed = new Set(CHECK_SECTIONS.flatMap((s) => s.ids));
  return [
    ...CHECK_SECTIONS.map((s) => ({ name: s.name, checks: s.ids.map((id) => checks.find((c) => c.id === id)).filter((c): c is CheckInfo => !!c) })),
    { name: 'Other', checks: checks.filter((c) => !listed.has(c.id)) },
  ].filter((s) => s.checks.length);
}
