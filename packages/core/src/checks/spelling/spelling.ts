import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { gunzipSync } from 'node:zlib';
import { decodeTrie, type ITrie } from 'cspell-trie-lib';
import type { CheckFinding, CheckModule } from '../types.js';
import { guidanceFor } from '../guidance.js';

// Spelling against cspell's MIT-licensed British English dictionary. Capitalised words, acronyms and
// anything touching digits or underscores are skipped, as they're usually names, products and codes.
// The page is read the way it's laid out, so words in separate lines, list items or cells never run
// together. Code, cookie tables and consent banners, and text in other languages, are left out. Each
// unknown word is one site-wide ticket, so dismissing it as a false positive keeps it quiet in later audits.

const require = createRequire(import.meta.url);
let dictionary: ITrie | undefined;
const loadDictionary = () => (dictionary ??= decodeTrie(gunzipSync(readFileSync(join(dirname(require.resolve('@cspell/dict-en-gb-mit/cspell-ext.json')), 'en_GB.trie.gz')))));

/** Words common on websites that the dictionary leaves out. */
const WEB_WORDS = new Set([
  ...['signup', 'login', 'logout', 'checkout', 'homepage', 'webpage', 'username', 'dropdown', 'popup', 'navbar', 'cookie', 'cookies', 'app', 'apps', 'blog', 'vlog', 'podcast'],
  ...['hashtag', 'emoji', 'wifi', 'ebook', 'unsubscribe', 'faq', 'faqs', 'url', 'urls', 'inbox', 'eg', 'ie', 'etc', 'vs', 'pm', 'am', 'pdf', 'pdfs'],
  // Accepted British spellings and everyday business words the dictionary leaves out.
  ...['wellbeing', 'benefitting', 'benefitted', 'roundup', 'roundups', 'plugin', 'plugins', 'toolkit', 'toolkits', 'whitepaper', 'whitepapers', 'roundtable', 'roundtables'],
  ...['medtech', 'foodtech', 'fintech', 'edtech', 'healthtech', 'renewables', 'webinar', 'webinars', 'livestream', 'livestreams', 'ecommerce', 'cybersecurity', 'onboarding'],
  ...['microsite', 'microsites', 'infographic', 'infographics', 'chatbot', 'chatbots', 'touchpoint', 'touchpoints', 'upskill', 'upskilling', 'reskilling', 'workstream', 'workstreams'],
]);
const MAX_WORDS_PER_PAGE = 30;

/**
 * Words on a page that the British English dictionary doesn't know. Text is read a line (block) at a
 * time: a line where most words are unknown is probably another language, such as Welsh, or a list of
 * codes, and is skipped. Exported for tests.
 */
export function misspelledWords(text: string): string[] {
  const dict = loadDictionary();
  const known = (word: string) => WEB_WORDS.has(word.toLowerCase()) || dict.has(word.toLowerCase()) || dict.has(word);
  const unknown = new Set<string>();
  for (const line of text.split(/\n+/)) {
    // Leave out addresses, emails and anything that looks like code.
    const prose = line.replace(/\S+@\S+|https?:\/\/\S+|www\.\S+|\S+\.(com|org|net|co\.uk|uk|io|cymru|wales)\b\S*/gi, ' ');
    const words = [...prose.matchAll(/\p{L}[\p{L}’'-]*\p{L}|\p{L}/gu)];
    const candidates: string[] = [];
    let unknownCount = 0;
    for (const match of words) {
      const word = match[0].replace(/’/g, "'");
      const end = match.index + match[0].length;
      const touchesCode = /[\d_]/.test(prose[match.index - 1] ?? '') || /[\d_]/.test(prose[end] ?? '');
      if (touchesCode) continue;
      const isKnown =
        known(word) ||
        // Hyphenated words are fine when every part is a word.
        (word.includes('-') && word.split('-').every((part) => !part || known(part))) ||
        // Possessives and contractions of known words.
        (/'s$/i.test(word) && known(word.slice(0, -2)));
      if (isKnown) continue;
      unknownCount++;
      if (word.length >= 3 && !/\p{Lu}/u.test(word)) candidates.push(word.toLowerCase());
    }
    if (words.length >= 4 && unknownCount / words.length > 0.4) continue;
    for (const word of candidates) unknown.add(word);
  }
  return [...unknown];
}

export function suggestions(word: string): string[] {
  return loadDictionary()
    .suggest(word, { numSuggestions: 3 })
    .filter((s: string) => !s.includes("'"))
    .slice(0, 3);
}

export function spellingModule(): CheckModule {
  return {
    id: 'spelling',
    name: 'Spelling (British English)',
    perViewport: false,
    async run({ page }) {
      const { lang, text } = await page.evaluate(() => {
        // Visible text only, as laid out: a line break wherever the layout starts a new line or cell.
        const SKIP = 'script, style, noscript, template, code, pre, kbd, samp, var, input, textarea, select, svg, [aria-hidden="true"], [hidden], [translate="no"]';
        // Cookie and consent banners and cookie tables list technical names, not prose.
        const CONSENT = /cookie|consent|gdpr|onetrust|cookiebot|cookieyes|hs-banner|cc-window|privacy-banner/i;
        const root = document.querySelector('main') ?? document.body;
        if (!root) return { lang: document.documentElement.lang, text: '' };
        const skipped = new WeakMap<Element, boolean>();
        const skip = (el: Element): boolean => {
          const seen = skipped.get(el);
          if (seen !== undefined) return seen;
          let result = false;
          if (el.matches(SKIP)) result = true;
          // Text marked as another language.
          else if (el.hasAttribute('lang') && !/^en\b/i.test(el.getAttribute('lang')!)) result = true;
          else if (CONSENT.test(`${el.id} ${typeof el.className === 'string' ? el.className : ''}`)) result = true;
          else if (el.tagName === 'TABLE' && /cookie/i.test(el.textContent ?? '') && el.querySelectorAll('td').length > 3) result = true;
          else if (el.parentElement && el !== root) result = skip(el.parentElement);
          skipped.set(el, result);
          return result;
        };
        const blockOf = (el: Element): Element => {
          for (let node: Element | null = el; node && node !== root; node = node.parentElement) {
            const display = getComputedStyle(node).display;
            if (!display.startsWith('inline') && display !== 'contents') return node;
          }
          return root;
        };
        const parts: string[] = [];
        let lastBlock: Element | null = null;
        const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT | NodeFilter.SHOW_ELEMENT);
        for (let node = walker.nextNode(); node; node = walker.nextNode()) {
          if (node instanceof Element) {
            if (node.tagName === 'BR') parts.push('\n');
            continue;
          }
          const parent = node.parentElement;
          if (!parent || !node.textContent?.trim() || skip(parent) || !parent.checkVisibility()) continue;
          const block = blockOf(parent);
          if (block !== lastBlock) parts.push('\n');
          lastBlock = block;
          parts.push(node.textContent);
        }
        return { lang: document.documentElement.lang, text: parts.join('') };
      });
      if (lang && !/^en\b/i.test(lang)) return [];
      return misspelledWords(text)
        .slice(0, MAX_WORDS_PER_PAGE)
        .map((word) => finding(word, text));
    },
  };
}

function finding(word: string, text: string): CheckFinding {
  const guidance = guidanceFor('prego', 'spelling')!;
  const at = text.toLowerCase().search(new RegExp(`\\b${word.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`));
  const context = at >= 0 ? text.slice(Math.max(0, at - 40), at + word.length + 40).replace(/\s+/g, ' ').trim() : '';
  const suggested = suggestions(word);
  return {
    module: 'spelling',
    engine: 'prego',
    ruleId: 'spelling',
    category: 'CONT',
    severity: 'Low',
    title: `${guidance.title}: “${word}”`,
    description: guidance.description,
    helpUrl: null,
    wcagCriteria: [],
    wcagLevel: null,
    selector: 'html',
    html: '<html>',
    failureSummary: `“${word}” isn’t in the British English dictionary${suggested.length ? `. Did you mean ${suggested.map((s) => `“${s}”`).join(', ')}?` : '.'}${context ? ` In: “…${context}…”` : ''}`,
    siteWide: true,
    component: `spelling:${word}`,
  };
}
