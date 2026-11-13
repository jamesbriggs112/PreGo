import { Paragraph, TextRun } from 'docx';

// The words a client report can't avoid, explained once at the back.

export const GLOSSARY: [string, string][] = [
  ['Accessibility checker', 'Software that tests a page against the accessibility guidelines. Prego uses two: axe, by Deque, and Equal Access, by IBM.'],
  ['Alt text', 'A short description of an image, read out by screen readers and shown if the image doesn’t load.'],
  ['ARIA', 'Extra code that tells assistive technology what a custom control is and what state it’s in. Used wrongly, it makes things worse.'],
  ['Canonical address', 'The address a page says is its main one, so search engines don’t count copies separately.'],
  ['Consent banner', 'The message that asks visitors whether they agree to cookies and tracking. Trackers shouldn’t load until they do.'],
  ['Content Security Policy (CSP)', 'A setting on the server that says which other sites a page may load scripts and files from. It limits the damage from injected code.'],
  ['Contrast ratio', 'How much text stands out from its background, from 1 to 1 (none) to 21 to 1 (black on white). WCAG asks for 4.5 to 1 for normal text.'],
  ['Core Web Vitals', 'Google’s measures of how fast a page loads, how soon it responds and how much it jumps about. They affect search ranking.'],
  ['Keyboard focus', 'The outline showing which link, button or field the keyboard is on. People who can’t use a mouse rely on it.'],
  ['Landmark', 'A labelled region of a page, such as the header, navigation, main content or footer, that screen reader users can jump between.'],
  ['Lighthouse', 'Google’s tool for measuring page speed and quality. The speed scores in this report come from it.'],
  ['Screen reader', 'Software that reads the screen aloud, used by blind and partially sighted people. VoiceOver and NVDA are common ones.'],
  ['Structured data', 'Code that describes a page’s contents (an organisation, an article, an event) in a form search engines and AI assistants understand.'],
  ['Template', 'The layout a group of pages share, such as all news articles. A fix in a template fixes every page built from it.'],
  ['WCAG', 'The Web Content Accessibility Guidelines, the international standard for accessible websites. Level A is the minimum, AA the usual target, and AAA the highest.'],
];

export function glossaryParagraphs(): Paragraph[] {
  return GLOSSARY.map(([term, meaning]) => new Paragraph({ spacing: { after: 100 }, children: [new TextRun({ text: `${term}: `, bold: true }), new TextRun(meaning)] }));
}
