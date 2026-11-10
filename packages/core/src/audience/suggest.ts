import { assertLocalOllama, type AiSettings } from '../checks/ai/ai.js';
import type { AnalyticsSummary, Location, Project } from '../types.js';
import type { NavigationMetrics } from '../export/sections.js';
import type { AudienceProfile, AudienceSuggestion, PageSignals, Persona, PersonaDevice, Purpose, TaskSuccess, UserTask } from './types.js';

/** What Prego knows about a site from an audit, for suggesting its purposes and audiences. */
export interface SiteFacts {
  name: string;
  pages: { path: string; title: string; headings: string[]; signals?: PageSignals }[];
  navigation: { label: string; path: string | null }[];
  analytics?: AnalyticsSummary;
  /** What people search for to find the site, from Search Console, most clicked first. */
  searches: string[];
}

export function siteFacts(project: Project, locations: Location[]): SiteFacts {
  const pathOf = (url: string) => {
    try {
      return new URL(url).pathname;
    } catch {
      return url;
    }
  };
  const pages = locations
    .filter((l) => l.kind === 'page' && (l.statusCode ?? 200) < 400)
    .map((l) => {
      const signals = l.metrics.signals as PageSignals | undefined;
      return { path: pathOf(l.url), title: l.title ?? '', headings: signals?.headings ?? [], signals };
    });
  const nav = locations.map((l) => l.metrics.navigation as NavigationMetrics | undefined).find(Boolean);
  return {
    name: project.name,
    pages,
    navigation: (nav?.items ?? []).map((i) => ({ label: i.label, path: i.href ? pathOf(i.href) : null })),
    analytics: project.settings.analytics,
    searches: (project.settings.analytics?.search?.queries ?? []).slice(0, 30).map((q) => q.label),
  };
}

// The built-in reader: common website purposes, recognised from navigation labels, page addresses,
// titles and headings. Each brings a task a visitor might come to do.

interface Rule {
  id: string;
  words: RegExp;
  title: string;
  description: string;
  task: { goal: string; doneWhen: string };
  /** Contact details or a form count as success, wherever they are. */
  success?: TaskSuccess;
  internal?: boolean;
}

const RULES: Rule[] = [
  {
    id: 'contact',
    words: /contact|get in touch|enquir|find us/i,
    title: 'Help people get in touch',
    description: 'Visitors can find a phone number, email address or form to contact the organisation.',
    task: { goal: 'Find a phone number or email address to get in touch', doneWhen: 'They can see a phone number or email address, or a contact form' },
    success: { kind: 'contact' },
  },
  {
    id: 'products',
    words: /shop|store|product|buy|basket|cart|pricing|price/i,
    title: 'Show and sell products',
    description: 'Visitors can browse what the organisation makes or sells, and find out what it costs.',
    task: { goal: 'Find a product and see what it costs or how to get it', doneWhen: 'They reach a product page' },
  },
  {
    id: 'visit',
    words: /visit|book|ticket|event|what'?s on|opening|exhibition/i,
    title: 'Help people plan a visit or book',
    description: 'Visitors can find opening times, what’s on, and how to book.',
    task: { goal: 'Find what’s on and how to book', doneWhen: 'They reach the events or booking page' },
  },
  {
    id: 'news',
    words: /news|blog|press|stories|insight|article|update/i,
    title: 'Share news and updates',
    description: 'The organisation publishes news, stories or updates.',
    task: { goal: 'Find the latest news', doneWhen: 'They reach a news article' },
  },
  {
    id: 'about',
    words: /about|who we are|our story|our team|our people|history/i,
    title: 'Explain who the organisation is',
    description: 'Visitors can find out who the organisation is, what it does and who runs it.',
    task: { goal: 'Find out who the organisation is and what it does', doneWhen: 'They reach the About page' },
  },
  {
    id: 'services',
    words: /service|what we do|solution|expertise|sector/i,
    title: 'Explain the services offered',
    description: 'Visitors can find out what services are offered and whether they fit their needs.',
    task: { goal: 'Find out whether they offer the service you need', doneWhen: 'They reach the page for that service' },
  },
  {
    id: 'support',
    words: /donat|support us|give|fundrais|membership|join us/i,
    title: 'Raise support, donations or members',
    description: 'Visitors can donate, become a member or support the organisation.',
    task: { goal: 'Find out how to donate or become a member', doneWhen: 'They reach the donation or membership page' },
  },
  {
    id: 'jobs',
    words: /job|career|vacanc|work (with|for) us|recruit/i,
    title: 'Recruit people',
    description: 'Visitors can find job vacancies and how to apply.',
    task: { goal: 'Find current job vacancies', doneWhen: 'They reach the jobs page' },
  },
  {
    id: 'help',
    words: /help|faq|advice|guidance|question/i,
    title: 'Answer common questions',
    description: 'Visitors can find answers and advice without having to get in touch.',
    task: { goal: 'Find an answer to a common question', doneWhen: 'They reach the help or FAQ page' },
  },
  {
    id: 'account',
    words: /log ?in|sign ?in|my account|portal/i,
    title: 'Give account holders access',
    description: 'Customers or members can log in to their account.',
    task: { goal: 'Find where to log in to your account', doneWhen: 'They reach the log-in page' },
    success: { kind: 'form', form: 'login' },
  },
  {
    id: 'staff',
    words: /staff|intranet|employee|colleague|\bhr\b|polic(y|ies)/i,
    title: 'Support staff (internal)',
    description: 'People who work for the organisation use the site to find internal information.',
    task: { goal: 'Find the staff area', doneWhen: 'They reach the staff area' },
    internal: true,
  },
];

/** Prego's own suggestion from the site's navigation, pages and analytics. */
export function suggestAudience(facts: SiteFacts): AudienceProfile {
  const purposes: Purpose[] = [];
  const targets = new Map<string, string | null>();
  // Links seen on any page, including ones Prego didn't visit (robots.txt, or past the crawl limits).
  const links = new Map<string, { label: string; path: string; pages: number }>();
  for (const page of facts.pages) for (const l of page.signals?.links ?? []) links.set(l.path, { ...l, pages: (links.get(l.path)?.pages ?? 0) + 1 });
  for (const rule of RULES) {
    const inNav = facts.navigation.filter((n) => rule.words.test(n.label) || (n.path && rule.words.test(n.path)));
    const pages = facts.pages.filter((p) => rule.words.test(p.path) || rule.words.test(p.title) || p.headings.some((h) => rule.words.test(h)));
    const linked = [...links.values()].filter((l) => rule.words.test(l.label) && !inNav.some((n) => n.path === l.path));
    const searched = facts.searches.filter((q) => rule.words.test(q));
    const signal =
      rule.id === 'contact' ? facts.pages.filter((p) => p.signals && (p.signals.tel || p.signals.mailto || p.signals.phoneText || p.signals.forms.includes('contact'))) : rule.id === 'account' ? facts.pages.filter((p) => p.signals?.forms.includes('login')) : [];
    if (!inNav.length && !pages.length && !signal.length && !linked.length && !searched.length) continue;
    const evidence = [
      ...inNav.map((n) => `“${n.label}” in the main navigation`),
      ...pages.slice(0, 3).map((p) => `page ${p.path}${p.title ? ` (“${p.title}”)` : ''}`),
      ...linked.slice(0, 2).map((l) => `“${l.label}” link on ${l.pages} ${l.pages === 1 ? 'page' : 'pages'}`),
      ...searched.slice(0, 2).map((q) => `people search for “${q}” (Search Console)`),
      ...(rule.id === 'contact' && signal.length ? [`contact details or a contact form on ${signal.length} ${signal.length === 1 ? 'page' : 'pages'}`] : []),
    ];
    // Something people search for that the site doesn't show isn't something it does now: it may be a gap.
    const visible = inNav.length + pages.length + signal.length + linked.length > 0;
    purposes.push({
      id: rule.id,
      title: rule.title,
      description: rule.description,
      current: visible,
      intended: false,
      priority: inNav.length || searched.length >= 2 ? 'primary' : 'secondary',
      evidence: [...new Set(evidence)].slice(0, 6),
    });
    targets.set(rule.id, inNav.find((n) => n.path)?.path ?? pages[0]?.path ?? linked[0]?.path ?? null);
  }
  const has = (id: string) => purposes.some((p) => p.id === id);
  const outward = purposes.filter((p) => p.id !== 'staff' && p.id !== 'account');
  const main = outward.filter((p) => p.priority === 'primary');

  // Personas: the situations most sites have to serve, shaped by what the site is for and who visits.
  const devices = facts.analytics?.tables.find((t) => t.id === 'devices');
  const total = devices?.rows.reduce((sum, r) => sum + r.value, 0) ?? 0;
  const mobileShare = total ? Math.round(((devices!.rows.find((r) => /mobile/i.test(r.label))?.value ?? 0) / total) * 100) : null;
  const personas: Persona[] = [];
  const tasks: UserTask[] = [];
  const add = (persona: Omit<Persona, 'id' | 'purposeIds'>, purposeIds: string[]) => {
    const ids = purposeIds.filter((id) => has(id)).slice(0, 3);
    if (!ids.length) return;
    const id = `persona-${personas.length + 1}`;
    personas.push({ ...persona, id, purposeIds: ids });
    for (const purposeId of ids) {
      const rule = RULES.find((r) => r.id === purposeId)!;
      const target = targets.get(purposeId);
      const success: TaskSuccess = rule.success ?? (target ? { kind: 'page', path: target } : { kind: 'described' });
      tasks.push({ id: `task-${tasks.length + 1}`, personaId: id, goal: rule.task.goal, doneWhen: rule.task.doneWhen, success, purposeId });
    }
  };
  const firstOf = (...ids: string[]) => ids.filter((id) => has(id));
  add(
    {
      name: 'On their phone, in a hurry',
      summary: `Needs one thing quickly and won’t browse.${mobileShare !== null ? ` ${mobileShare}% of visitors use a phone (Google Analytics).` : ''}`,
      context: 'On the move, on a small screen and patchy mobile data, often with one hand.',
      device: 'mobile',
      accessNeeds: '',
      internal: false,
    },
    firstOf('contact', 'visit', 'products', 'help'),
  );
  add(
    {
      name: 'First-time visitor finding out more',
      summary: `Has heard of ${facts.name} and wants to understand what it offers before deciding anything.`,
      context: 'At a desk with time to read, comparing options.',
      device: 'desktop',
      accessNeeds: '',
      internal: false,
    },
    [...main.map((p) => p.id), 'about'].filter((id, i, all) => all.indexOf(id) === i && id !== 'contact'),
  );
  add(
    {
      name: 'Screen reader user',
      summary: 'Blind, and uses a screen reader to hear the page and move between headings, links and form fields.',
      context: 'At home, using a keyboard and screen reader, no mouse.',
      device: 'any',
      accessNeeds: 'Screen reader and keyboard only',
      internal: false,
    },
    [main[0]?.id ?? outward[0]?.id ?? '', 'contact'].filter(Boolean),
  );
  if (has('account') || has('support')) {
    add(
      { name: 'Returning customer or member', summary: 'Already uses the organisation and wants to manage their account or renew.', context: 'Knows the site a little and expects to get straight in.', device: 'any', accessNeeds: '', internal: false },
      firstOf('account', 'support'),
    );
  }
  // An internal user: staff often rely on the public site too.
  add(
    {
      name: 'Member of staff',
      summary: `Works for ${facts.name} and uses the site to find things for themselves or to send to others.`,
      context: 'At work, often looking for something to share with a customer on the phone.',
      device: 'desktop',
      accessNeeds: '',
      internal: true,
    },
    has('staff') ? ['staff'] : firstOf('news', 'contact', 'about').slice(0, 1),
  );
  return { purposes, personas, tasks, updatedAt: new Date().toISOString() };
}

// Ollama: the local model reads the same facts and writes its own suggestion.

const SCHEMA = {
  type: 'object',
  properties: {
    purposes: {
      type: 'array',
      items: { type: 'object', properties: { title: { type: 'string' }, description: { type: 'string' }, primary: { type: 'boolean' }, evidence: { type: 'array', items: { type: 'string' } } }, required: ['title', 'description', 'primary', 'evidence'] },
    },
    personas: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          name: { type: 'string' },
          summary: { type: 'string' },
          context: { type: 'string' },
          device: { type: 'string', enum: ['mobile', 'desktop', 'tablet', 'any'] },
          accessNeeds: { type: 'string' },
          internal: { type: 'boolean' },
          purposes: { type: 'array', items: { type: 'integer' } },
          tasks: {
            type: 'array',
            items: { type: 'object', properties: { goal: { type: 'string' }, doneWhen: { type: 'string' }, page: { type: 'string' } }, required: ['goal', 'doneWhen', 'page'] },
          },
        },
        required: ['name', 'summary', 'context', 'device', 'accessNeeds', 'internal', 'purposes', 'tasks'],
      },
    },
  },
  required: ['purposes', 'personas'],
};

const PROMPT = `You are a UX researcher. From the facts about a website below, work out what the site is for
and who uses it.

- purposes: 3 to 7 things the site exists to do, such as "Help people book tickets". Mark the main ones
  primary. Give as evidence the navigation labels or page addresses that show it. Use only the facts given.
- personas: 4 or 5 realistic people who use the site, including one disabled person and one member of
  staff (internal: true). Give their situation and device. purposes lists the numbers (from 1) of the
  purposes they care about.
- tasks: 1 to 3 per persona, written as what they're trying to do ("Find the phone number for the
  planning team"), how they'd know they'd done it, and the address of the page where it's done, chosen
  from the pages listed ("" if none fits).

Use British English. Don't invent facts about the organisation.

`;

/** Give up if the model goes quiet for this long, or runs for longer than the total. */
const IDLE_MS = 90_000;
const TOTAL_MS = 10 * 60_000;

/** How far the model has got, from the text it's written so far. */
export interface SuggestProgress {
  stage: 'starting' | 'purposes' | 'personas';
  /** Personas started so far. */
  personas: number;
  characters: number;
}

export function progressOf(text: string): SuggestProgress {
  const at = text.indexOf('"personas"');
  if (at === -1) return { stage: text.includes('"purposes"') ? 'purposes' : 'starting', personas: 0, characters: text.length };
  return { stage: 'personas', personas: (text.slice(at).match(/"name"\s*:/g) ?? []).length, characters: text.length };
}

export interface AskOptions {
  fetchImpl?: typeof fetch;
  signal?: AbortSignal;
  onProgress?: (progress: SuggestProgress) => void;
}

/** Ollama's streamed chat answer, joined up. Stops when the model goes quiet, runs too long or is cancelled. */
async function streamChat(url: URL, body: object, { fetchImpl = fetch, signal, onProgress }: AskOptions): Promise<string> {
  const controller = new AbortController();
  let reason = '';
  const stop = (why: string) => {
    reason ||= why;
    controller.abort();
  };
  let idle = setTimeout(() => stop('the model stopped answering'), IDLE_MS);
  const total = setTimeout(() => stop('it took longer than 10 minutes'), TOTAL_MS);
  const cancel = () => stop('stopped');
  signal?.addEventListener('abort', cancel);
  if (signal?.aborted) cancel();
  try {
    const res = await fetchImpl(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, signal: controller.signal, body: JSON.stringify({ ...body, stream: true }) });
    if (!res.ok) throw new Error(`Ollama answered ${res.status}: ${(await res.text()).slice(0, 200)}`);
    let text = '';
    let buffer = '';
    const take = (line: string) => {
      if (!line.trim()) return;
      const chunk = JSON.parse(line) as { message?: { content?: string }; error?: string };
      if (chunk.error) throw new Error(chunk.error);
      text += chunk.message?.content ?? '';
    };
    const decoder = new TextDecoder();
    for await (const part of res.body as unknown as AsyncIterable<Uint8Array>) {
      clearTimeout(idle);
      idle = setTimeout(() => stop('the model stopped answering'), IDLE_MS);
      buffer += decoder.decode(part, { stream: true });
      const lines = buffer.split('\n');
      buffer = lines.pop() ?? '';
      lines.forEach(take);
      onProgress?.(progressOf(text));
    }
    take(buffer);
    return text;
  } catch (error) {
    throw reason ? new Error(reason) : error;
  } finally {
    clearTimeout(idle);
    clearTimeout(total);
    signal?.removeEventListener('abort', cancel);
  }
}

function factsText(facts: SiteFacts): string {
  const lines = [`Site: ${facts.name}`, `Main navigation: ${facts.navigation.map((n) => `${n.label}${n.path ? ` (${n.path})` : ''}`).join('; ') || 'none found'}`, 'Pages:'];
  for (const p of facts.pages.slice(0, 60)) {
    const extra = [p.headings.slice(0, 3).join(' / '), p.signals?.forms.length ? `forms: ${p.signals.forms.join(', ')}` : '', p.signals && (p.signals.tel || p.signals.phoneText) ? 'phone number' : ''].filter(Boolean).join('; ');
    lines.push(`- ${p.path} “${p.title}”${extra ? ` (${extra})` : ''}`);
  }
  for (const table of facts.analytics?.tables ?? []) lines.push(`${table.title} (${table.measure}): ${table.rows.slice(0, 8).map((r) => `${r.label} ${r.value}`).join(', ')}`);
  if (facts.searches.length) lines.push(`What people search for to find the site: ${facts.searches.slice(0, 20).join('; ')}`);
  return lines.join('\n');
}

/** Ask the local Ollama model for purposes, personas and tasks. Exported for tests. */
export async function askOllamaForAudience(settings: AiSettings, facts: SiteFacts, options: AskOptions | typeof fetch = {}): Promise<AudienceProfile> {
  const opts = typeof options === 'function' ? { fetchImpl: options } : options;
  const url = new URL('/api/chat', assertLocalOllama(settings.url));
  const messages = [{ role: 'user', content: PROMPT + factsText(facts) }];
  // num_predict caps a runaway answer; a full one is around 2,000 tokens.
  const ask = (temperature: number) => streamChat(url, { model: settings.model, format: SCHEMA, options: { temperature, num_predict: MAX_TOKENS }, messages }, opts);
  const first = await ask(0.2);
  const profile = profileFromAnswer(first, facts);
  if (profile) return profile;
  // Small models sometimes answer with empty lists, which the format allows. Asking again with a
  // nudge fixes it; requiring a minimum in the format instead makes Ollama run away.
  messages.push({ role: 'assistant', content: first }, { role: 'user', content: RETRY });
  const second = profileFromAnswer(await ask(0.5), facts);
  if (second) return second;
  throw new Error('the model’s answer had no purposes or personas');
}

const MAX_TOKENS = 6000;
const RETRY = 'That answer was empty. Answer again with 3 to 7 purposes and 4 or 5 personas, each with their tasks, from the facts above.';

/** The profile from the model's JSON answer, or null when it has no purposes or personas. */
function profileFromAnswer(content: string, facts: SiteFacts): AudienceProfile | null {
  const answer = JSON.parse(content || '{}') as {
    purposes?: { title?: unknown; description?: unknown; primary?: unknown; evidence?: unknown }[];
    personas?: { name?: unknown; summary?: unknown; context?: unknown; device?: unknown; accessNeeds?: unknown; internal?: unknown; purposes?: unknown; tasks?: { goal?: unknown; doneWhen?: unknown; page?: unknown }[] }[];
  };
  const str = (v: unknown, max = 300) => (typeof v === 'string' ? v.trim().slice(0, max) : '');
  const purposes: Purpose[] = (answer.purposes ?? [])
    .filter((p) => str(p.title))
    .slice(0, 10)
    .map((p, i) => ({
      id: `purpose-${i + 1}`,
      title: str(p.title, 120),
      description: str(p.description),
      current: true,
      intended: false,
      priority: p.primary === true ? 'primary' : 'secondary',
      evidence: Array.isArray(p.evidence) ? p.evidence.map((e) => str(e, 160)).filter(Boolean).slice(0, 6) : [],
    }));
  // Task pages must be real pages from the audit; anything else becomes a described success.
  const known = new Set(facts.pages.map((p) => p.path));
  const personas: Persona[] = [];
  const tasks: UserTask[] = [];
  for (const p of (answer.personas ?? []).filter((p) => str(p.name)).slice(0, 8)) {
    const id = `persona-${personas.length + 1}`;
    const purposeIds = Array.isArray(p.purposes) ? p.purposes.filter((n): n is number => Number.isInteger(n) && n >= 1 && n <= purposes.length).map((n) => purposes[n - 1].id) : [];
    personas.push({
      id,
      name: str(p.name, 120),
      summary: str(p.summary),
      context: str(p.context),
      device: (['mobile', 'desktop', 'tablet', 'any'] as PersonaDevice[]).includes(p.device as PersonaDevice) ? (p.device as PersonaDevice) : 'any',
      accessNeeds: str(p.accessNeeds, 200),
      internal: p.internal === true,
      purposeIds: [...new Set(purposeIds)],
    });
    for (const t of (p.tasks ?? []).filter((t) => str(t.goal)).slice(0, 3)) {
      const page = str(t.page, 500);
      const path = page && known.has(page) ? page : page ? [...known].find((k) => page.endsWith(k) && k !== '/') : undefined;
      tasks.push({ id: `task-${tasks.length + 1}`, personaId: id, goal: str(t.goal, 200), doneWhen: str(t.doneWhen, 200), success: path ? { kind: 'page', path } : { kind: 'described' } });
    }
  }
  if (!purposes.length || !personas.length) return null;
  return { purposes, personas, tasks, updatedAt: new Date().toISOString() };
}

/** A suggestion from Ollama when it's switched on, or from the built-in reader. */
export async function suggestAudienceFor(facts: SiteFacts, ai: AiSettings | undefined, options: AskOptions | typeof fetch = {}): Promise<AudienceSuggestion> {
  if (!ai) return { profile: suggestAudience(facts), source: 'reader' };
  try {
    return { profile: await askOllamaForAudience(ai, facts, options), source: 'ai' };
  } catch (error) {
    if ((error as Error).message === 'stopped') return { profile: suggestAudience(facts), source: 'reader', note: 'You stopped the AI model, so these are Prego’s own suggestions.' };
    return { profile: suggestAudience(facts), source: 'reader', note: `Ollama didn’t give a usable answer (${(error as Error).message}), so these are Prego’s own suggestions.` };
  }
}
