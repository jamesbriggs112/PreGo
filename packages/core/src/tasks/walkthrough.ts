import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { chromium, type Browser, type Page } from 'playwright';
import { RobotsTxtFile } from '@crawlee/utils';
import { assertLocalOllama, type AiSettings } from '../checks/ai/ai.js';
import { PROFILES } from '../browser/profiles.js';
import { DEFAULT_DENY_LABELS } from '../explore/safety.js';
import { normalisePath } from '../export/analytics.js';
import type { AudienceProfile, PageSignals, Persona, UserTask } from '../audience/types.js';
import { meetsSuccess, type TaskOutcome } from './tree.js';

// The AI walkthrough: the local Ollama model plays each persona and tries their tasks on the site, a
// step at a time, choosing from the links and menus a visitor can see. Prego, not the model, decides
// whether the task is done. It only follows links on the site and opens menus: it never types,
// submits a form, presses anything on the denylist, or visits a page robots.txt rules out.

export interface WalkStep {
  url: string;
  title: string;
  /** What it chose: a link or menu label, or why it stopped. */
  action: string;
  /** The model's reason, in the persona's words. */
  reason: string;
}

export interface WalkResult {
  taskId: string;
  personaId: string;
  outcome: TaskOutcome;
  steps: WalkStep[];
  /** How it ended, in a sentence. */
  note: string;
  /** Screenshot where it stopped, when it didn't succeed, under the run folder (deleted on export). */
  screenshot: string | null;
}

export interface WalkOptions {
  startUrl: string;
  ai: AiSettings;
  runDir: string;
  respectRobots?: boolean;
  basicAuth?: { username: string; password: string };
  /** Steps per task before it counts as lost. */
  maxSteps?: number;
  signal?: AbortSignal;
  onTask?: (task: UserTask, index: number, total: number) => void;
  fetchImpl?: typeof fetch;
}

interface Option {
  n: number;
  label: string;
  kind: 'link' | 'menu';
  href?: string;
  selector?: string;
}

const DOWNLOAD = /\.(pdf|docx?|xlsx?|pptx?|zip|csv|mp[34]|mov)$/i;
const TIMEOUT_MS = 180_000;

const SCHEMA = {
  type: 'object',
  properties: { choice: { type: 'integer' }, reason: { type: 'string' } },
  required: ['choice', 'reason'],
};

function prompt(persona: Persona, task: UserTask, page: { title: string; url: string; text: string }, options: Option[], history: WalkStep[]): string {
  return `You are role-playing a person using a website. Stay in character.

Who you are: ${persona.name}. ${persona.summary}
Your situation: ${persona.context || 'Not given.'}${persona.accessNeeds ? `\nAccess needs: ${persona.accessNeeds}` : ''}
What you're trying to do: ${task.goal}
You'll know you've done it when: ${task.doneWhen || 'you find it.'}

You're on the page “${page.title}” (${new URL(page.url).pathname}). The screenshot shows what you see. Some of its text:
${page.text}

${history.length ? `So far you've: ${history.map((h) => h.action).join(' → ')}.\n` : ''}What do you do next? Choose ONE number from this list, as this person would, from what the labels suggest:
${options.map((o) => `${o.n}. ${o.kind === 'menu' ? 'Open the menu ' : ''}“${o.label}”`).join('\n')}
0. I've done what I came to do, on this page.
-1. I give up.

Answer with the number and a short reason in this person's words.`;
}

/** Ask the model for the next step. Exported for tests. */
export async function chooseStep(ai: AiSettings, text: string, screenshot: Buffer, fetchImpl: typeof fetch = fetch): Promise<{ choice: number; reason: string }> {
  const base = assertLocalOllama(ai.url);
  const res = await fetchImpl(new URL('/api/chat', base), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    signal: AbortSignal.timeout(TIMEOUT_MS),
    body: JSON.stringify({ model: ai.model, stream: false, format: SCHEMA, options: { temperature: 0.2 }, messages: [{ role: 'user', content: text, images: [screenshot.toString('base64')] }] }),
  });
  if (!res.ok) throw new Error(`Ollama answered ${res.status}: ${(await res.text()).slice(0, 200)}`);
  const body = (await res.json()) as { message?: { content?: string } };
  const answer = JSON.parse(body.message?.content ?? '{}') as { choice?: unknown; reason?: unknown };
  return { choice: Number.isInteger(answer.choice) ? (answer.choice as number) : -1, reason: typeof answer.reason === 'string' ? answer.reason.trim().slice(0, 300) : '' };
}

/** What's on the page for the model and the success check: visible links and menus, and contact details and forms. */
async function readPage(page: Page, deny: string[]): Promise<{ options: Option[]; signals: PageSignals; text: string }> {
  const read = await page.evaluate((denied) => {
    const visible = (el: Element) => {
      const r = el.getBoundingClientRect();
      const style = getComputedStyle(el);
      return r.width > 0 && r.height > 0 && style.visibility !== 'hidden' && style.display !== 'none' && !el.closest('[aria-hidden="true"], [hidden], [inert]');
    };
    const name = (el: Element) => (el.getAttribute('aria-label') ?? (el as HTMLElement).innerText ?? el.textContent ?? '').replace(/\s+/g, ' ').trim().slice(0, 80);
    const isDenied = (label: string) => denied.some((d) => label.toLowerCase().includes(d));
    const seen = new Set<string>();
    const options: { label: string; kind: 'link' | 'menu'; href?: string; selector?: string }[] = [];
    document.querySelectorAll('a[href]').forEach((a) => {
      const link = a as HTMLAnchorElement;
      const label = name(link);
      const url = new URL(link.href, location.href);
      url.hash = '';
      if (!label || !visible(link) || url.origin !== location.origin || isDenied(label) || seen.has(url.href) || url.href === location.href.replace(/#.*$/, '')) return;
      seen.add(url.href);
      options.push({ label, kind: 'link', href: url.href });
    });
    // Menu toggles only: buttons that show or hide something, never ones that submit or are in a form.
    document.querySelectorAll('button[aria-expanded], [role="button"][aria-expanded], button[aria-controls]').forEach((b, i) => {
      const label = name(b);
      if (!label || !visible(b) || b.closest('form') || (b as HTMLButtonElement).type === 'submit' || isDenied(label)) return;
      b.setAttribute('data-prego-menu', String(i));
      options.push({ label, kind: 'menu', selector: `[data-prego-menu="${i}"]` });
    });
    const forms = [...document.querySelectorAll('form')].map((form) => {
      const fields = [...form.querySelectorAll('input, textarea, select')] as HTMLInputElement[];
      const has = (p: RegExp) => fields.some((f) => p.test(`${f.type} ${f.name} ${f.id} ${f.getAttribute('autocomplete') ?? ''}`));
      if (has(/password/)) return 'login';
      if (form.getAttribute('role') === 'search' || form.closest('[role="search"]') || has(/^search|\b(q|s|query|search)\b/)) return 'search';
      if (form.querySelector('textarea') || has(/message|enquiry|comment/)) return 'contact';
      if (fields.filter((f) => !['hidden', 'submit', 'button'].includes(f.type)).length <= 2 && has(/email/)) return 'newsletter';
      return 'other';
    });
    const body = document.body?.innerText ?? '';
    return {
      options: options.slice(0, 40),
      signals: {
        tel: document.querySelectorAll('a[href^="tel:" i]').length,
        mailto: document.querySelectorAll('a[href^="mailto:" i]').length,
        phoneText: /(?:\+\d{1,3}[\s-]?(?:\(0\))?|\(?0)\d{2,5}\)?[\s-]?\d{3,4}[\s-]?\d{3,4}\b/.test(body),
        forms,
        headings: [],
        links: [],
      },
      text: body.replace(/\s+/g, ' ').trim().slice(0, 1200),
    };
  }, deny);
  // File downloads (PDFs, documents, media) aren't pages to walk through, so they're never offered.
  const pages = read.options.filter((o) => !o.href || !DOWNLOAD.test(new URL(o.href).pathname));
  return { ...read, options: pages.map((o, i) => ({ ...o, n: i + 1 })) as Option[] };
}

export async function walkTasks(profile: AudienceProfile, options: WalkOptions): Promise<WalkResult[]> {
  assertLocalOllama(options.ai.url);
  const tasks = profile.tasks.filter((t) => profile.personas.some((p) => p.id === t.personaId));
  if (!tasks.length) return [];
  const origin = new URL(options.startUrl).origin;
  let robots: RobotsTxtFile | null = null;
  if (options.respectRobots !== false) {
    const text = await (options.fetchImpl ?? fetch)(`${origin}/robots.txt`).then((r) => (r.ok ? r.text() : '')).catch(() => '');
    robots = RobotsTxtFile.from(`${origin}/robots.txt`, text);
  }
  const allowed = (url: string) => !robots || robots.isAllowed(url);
  const deny = DEFAULT_DENY_LABELS.map((d) => d.toLowerCase());
  const maxSteps = options.maxSteps ?? 10;
  const results: WalkResult[] = [];
  let browser: Browser | undefined;
  try {
    browser = await chromium.launch();
    for (const [index, task] of tasks.entries()) {
      if (options.signal?.aborted) break;
      options.onTask?.(task, index, tasks.length);
      const persona = profile.personas.find((p) => p.id === task.personaId)!;
      const profileName = persona.device === 'mobile' ? 'mobile' : persona.device === 'tablet' ? 'tablet' : 'desktop';
      const size = PROFILES[profileName];
      const context = await browser.newContext({
        viewport: { width: size.width, height: size.height },
        isMobile: size.mobile,
        hasTouch: size.touch,
        deviceScaleFactor: 1,
        httpCredentials: options.basicAuth ? { ...options.basicAuth, origin, send: 'unauthorized' } : undefined,
      });
      const page = await context.newPage();
      const steps: WalkStep[] = [];
      let outcome: TaskOutcome = 'failed';
      let note = `Still looking after ${maxSteps} steps.`;
      try {
        await page.goto(options.startUrl, { waitUntil: 'domcontentloaded', timeout: 30_000 });
        for (let step = 0; step <= maxSteps; step++) {
          await page.waitForLoadState('load', { timeout: 10_000 }).catch(() => undefined);
          const read = await readPage(page, deny);
          const here = { url: page.url(), title: (await page.title()).slice(0, 120) };
          const path = normalisePath(here.url) ?? '';
          if (task.success.kind !== 'described' && meetsSuccess(task.success, path, read.signals)) {
            outcome = 'success';
            note = steps.length ? `Done in ${steps.length} ${steps.length === 1 ? 'step' : 'steps'}.` : 'Done on the page it started on.';
            break;
          }
          if (step === maxSteps) break;
          const shot = await page.screenshot({ type: 'jpeg', quality: 60 });
          const { choice, reason } = await chooseStep(options.ai, prompt(persona, task, { ...here, text: read.text }, read.options, steps), shot, options.fetchImpl);
          if (choice === 0) {
            steps.push({ ...here, action: 'Said they’d done it', reason });
            // Prego checks: a described task can't be, so it's the model's word.
            outcome = task.success.kind === 'described' ? 'partial' : 'failed';
            note = task.success.kind === 'described' ? 'Said they’d done it; Prego can’t check a described task.' : 'Thought they’d done it, but this isn’t where the task is done.';
            break;
          }
          const chosen = read.options.find((o) => o.n === choice);
          if (!chosen) {
            steps.push({ ...here, action: 'Gave up', reason });
            note = 'Gave up.';
            break;
          }
          steps.push({ ...here, action: chosen.kind === 'menu' ? `Opened “${chosen.label}”` : `Chose “${chosen.label}”`, reason });
          if (chosen.kind === 'menu') {
            await page.locator(chosen.selector!).first().click({ timeout: 5_000 }).catch(() => undefined);
            await page.waitForTimeout(400);
          } else if (!allowed(chosen.href!)) {
            steps.push({ ...here, action: 'Stopped', reason: 'That page is off-limits to automated visitors (robots.txt).' });
            note = 'The next page is ruled out by robots.txt, so the walkthrough stopped.';
            outcome = 'unchecked';
            break;
          } else {
            await page.goto(chosen.href!, { waitUntil: 'domcontentloaded', timeout: 30_000 });
          }
        }
      } catch (error) {
        note = `The walkthrough stopped: ${(error as Error).message.split('\n')[0].slice(0, 160)}`;
        outcome = 'unchecked';
      }
      if (outcome === 'success' && steps.length > 6) {
        outcome = 'partial';
        note = `Got there, but it took ${steps.length} steps.`;
      }
      let screenshot: string | null = null;
      if (outcome !== 'success') {
        screenshot = join('tasks', `${task.id.replace(/[^\w-]/g, '')}.jpg`);
        mkdirSync(join(options.runDir, 'tasks'), { recursive: true });
        writeFileSync(join(options.runDir, screenshot), await page.screenshot({ type: 'jpeg', quality: 70 }).catch(() => Buffer.alloc(0)));
      }
      await context.close();
      results.push({ taskId: task.id, personaId: persona.id, outcome, steps, note, screenshot });
    }
  } finally {
    await browser?.close();
  }
  return results;
}
