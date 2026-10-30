import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { gunzipSync } from 'node:zlib';
import { decodeTrie, type ITrie } from 'cspell-trie-lib';
import type { CheckFinding, CheckModule } from '../types.js';
import { guidanceFor } from '../guidance.js';

// Spelling against cspell's MIT-licensed British English dictionary. Capitalised words, acronyms and
// anything with digits are skipped, as they're usually names, products and codes. Each unknown word
// is one site-wide ticket, so dismissing it as a false positive keeps it quiet in later audits.

const require = createRequire(import.meta.url);
let dictionary: ITrie | undefined;
const loadDictionary = () => (dictionary ??= decodeTrie(gunzipSync(readFileSync(join(dirname(require.resolve('@cspell/dict-en-gb-mit/cspell-ext.json')), 'en_GB.trie.gz')))));

/** Words common on websites that the dictionary leaves out. */
const WEB_WORDS = new Set(['signup', 'login', 'logout', 'checkout', 'homepage', 'webpage', 'username', 'dropdown', 'popup', 'navbar', 'cookie', 'cookies', 'app', 'apps', 'blog', 'vlog', 'podcast', 'hashtag', 'emoji', 'wifi', 'ebook', 'unsubscribe', 'faq', 'faqs', 'url', 'urls', 'inbox', 'eg', 'ie', 'etc', 'vs', 'pm', 'am']);
const MAX_WORDS_PER_PAGE = 30;

/** Words on a page that the British English dictionary doesn't know. Exported for tests. */
export function misspelledWords(text: string): string[] {
  const dict = loadDictionary();
  const unknown = new Set<string>();
  // Leave out addresses, emails and anything that looks like code.
  const prose = text.replace(/\S+@\S+|https?:\/\/\S+|www\.\S+|\S+\.(com|org|net|co\.uk|uk|io)\b\S*/gi, ' ');
  for (const match of prose.matchAll(/\p{L}[\p{L}’'-]*\p{L}|\p{L}/gu)) {
    const word = match[0].replace(/’/g, "'");
    if (word.length < 3 || /\p{Lu}/u.test(word) || /\d/.test(prose.slice(match.index + word.length, match.index + word.length + 1))) continue;
    const lower = word.toLowerCase();
    if (WEB_WORDS.has(lower) || dict.has(lower) || dict.has(word)) continue;
    // Hyphenated words are fine when every part is a word.
    if (word.includes('-') && word.split('-').every((part) => !part || dict.has(part.toLowerCase()) || WEB_WORDS.has(part.toLowerCase()))) continue;
    // Possessives and contractions of known words.
    if (/'s$/.test(lower) && dict.has(lower.slice(0, -2))) continue;
    unknown.add(lower);
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
        // Visible text only, without code samples and form values.
        const root = (document.querySelector('main') ?? document.body)?.cloneNode(true) as HTMLElement | undefined;
        root?.querySelectorAll('script, style, noscript, code, pre, kbd, samp, input, textarea, select, [aria-hidden="true"], [hidden], [translate="no"]').forEach((e) => e.remove());
        return { lang: document.documentElement.lang, text: root?.textContent ?? '' };
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
