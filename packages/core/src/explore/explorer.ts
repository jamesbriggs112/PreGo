import type { Page } from 'playwright';
import { BrowserSession, type OpenedPage } from '../browser/session.js';
import type { Emulation, ProfileName } from '../browser/profiles.js';
import { discoverActions, type Action } from './actions.js';
import { identifyScreen } from './state.js';

import type { EdgeOutcome, PathStep } from '../types.js';

export type { EdgeOutcome, PathStep };

export interface ExploredState {
  id: string;
  title: string;
  /** Address relative to the start origin. */
  path: string;
  url: string;
  depth: number;
  /** Actions from the start screen that reach this screen. */
  steps: PathStep[];
  actions: Action[];
}

export interface ExploreEdge {
  from: string;
  to: string | null;
  action: PathStep;
  outcome: EdgeOutcome;
  reason?: string;
}

export interface ExploreOptions {
  startUrl: string;
  profile?: ProfileName;
  emulation?: Emulation;
  /** Maximum screens to record. Default 200. */
  maxStates?: number;
  /** Maximum actions from the start screen. Default 8. */
  maxDepth?: number;
  timeBudgetMs?: number;
  /** Elements to ignore when telling screens apart (clocks, carousels, videos). */
  maskSelectors?: string[];
  /** Milliseconds of (fake) time to let pass after each action for transitions. Default 1000. */
  settleMs?: number;
  /** Decide whether an action may be performed. Default: anything except links off the site. */
  canPerform?: (action: Action) => { allowed: true } | { allowed: false; reason: string };
  /** Called on each screen before it's identified, e.g. to fill form fields with dummy data. */
  prepareScreen?: (page: Page, actions: Action[]) => Promise<void>;
  session: BrowserSession;
  signal?: AbortSignal;
  onState?: (state: ExploredState, total: number) => void;
}

export interface ExploreResult {
  states: ExploredState[];
  edges: ExploreEdge[];
  stoppedEarly: boolean;
}

/**
 * Explore a single-page app or kiosk interactive breadth-first. Every untried action on every screen
 * is performed from a fresh start: open the start URL, replay the path to the screen, perform the
 * action, let the interface settle, and record where it ended up. The page clock is faked, so idle
 * timers and attract loops never fire mid-exploration; time only moves when Prego moves it.
 */
export async function exploreApp(options: ExploreOptions): Promise<ExploreResult> {
  const maxStates = options.maxStates ?? 200;
  const maxDepth = options.maxDepth ?? 8;
  const deadline = options.timeBudgetMs ? Date.now() + options.timeBudgetMs : Infinity;
  const startOrigin = new URL(options.startUrl).origin;
  const canPerform =
    options.canPerform ??
    ((action: Action) =>
      action.href && new URL(action.href).origin !== startOrigin ? { allowed: false as const, reason: 'Link to another site' } : { allowed: true as const });

  const states = new Map<string, ExploredState>();
  const edges: ExploreEdge[] = [];
  const queue: ExploredState[] = [];
  let stoppedEarly = false;

  // One page for the whole exploration. `at` is the screen it's known to be showing, so consecutive
  // actions from the same screen don't need a reload when the last one changed nothing.
  const screen = await openScreen(options, []);
  const page = screen.opened.page;
  let at: string | null = null;

  async function reach(state: ExploredState) {
    if (at === state.id) return;
    await resetPage(page, options);
    for (const step of state.steps) {
      await options.prepareScreen?.(page, await discoverActions(page));
      await perform(page, step);
      await settle(page, options.settleMs);
    }
    at = state.id;
  }

  async function recordState(steps: PathStep[], depth: number): Promise<ExploredState> {
    const actions = await discoverActions(page);
    await options.prepareScreen?.(page, actions);
    const identity = await identifyScreen(page, options.maskSelectors);
    return { id: identity.id, title: identity.title, path: identity.path, url: page.url(), depth, steps, actions };
  }

  try {
    const start = await recordState([], 0);
    at = start.id;
    states.set(start.id, start);
    queue.push(start);
    options.onState?.(start, states.size);

    explore: while (queue.length) {
      const state = queue.shift()!;
      for (const action of state.actions) {
        if (options.signal?.aborted || Date.now() > deadline) {
          stoppedEarly = true;
          break explore;
        }
        if (action.kind === 'fill') continue; // Fields are filled by prepareScreen, not explored.
        const step = toStep(action);
        const verdict = canPerform(action);
        if (!verdict.allowed) {
          edges.push({ from: state.id, to: null, action: step, outcome: action.href && verdict.reason === 'Link to another site' ? 'external' : 'skipped', reason: verdict.reason });
          continue;
        }

        try {
          await reach(state);
          const before = await identifyScreen(page, options.maskSelectors);
          at = null; // Unknown until the action settles.
          await perform(page, step);
          await settle(page, options.settleMs);
          const after = await identifyScreen(page, options.maskSelectors);
          if (after.id === before.id) {
            const unchanged = after.domHash === before.domHash;
            if (unchanged) at = state.id;
            edges.push({ from: state.id, to: state.id, action: step, outcome: unchanged ? 'unchanged' : 'changed' });
            continue;
          }
          const known = states.get(after.id);
          if (known) {
            at = known.id;
            edges.push({ from: state.id, to: known.id, action: step, outcome: 'navigated' });
            continue;
          }
          if (states.size >= maxStates || state.depth + 1 > maxDepth) {
            stoppedEarly ||= states.size >= maxStates;
            edges.push({ from: state.id, to: null, action: step, outcome: 'limit', reason: states.size >= maxStates ? 'State limit reached' : 'Depth limit reached' });
            continue;
          }
          const next = await recordState([...state.steps, step], state.depth + 1);
          at = next.id;
          states.set(next.id, next);
          queue.push(next);
          edges.push({ from: state.id, to: next.id, action: step, outcome: 'navigated' });
          options.onState?.(next, states.size);
        } catch (error) {
          at = null;
          edges.push({ from: state.id, to: null, action: step, outcome: 'failed', reason: error instanceof Error ? error.message.split('\n')[0] : String(error) });
        }
      }
    }
  } finally {
    await screen.opened.close();
  }

  return { states: [...states.values()], edges, stoppedEarly };
}

/** Back to the start screen with a clean slate: no cookies or storage left from earlier steps. */
async function resetPage(page: Page, options: Pick<ExploreOptions, 'startUrl' | 'settleMs'>) {
  await page.context().clearCookies();
  await page.evaluate(() => {
    try {
      localStorage.clear();
      sessionStorage.clear();
    } catch {
      // Storage can be unavailable (e.g. sandboxed pages).
    }
  }).catch(() => undefined);
  await page.goto(options.startUrl, { waitUntil: 'load' });
  await settle(page, options.settleMs);
}

interface OpenScreen {
  opened: OpenedPage;
}

/**
 * Open the start URL in a fresh context with a fake clock, and replay steps to reach a screen. Also
 * used to reach each screen again when running checks on it.
 */
export async function openScreen(
  options: Pick<ExploreOptions, 'startUrl' | 'profile' | 'emulation' | 'settleMs' | 'session' | 'prepareScreen'>,
  steps: PathStep[],
  profile = options.profile,
): Promise<OpenScreen> {
  const opened = await options.session.newPage(profile ?? 'desktop', options.emulation);
  try {
    const { page, context } = opened;
    // Popups and new tabs would leave the screen being explored; close them straight away.
    context.on('page', (popup) => void popup.close().catch(() => undefined));
    page.on('dialog', (dialog) => void dialog.dismiss().catch(() => undefined));
    page.on('download', (download) => void download.cancel().catch(() => undefined));
    await page.clock.install();
    await page.goto(options.startUrl, { waitUntil: 'load' });
    await settle(page, options.settleMs);
    for (const step of steps) {
      await options.prepareScreen?.(page, await discoverActions(page));
      await perform(page, step);
      await settle(page, options.settleMs);
    }
    return { opened };
  } catch (error) {
    await opened.close();
    throw error;
  }
}

function toStep(action: Action): PathStep {
  return { key: action.key, label: action.label, role: action.role, kind: action.kind, selector: action.selector };
}

/** Find a step's action on the current screen by its key (falling back to its selector) and do it. */
export async function perform(page: Page, step: PathStep): Promise<void> {
  const match = (await discoverActions(page)).find((a) => a.key === step.key);
  const locator = page.locator(match?.selector ?? step.selector).first();
  if (step.kind === 'select') {
    const values = await locator.locator('option').evaluateAll((options) => options.map((o) => (o as HTMLOptionElement).value));
    await locator.selectOption(values[1] ?? values[0], { timeout: 5_000 });
  } else {
    await locator.click({ timeout: 5_000 });
  }
}

/**
 * Let the interface settle: advance the fake clock for transitions, then wait until two readings of
 * the DOM a moment apart agree.
 */
export async function settle(page: Page, settleMs = 1000): Promise<void> {
  await page.waitForLoadState('load').catch(() => undefined);
  // Let transitions run on the fake clock, then poll (in real time) until the DOM stops changing.
  await page.clock.runFor(settleMs);
  let previous = '';
  for (let attempt = 0; attempt < 10; attempt++) {
    const current = await page.evaluate(() => document.body?.innerHTML.length + ':' + location.href).catch(() => '');
    if (current && current === previous) return;
    previous = current;
    await new Promise((r) => setTimeout(r, 40));
    await page.clock.runFor(100);
  }
}
