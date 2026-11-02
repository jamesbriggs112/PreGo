import type { Severity } from '../../types.js';
import type { CheckFinding, CheckModule } from '../types.js';

// Optional AI review: a local vision model (through Ollama, on this computer) reviews a screenshot of
// each template against Nielsen's 10 usability heuristics. Nothing is sent anywhere else. Every
// finding is labelled AI-suggested and waits as Needs review until an auditor approves it.

export const AI_ENGINE = 'ollama';

export interface AiSettings {
  /** Ollama's address. Only this computer is allowed. */
  url: string;
  /** A vision model pulled into Ollama, e.g. `qwen2.5vl:7b` or `llama3.2-vision`. */
  model: string;
}

export const HEURISTICS = [
  'Visibility of system status',
  'Match between the system and the real world',
  'User control and freedom',
  'Consistency and standards',
  'Error prevention',
  'Recognition rather than recall',
  'Flexibility and efficiency of use',
  'Aesthetic and minimalist design',
  'Help users recognise, diagnose and recover from errors',
  'Help and documentation',
] as const;

const LOCAL = /^(localhost|127\.\d+\.\d+\.\d+|\[::1\])$/i;
const MAX_TEMPLATES = 20;
const MAX_PER_PAGE = 5;
const TIMEOUT_MS = 180_000;

/** Ollama must run on this computer: audit screenshots never leave it. */
export function assertLocalOllama(url: string): URL {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error(`“${url}” isn’t a valid address for Ollama.`);
  }
  if (!/^https?:$/.test(parsed.protocol) || !LOCAL.test(parsed.hostname)) {
    throw new Error('AI review only talks to Ollama on this computer (localhost or 127.0.0.1), so screenshots never leave it.');
  }
  return parsed;
}

/** The JSON shape the model must answer in (Ollama structured outputs). */
const SCHEMA = {
  type: 'object',
  properties: {
    findings: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          heuristic: { type: 'integer', minimum: 1, maximum: 10 },
          severity: { type: 'string', enum: ['High', 'Medium', 'Low'] },
          problem: { type: 'string' },
          evidence: { type: 'string' },
          recommendation: { type: 'string' },
        },
        required: ['heuristic', 'severity', 'problem', 'evidence', 'recommendation'],
      },
    },
  },
  required: ['findings'],
};

const PROMPT = `You are an experienced UX auditor. Review this screenshot of one screen of a website or
interactive against Nielsen's 10 usability heuristics:
${HEURISTICS.map((h, i) => `${i + 1}. ${h}`).join('\n')}

List only clear problems you can see in the screenshot, at most ${MAX_PER_PAGE}, most serious first. For each,
give the heuristic number, a severity (High, Medium or Low), the problem in one plain-English sentence,
the evidence (what on the screen shows it), and a short recommendation. Don't comment on things you can't
see, such as behaviour, code or accessibility markup. If there are no clear problems, return an empty list.
Answer in British English.`;

export interface AiFinding {
  heuristic: number;
  severity: 'High' | 'Medium' | 'Low';
  problem: string;
  evidence: string;
  recommendation: string;
}

/** Ask the local model about one screenshot. Exported for tests. */
export async function reviewScreenshot(settings: AiSettings, png: Buffer, fetchImpl: typeof fetch = fetch): Promise<AiFinding[]> {
  const base = assertLocalOllama(settings.url);
  const res = await fetchImpl(new URL('/api/chat', base), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    signal: AbortSignal.timeout(TIMEOUT_MS),
    body: JSON.stringify({
      model: settings.model,
      stream: false,
      format: SCHEMA,
      options: { temperature: 0 },
      messages: [{ role: 'user', content: PROMPT, images: [png.toString('base64')] }],
    }),
  });
  if (!res.ok) throw new Error(`Ollama answered ${res.status}: ${(await res.text()).slice(0, 200)}`);
  const body = (await res.json()) as { message?: { content?: string } };
  let parsed: { findings?: unknown };
  try {
    parsed = JSON.parse(body.message?.content ?? '{}');
  } catch {
    return [];
  }
  if (!Array.isArray(parsed.findings)) return [];
  return parsed.findings
    .filter((f): f is AiFinding => {
      const x = f as AiFinding;
      return Number.isInteger(x?.heuristic) && x.heuristic >= 1 && x.heuristic <= 10 && ['High', 'Medium', 'Low'].includes(x.severity) && typeof x.problem === 'string' && !!x.problem.trim();
    })
    .slice(0, MAX_PER_PAGE);
}

export function aiModule(settings: AiSettings | undefined): CheckModule {
  if (!settings) throw new Error('AI review is switched off. Turn it on in Settings (it needs Ollama running on this computer).');
  assertLocalOllama(settings.url);
  const templates = new Set<string>();
  let reachedOllama = false;

  return {
    id: 'ai',
    name: 'AI heuristic review (local)',
    perViewport: false,
    async run({ page, location }) {
      const template = location.kind === 'state' ? `${location.url}#${location.title}` : (location.templateKey ?? location.url);
      if (templates.has(template) || templates.size >= MAX_TEMPLATES) return [];
      templates.add(template);
      const png = await page.screenshot({ type: 'png', animations: 'disabled' });
      let found: AiFinding[];
      try {
        found = await reviewScreenshot(settings, png);
        reachedOllama = true;
      } catch (error) {
        // Not reachable at all: say so rather than finish an audit that silently skipped the review.
        if (!reachedOllama) throw new Error(`Couldn’t reach Ollama at ${settings.url} with model “${settings.model}”: ${error instanceof Error ? error.message : error}`);
        return [];
      }
      return found.map((f) => finding(f, location.url));
    },
  };
}

function finding(f: AiFinding, url: string): CheckFinding {
  const severity: Severity = f.severity;
  const heuristic = HEURISTICS[f.heuristic - 1];
  return {
    module: 'ai',
    engine: AI_ENGINE,
    ruleId: `heuristic-${f.heuristic}`,
    category: 'UX',
    severity,
    title: `AI-suggested: ${f.problem.trim().replace(/\.$/, '')}`,
    description: `A local AI model reviewed a screenshot of this screen against Nielsen’s heuristic “${heuristic}” and suggests this problem. It needs an auditor to confirm it.`,
    helpUrl: 'https://www.nngroup.com/articles/ten-usability-heuristics/',
    wcagCriteria: [],
    wcagLevel: null,
    selector: 'html',
    html: '<html>',
    failureSummary: `${f.evidence.trim()}${f.recommendation ? ` Suggested fix: ${f.recommendation.trim()}` : ''}`,
    component: `ai:${new URL(url).pathname}:${f.heuristic}:${f.problem.trim().toLowerCase().slice(0, 60)}`,
  };
}
