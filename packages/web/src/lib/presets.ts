/** CSV column presets offered in the GUI (the server's CSV_PRESETS). */
export const CSV_PRESET_OPTIONS = [
  { id: 'prego', label: 'Prego standard columns', hint: 'All 27 columns, as described in the report. Use for spreadsheets or a tool not listed.' },
  { id: 'jira', label: 'Jira', hint: 'Summary, Jira priorities (Highest to Low), one Labels column per label, Issue Type set to Bug, full detail in Description.' },
  { id: 'linear', label: 'Linear', hint: 'Linear priorities (Urgent to Low), comma-separated labels, full detail in Description.' },
  { id: 'trello', label: 'Trello', hint: 'Card Name and Card Description, comma-separated labels.' },
];
