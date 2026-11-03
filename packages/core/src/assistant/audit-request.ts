import { CHECK_GROUPS } from '../checks/estimate.js';
import { isProfileName, type ProfileName } from '../browser/profiles.js';
import { assertLocalOllama, type AiSettings } from '../checks/ai/ai.js';

// Turns a plain-English request ("run an accessibility audit on fcn.com on mobile") into audit
// settings. A built-in reader handles the usual phrasing; with AI review switched on, a local Ollama
// model reads looser wording. Either way nothing starts until someone confirms the settings.

/** Audit settings read from a request. Anything not mentioned is left out, for defaults to fill. */
export interface AuditRequest {
  project?: string;
  /** Web address, always with http:// or https://. */
  target?: string;
  mode?: 'crawl' | 'explore';
  /** Test group IDs from CHECK_GROUPS. */
  groups?: string[];
  viewports?: ProfileName[];
  maxPages?: number;
  /** Audit every page, not a sample per template. */
  auditAll?: boolean;
}

const GROUP_WORDS: [string, RegExp][] = [
  ['full', /\b(full|everything|all (the )?(checks|tests)|complete|mega|thorough)\b/i],
  ['quick', /\b(quick|basic|smoke|sanity|go[- ]live|pre[- ]launch)\b/i],
  ['accessibility', /\b(accessib\w*|a11y|wcag|screen readers?|keyboard|disab\w*)\b/i],
  ['content', /\b(content|seo|spelling|typos?|copy|meta ?(data|descriptions?)|alt text)\b/i],
  ['design', /\b(design|visual|look and feel|brand|browsers?|safari|firefox|cross[- ]browser)\b/i],
  ['performance', /\b(performance|speed|fast|slow|lighthouse|core web vitals|load(ing)? times?)\b/i],
  ['security', /\b(security|secure|headers?|https|ssl|tls|cookies?|privacy|gdpr|trackers?)\b/i],
];

const VIEWPORT_WORDS: [ProfileName, RegExp][] = [
  ['desktop', /\b(desktop|laptop|computer|pc|mac)\b/i],
  ['mobile', /\b(mobile|phones?|iphone|android|small screens?)\b/i],
  ['tablet', /\b(tablets?|ipad)\b/i],
];

const ALL_SIZES = /\b(all|every|each) (screen )?(sizes?|devices?|viewports?|screens?)\b/i;

/** The built-in reader: keywords and patterns, no AI. */
export function readAuditRequest(text: string): AuditRequest {
  const request: AuditRequest = {};
  const target = findAddress(text);
  if (target) request.target = target;

  const quoted = /["“]([^"”]{1,80})["”]/.exec(text)?.[1] ?? /\bproject (?:called |named )?([A-Z][\w&'’ -]{0,60}?)(?=[,.;]|\s+(?:on|at|for|with|using)\b|$)/.exec(text)?.[1];
  if (quoted?.trim()) request.project = quoted.trim();

  // "full" covers every group, so it wins on its own.
  const groups = GROUP_WORDS.filter(([, words]) => words.test(text)).map(([id]) => id);
  if (groups.includes('full')) request.groups = ['full'];
  else if (groups.length) request.groups = groups.filter((id) => id !== 'quick' || groups.length === 1);

  if (ALL_SIZES.test(text)) request.viewports = ['desktop', 'mobile', 'tablet'];
  else {
    const viewports = VIEWPORT_WORDS.filter(([, words]) => words.test(text)).map(([name]) => name);
    if (/\bkiosk/i.test(text)) viewports.push(/\bportrait\b/i.test(text) ? 'kiosk-portrait' : 'kiosk-landscape');
    if (viewports.length) request.viewports = viewports;
  }

  if (/\b(explore|interactive|single[- ]page app|spa|kiosk app|clicking through)\b/i.test(text)) request.mode = 'explore';
  const pages = /\b(\d{1,5})\s*(pages?|screens?)\b/i.exec(text);
  if (pages) request.maxPages = Number(pages[1]);
  if (/\b(every|all( the)?) pages?\b|\bwhole site\b|\bentire site\b/i.test(text)) request.auditAll = true;
  return request;
}

/** The first web address in the text, as https:// unless it says http://. Email addresses don't count. */
export function findAddress(text: string): string | undefined {
  const pattern = /(?<![@\w.-])(https?:\/\/)?(localhost|\d{1,3}(?:\.\d{1,3}){3}|(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)+[a-z]{2,24})(:\d{2,5})?(\/[^\s"'<>]*)?/gi;
  for (const [, scheme, host, port = '', path = ''] of text.matchAll(pattern)) {
    // Common file names look like domains ("report.docx"), and "localhost" alone may just be a word.
    if (!scheme && (/\.(docx?|pdf|csv|png|jpe?g|json|txt|zip)$/i.test(host) || (host === 'localhost' && !port))) continue;
    const cleanPath = path.replace(/[.,;:!?)\]]+$/, '');
    try {
      return new URL(`${scheme ?? 'https://'}${host.toLowerCase()}${port}${cleanPath || '/'}`).href;
    } catch {
      continue;
    }
  }
  return undefined;
}

const PROFILES: ProfileName[] = ['desktop', 'mobile', 'tablet', 'kiosk-landscape', 'kiosk-portrait'];

const SCHEMA = {
  type: 'object',
  properties: {
    project: { type: 'string' },
    site: { type: 'string' },
    groups: { type: 'array', items: { enum: CHECK_GROUPS.map((g) => g.id) } },
    viewports: { type: 'array', items: { enum: PROFILES } },
    maxPages: { type: 'integer' },
    everyPage: { type: 'boolean' },
    interactive: { type: 'boolean' },
  },
  required: ['project', 'site', 'groups', 'viewports', 'maxPages', 'everyPage', 'interactive'],
};

const PROMPT = `You set up website audits in a testing tool called Prego. Read the request and fill in the
settings. Leave a field empty ("" or [] or 0 or false) when the request doesn't say.

- project: the project or client name, only if the request names one.
- site: the web address to audit, exactly as written in the request.
- groups: the kinds of testing asked for. ${CHECK_GROUPS.map((g) => `${g.id} (${g.name}: ${g.description})`).join('; ')}.
- viewports: screen sizes asked for: ${PROFILES.join(', ')}.
- maxPages: a page limit, if one is given.
- everyPage: true if they want every page checked, not a sample.
- interactive: true if it's an interactive, kiosk app or single-page app to explore by pressing buttons.

Request: `;

const TIMEOUT_MS = 60_000;

/** Ask the local Ollama model to read the request. Exported for tests. */
export async function askOllama(settings: AiSettings, text: string, fetchImpl: typeof fetch = fetch): Promise<AuditRequest> {
  const base = assertLocalOllama(settings.url);
  const res = await fetchImpl(new URL('/api/chat', base), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    signal: AbortSignal.timeout(TIMEOUT_MS),
    body: JSON.stringify({ model: settings.model, stream: false, format: SCHEMA, options: { temperature: 0 }, messages: [{ role: 'user', content: PROMPT + text }] }),
  });
  if (!res.ok) throw new Error(`Ollama answered ${res.status}: ${(await res.text()).slice(0, 200)}`);
  const body = (await res.json()) as { message?: { content?: string } };
  const answer = JSON.parse(body.message?.content ?? '{}') as Partial<Record<keyof typeof SCHEMA.properties, unknown>>;

  const request: AuditRequest = {};
  if (typeof answer.project === 'string' && answer.project.trim()) request.project = answer.project.trim().slice(0, 200);
  // The address must come from the request itself, never from the model's imagination.
  const site = typeof answer.site === 'string' ? findAddress(answer.site) : undefined;
  if (site && text.toLowerCase().includes(new URL(site).hostname.replace(/^www\./, ''))) request.target = site;
  const groups = Array.isArray(answer.groups) ? answer.groups.filter((g): g is string => CHECK_GROUPS.some((c) => c.id === g)) : [];
  if (groups.length) request.groups = groups.includes('full') ? ['full'] : [...new Set(groups)];
  const viewports = Array.isArray(answer.viewports) ? answer.viewports.filter((v): v is ProfileName => typeof v === 'string' && isProfileName(v)) : [];
  if (viewports.length) request.viewports = [...new Set(viewports)];
  if (Number.isInteger(answer.maxPages) && (answer.maxPages as number) > 0) request.maxPages = Math.min(answer.maxPages as number, 10_000);
  if (answer.everyPage === true) request.auditAll = true;
  if (answer.interactive === true) request.mode = 'explore';
  return request;
}

/**
 * Read a request with Ollama when it's switched on, filling anything the model missed from the
 * built-in reader. Falls back to the reader alone if Ollama can't be reached.
 */
export async function understandAuditRequest(
  text: string,
  ai: AiSettings | undefined,
  fetchImpl: typeof fetch = fetch,
): Promise<{ request: AuditRequest; source: 'ollama' | 'reader'; note?: string }> {
  const read = readAuditRequest(text);
  if (!ai) return { request: read, source: 'reader' };
  try {
    const asked = await askOllama(ai, text, fetchImpl);
    // The reader's address is exact, so prefer it when both found one.
    return { request: { ...read, ...asked, ...(read.target && { target: read.target }) }, source: 'ollama' };
  } catch (error) {
    return { request: read, source: 'reader', note: `Ollama didn’t answer (${(error as Error).message}), so Prego read the request itself.` };
  }
}
