/** CSV column presets offered in the GUI (the server's CSV_PRESETS). */
export const CSV_PRESET_OPTIONS = [
  { id: 'prego', label: 'Prego standard columns', hint: 'All 27 columns, as described in the report. Use for spreadsheets or a tool not listed.' },
  { id: 'jira', label: 'Jira', hint: 'Summary, Jira priorities (Highest to Low), one Labels column per label, Issue Type set to Bug, full detail in Description.' },
  { id: 'linear', label: 'Linear', hint: 'Linear priorities (Urgent to Low), comma-separated labels, full detail in Description.' },
  { id: 'productive', label: 'Productive', hint: 'Productive’s seven-column task template. The title starts with the Prego ticket ID; severity, priority, screenshot and full detail go in the description. Start the import from a task list.' },
  { id: 'trello', label: 'Trello', hint: 'Card Name and Card Description, comma-separated labels.' },
];
