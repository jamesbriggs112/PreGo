// What the team knows about the client, typed in by a person: never found or guessed by an audit.
// Kept on this computer with the project. Reports can include the background fields; contacts and
// internal notes are never exported.

export interface ClientInfo {
  /** What the organisation does, in a sentence or two. */
  about?: string;
  sector?: string;
  /** What the client wants the site to achieve. */
  goals?: string;
  /** Who the site is for, in the client's words. */
  audiences?: string;
  /** Limits on what can change: platform, budget, deadlines, brand rules. */
  constraints?: string;
  /** Who to talk to, and their roles. Kept in Prego only. */
  contacts?: string;
  /** Whether the host says it runs on renewable energy, for the carbon estimate. */
  greenHosting?: 'yes' | 'no' | 'unknown';
  /** Anything else for the team. Kept in Prego only. */
  notes?: string;
  updatedAt?: string;
}

export const CLIENT_TEXT_FIELDS = ['about', 'sector', 'goals', 'audiences', 'constraints', 'contacts', 'notes'] as const;
/** The fields a report may show. */
export const CLIENT_REPORT_FIELDS = ['about', 'sector', 'goals', 'audiences', 'constraints'] as const;
const MAX = 10_000;

/** Client details from submitted JSON: text trimmed and limited, anything else dropped. */
export function parseClientInfo(value: unknown): ClientInfo {
  const v = (value && typeof value === 'object' ? value : {}) as Record<string, unknown>;
  const out: ClientInfo = {};
  for (const key of CLIENT_TEXT_FIELDS) {
    const text = v[key];
    if (typeof text === 'string' && text.trim()) out[key] = text.trim().slice(0, MAX);
  }
  if (v.greenHosting === 'yes' || v.greenHosting === 'no') out.greenHosting = v.greenHosting;
  return out;
}

/** Whether the report has anything to say about the client. */
export function hasClientBackground(info: ClientInfo | undefined): boolean {
  return !!info && CLIENT_REPORT_FIELDS.some((k) => info[k]);
}
