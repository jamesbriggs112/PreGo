import { existsSync, readFileSync } from 'node:fs';
import type { Page } from 'playwright';
import type { Action } from './actions.js';

/** Action labels never pressed by default (matched as whole words, ignoring case). */
export const DEFAULT_DENY_LABELS = ['delete', 'remove', 'buy', 'pay', 'checkout', 'submit order', 'send', 'log out', 'logout', 'sign out', 'unsubscribe'];

/** Link addresses never followed by default. */
const DENY_HREF = /log-?out|sign-?out|unsubscribe|delete/i;

export type DummyData = Record<string, string>;

export const DEFAULT_DUMMY_DATA: DummyData = {
  text: 'Prego test',
  name: 'Prego Test',
  firstName: 'Prego',
  lastName: 'Test',
  email: 'prego.test@example.com',
  tel: '01632 960000',
  postcode: 'SW1A 1AA',
  address: '1 Test Street',
  city: 'Testville',
  number: '1',
  url: 'https://example.com',
  search: 'test',
  date: '2026-01-01',
  message: 'This is a test message from Prego, an automated audit tool. Please ignore it.',
};

/** Dummy data from a JSON config file, on top of the built-in values. */
export function loadDummyData(path: string): DummyData {
  if (!existsSync(path)) return DEFAULT_DUMMY_DATA;
  const fromFile = JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>;
  const values = Object.fromEntries(Object.entries(fromFile).filter(([key, value]) => !key.startsWith('_') && typeof value === 'string')) as DummyData;
  return { ...DEFAULT_DUMMY_DATA, ...values };
}

export interface SafetyOptions {
  /** Labels never pressed. Default DEFAULT_DENY_LABELS. */
  denyLabels?: string[];
  /** CSS selectors never pressed (matches the element or anything inside a match). */
  denySelectors?: string[];
  dummyData?: DummyData;
}

export interface Safety {
  /** Mark denylisted actions and fill empty form fields with dummy data. Use as the explorer's prepareScreen. */
  prepareScreen(page: Page, actions: Action[]): Promise<void>;
  canPerform(action: Action): { allowed: true } | { allowed: false; reason: string };
}

/**
 * The explorer's safety rules: never press denylisted actions (delete, buy, send, log out...), never
 * follow links off the site or to log-out addresses, and only ever type dummy data into forms.
 * Password fields are never filled.
 */
export function createSafety(startUrl: string, options: SafetyOptions = {}): Safety {
  const origin = new URL(startUrl).origin;
  const labels = (options.denyLabels ?? DEFAULT_DENY_LABELS).map((l) => l.trim()).filter(Boolean);
  const patterns = labels.map((label) => ({ label, regex: new RegExp(`(^|\\W)${escapeRegex(label).replace(/\s+/g, '\\s+')}(\\W|$)`, 'i') }));
  const selectors = (options.denySelectors ?? []).map((s) => s.trim()).filter(Boolean);
  const dummy = options.dummyData ?? DEFAULT_DUMMY_DATA;
  const blocked = new WeakMap<Action, string>();

  return {
    async prepareScreen(page, actions) {
      if (selectors.length) {
        const matches = await page.evaluate(
          ({ selectors, targets }) =>
            targets.map((target) => {
              const el = document.querySelector(target);
              if (!el) return null;
              for (const selector of selectors) {
                try {
                  if (el.closest(selector) || el.querySelector(selector)) return selector;
                } catch {
                  // Ignore invalid selectors.
                }
              }
              return null;
            }),
          { selectors, targets: actions.map((a) => a.selector) },
        );
        actions.forEach((action, i) => {
          if (matches[i]) blocked.set(action, `Matches denylisted selector ${matches[i]}`);
        });
      }
      await fillForms(page, actions, dummy);
    },

    canPerform(action) {
      const selectorReason = blocked.get(action);
      if (selectorReason) return { allowed: false, reason: selectorReason };
      const label = patterns.find((p) => p.regex.test(action.label));
      if (label) return { allowed: false, reason: `Matches denylisted label "${label.label}"` };
      if (action.href) {
        const url = new URL(action.href);
        if (url.origin !== origin) return { allowed: false, reason: 'Link to another site' };
        if (DENY_HREF.test(url.pathname + url.search)) return { allowed: false, reason: 'Link looks like log out or delete' };
        if (/^(mailto|tel|sms|javascript):/i.test(action.href)) return { allowed: false, reason: 'Opens another app' };
      }
      return { allowed: true };
    },
  };
}

/** Fill empty text fields with dummy values chosen by type, autocomplete and name. */
async function fillForms(page: Page, actions: Action[], dummy: DummyData) {
  for (const action of actions) {
    if (action.kind !== 'fill' || action.inputType === 'password') continue;
    const locator = page.locator(action.selector).first();
    const current = await locator.inputValue().catch(() => null);
    if (current === null || current !== '') continue;
    const hint = await locator
      .evaluate((el) => [el.getAttribute('autocomplete'), el.getAttribute('name'), el.id, el.getAttribute('placeholder'), el.getAttribute('aria-label'), (el as HTMLInputElement).labels?.[0]?.textContent].join(' ').toLowerCase())
      .catch(() => '');
    await locator.fill(valueFor(action, hint, dummy), { timeout: 2_000 }).catch(() => undefined);
  }
}

export function valueFor(action: Pick<Action, 'inputType' | 'tag'>, hint: string, dummy: DummyData): string {
  const type = action.inputType ?? (action.tag === 'textarea' ? 'textarea' : 'text');
  if (type === 'email' || /e-?mail/.test(hint)) return dummy.email;
  if (type === 'tel' || /phone|mobile|tel\b/.test(hint)) return dummy.tel;
  if (type === 'number' || type === 'range') return dummy.number;
  if (type === 'url' || /website|url/.test(hint)) return dummy.url;
  if (type === 'date') return dummy.date;
  if (type === 'search' || /search/.test(hint)) return dummy.search;
  if (/post-?code|zip/.test(hint)) return dummy.postcode;
  if (/given|first/.test(hint)) return dummy.firstName;
  if (/family|last|surname/.test(hint)) return dummy.lastName;
  if (/name/.test(hint)) return dummy.name;
  if (/address|street/.test(hint)) return dummy.address;
  if (/city|town/.test(hint)) return dummy.city;
  if (type === 'textarea' || /message|comment/.test(hint)) return dummy.message;
  return dummy.text;
}

function escapeRegex(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
