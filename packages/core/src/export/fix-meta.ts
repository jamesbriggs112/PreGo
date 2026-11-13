import type { Category, Severity, Ticket } from '../types.js';
import { isAdvisory } from '../tickets/advisory.js';
import { AXE_EQUIVALENT } from '../checks/ibm/ibm-guidance.js';

// What each issue means for the people fixing it: the fix as an action, who does it, how big a job it
// is, how much it matters and to whom, where on the site it is, and how to check it's fixed. Used by
// the action plan and fix cards. Rules without an entry get sensible defaults from their category.

export type Owner = 'Developer' | 'Content editor' | 'Designer' | 'Hosting or IT' | 'Supplier' | 'Developer and DPO';
export type Effort = 'Quick' | 'Small' | 'Medium' | 'Large';
export type Impact = 'High' | 'Medium' | 'Low';
export type Area = 'Site header and navigation' | 'Site footer' | 'Forms' | 'Media and embeds' | 'Page templates' | 'Site-wide technical' | 'Content';

export const EFFORT_TEXT: Record<Effort, string> = { Quick: 'Quick (under an hour)', Small: 'Small (under a day)', Medium: 'Medium (1–3 days)', Large: 'Large (over 3 days)' };
export const AREAS: Area[] = ['Site header and navigation', 'Site footer', 'Forms', 'Media and embeds', 'Page templates', 'Content', 'Site-wide technical'];

interface RuleMeta {
  /** The fix, starting with a verb: "Give the menu button a name". */
  action: string;
  owner?: Owner;
  /** The job in one place; content fixes repeated on many pages grow with the number of pages. */
  effort?: Effort;
  /** One or two words: who or what it matters for. */
  reason?: string;
  /** A check the client can do themselves once it's fixed. */
  check?: string;
}

const RULES: Record<string, RuleMeta> = {
  'button-name': {
    action: 'Give buttons a name screen readers can say',
    effort: 'Quick',
    reason: 'Screen reader users',
    check: 'With VoiceOver or NVDA on, Tab to the button: it should say what it does, for example “Menu, button”.',
  },
  'link-name': {
    action: 'Give icon links a text name',
    effort: 'Quick',
    reason: 'Screen reader users',
    check: 'With a screen reader on, Tab to the link: it should say where it goes, for example “LinkedIn, link”.',
  },
  'image-alt': {
    action: 'Add text alternatives to images',
    owner: 'Content editor',
    effort: 'Small',
    reason: 'Screen reader users',
    check: 'Right-click the image and inspect it: it should have an alt text describing it, or alt="" if it’s decoration.',
  },
  'svg-img-alt': { action: 'Give meaningful icons and graphics a text alternative', effort: 'Small', reason: 'Screen reader users' },
  'role-img-alt': { action: 'Give meaningful icons and graphics a text alternative', effort: 'Small', reason: 'Screen reader users' },
  'color-contrast': {
    action: 'Darken low-contrast text or its background',
    owner: 'Designer',
    effort: 'Small',
    reason: 'Low vision',
    check: 'Check the colours in a contrast checker (such as WebAIM’s): normal text needs at least 4.5 to 1.',
  },
  label: { action: 'Label every form field', effort: 'Quick', reason: 'Screen reader users', check: 'Click the field’s label: the cursor should move into the field.' },
  'select-name': {
    action: 'Label drop-down menus',
    effort: 'Quick',
    reason: 'Screen reader users',
    check: 'With a screen reader on, Tab to the menu: it should say what it’s for.',
  },
  'aria-input-field-name': { action: 'Label interactive fields', effort: 'Quick', reason: 'Screen reader users' },
  'html-has-lang': {
    action: 'Set the page language in the page template',
    effort: 'Quick',
    reason: 'Screen reader users',
    check: 'View the page source: the <html> tag should have lang="en-GB".',
  },
  'document-title': { action: 'Give every page a title', effort: 'Quick', reason: 'Everyone' },
  'frame-title': { action: 'Give embedded frames a title', effort: 'Quick', reason: 'Screen reader users' },
  'aria-required-children': { action: 'Fix the carousel’s structure for screen readers', effort: 'Small', reason: 'Screen reader users' },
  'aria-required-parent': { action: 'Fix the carousel’s structure for screen readers', effort: 'Small', reason: 'Screen reader users' },
  list: { action: 'Mark lists up as lists', effort: 'Quick', reason: 'Screen reader users' },
  'target-size': { action: 'Make small buttons and links bigger or further apart', owner: 'Designer', effort: 'Small', reason: 'Touch screens' },
  'keyboard-trap': {
    action: 'Let keyboard users move past the trapped element',
    effort: 'Small',
    reason: 'Keyboard users',
    check: 'Tab through the page: focus should never get stuck.',
  },
  'focus-not-visible': {
    action: 'Show where keyboard focus is',
    owner: 'Designer',
    effort: 'Small',
    reason: 'Keyboard users',
    check: 'Tab through the page: every link and button should show a clear outline when reached.',
  },
  'skip-link-missing': {
    action: 'Add a “Skip to content” link',
    effort: 'Quick',
    reason: 'Keyboard users',
    check: 'Press Tab once on a fresh page: a “Skip to content” link should appear.',
  },
  reflow: { action: 'Stop pages scrolling sideways on narrow screens', effort: 'Small', reason: 'Low vision' },
  'zoom-text-clipped': { action: 'Stop text being cut off when zoomed', effort: 'Small', reason: 'Low vision' },
  'text-spacing': { action: 'Let text grow when spacing is increased', effort: 'Small', reason: 'Dyslexia' },
  'duplicate-title': { action: 'Give each page its own title', owner: 'Content editor', reason: 'Search' },
  'alt-text-unhelpful': { action: 'Rewrite image descriptions that say nothing', owner: 'Content editor', reason: 'Screen reader users' },
  'no-accessibility-statement': { action: 'Publish an accessibility statement', owner: 'Content editor', effort: 'Small', reason: 'Legal risk' },
  'accessibility-statement-outdated': { action: 'Review and re-date the accessibility statement', owner: 'Content editor', effort: 'Small', reason: 'Legal risk' },
  'broken-link': { action: 'Fix or remove broken links', owner: 'Content editor', effort: 'Quick', reason: 'Trust' },
  'link-access-denied': { action: 'Check links that refuse access', owner: 'Content editor', effort: 'Quick', reason: 'Trust' },
  'meta-description-missing': { action: 'Write meta descriptions for key pages', owner: 'Content editor', reason: 'Search' },
  'meta-description-length': { action: 'Shorten or lengthen meta descriptions', owner: 'Content editor', reason: 'Search' },
  'title-length': { action: 'Shorten page titles to under 60 characters', owner: 'Content editor', reason: 'Search' },
  'canonical-missing': { action: 'Set a canonical address on every page', effort: 'Quick', reason: 'Search' },
  'open-graph-missing': { action: 'Add link-preview details for sharing', effort: 'Small', reason: 'Sharing' },
  spelling: { action: 'Correct spelling mistakes', owner: 'Content editor', effort: 'Quick', reason: 'Trust' },
  'trackers-before-consent': {
    action: 'Stop trackers loading before visitors agree',
    owner: 'Developer and DPO',
    effort: 'Medium',
    reason: 'Legal risk',
    check: 'Open the site in a private window and, before accepting cookies, check the browser’s network tab: no analytics or advertising requests.',
  },
  'tracking-cookies-before-consent': { action: 'Stop tracking cookies being set before visitors agree', owner: 'Developer and DPO', effort: 'Medium', reason: 'Legal risk' },
  'missing-csp': { action: 'Add a Content Security Policy', owner: 'Hosting or IT', effort: 'Medium', reason: 'Security' },
  'missing-hsts': { action: 'Turn on HSTS', owner: 'Hosting or IT', effort: 'Quick', reason: 'Security' },
  'missing-frame-protection': { action: 'Stop other sites embedding your pages', owner: 'Hosting or IT', effort: 'Quick', reason: 'Security' },
  'missing-nosniff': { action: 'Add the X-Content-Type-Options header', owner: 'Hosting or IT', effort: 'Quick', reason: 'Security' },
  'missing-referrer-policy': { action: 'Add a referrer policy', owner: 'Hosting or IT', effort: 'Quick', reason: 'Privacy' },
  'missing-permissions-policy': { action: 'Add a permissions policy', owner: 'Hosting or IT', effort: 'Quick', reason: 'Security' },
  'vulnerable-software': { action: 'Confirm the server software is up to date', owner: 'Hosting or IT', effort: 'Medium', reason: 'Security' },
  'end-of-life-software': { action: 'Upgrade software that no longer gets security fixes', owner: 'Hosting or IT', effort: 'Large', reason: 'Security' },
  'vulnerable-library': { action: 'Update the out-of-date script library', effort: 'Small', reason: 'Security' },
  'mixed-content': { action: 'Load every file over HTTPS', effort: 'Quick', reason: 'Security' },
  'no-https': { action: 'Serve the site over HTTPS', owner: 'Hosting or IT', effort: 'Medium', reason: 'Security' },
  'structured-data-missing': { action: 'Add structured data about the organisation and pages', effort: 'Small', reason: 'Search and AI' },
  'organisation-data-missing': { action: 'Say who runs the site in structured data', effort: 'Quick', reason: 'Search and AI' },
  'sitemap-missing': { action: 'Publish a sitemap', effort: 'Quick', reason: 'Search' },
  'sitemap-no-dates': { action: 'Add last-changed dates to the sitemap', effort: 'Quick', reason: 'Search' },
  'colour-near-duplicates': { action: 'Merge colours that are almost the same', owner: 'Designer', effort: 'Small', reason: 'Consistency' },
  'font-size-near-duplicates': { action: 'Merge text sizes that are almost the same', owner: 'Designer', effort: 'Small', reason: 'Consistency' },
  'spacing-near-duplicates': { action: 'Merge spacing values a pixel apart', owner: 'Designer', effort: 'Small', reason: 'Consistency' },
  'landmark-unique': { action: 'Give each page region a distinct label', effort: 'Quick', reason: 'Screen reader users' },
  listitem: { action: 'Put list items inside a list', effort: 'Quick', reason: 'Screen reader users' },
  region: { action: 'Put all content inside the page’s regions', effort: 'Small', reason: 'Screen reader users' },
  'multiple-h1': { action: 'Keep one main heading per page', effort: 'Quick', reason: 'Screen reader users' },
  'target-size-touch': { action: 'Make touch targets at least 44 pixels square', owner: 'Designer', effort: 'Small', reason: 'Touch screens' },
  deprecations: { action: 'Replace browser features that are being withdrawn', effort: 'Small', reason: 'Reliability' },
  'errors-in-console': { action: 'Fix the errors scripts report in the browser', effort: 'Small', reason: 'Reliability' },
  'image-aspect-ratio': { action: 'Show images in their real proportions', effort: 'Quick', reason: 'Quality' },
  'link-text': { action: 'Use link text that says where the link goes', owner: 'Content editor', effort: 'Small', reason: 'Search' },
  'third-party-cookies': { action: 'Remove third-party cookies', effort: 'Medium', reason: 'Privacy' },
  'browser-element-missing': { action: 'Make content show in every browser', effort: 'Small', reason: 'Visitors' },
  'browser-layout-differs': { action: 'Make the layout match in every browser', effort: 'Small', reason: 'Visitors' },
  'browser-script-error': { action: 'Fix scripts that fail in some browsers', effort: 'Small', reason: 'Visitors' },
  'line-height-near-duplicates': { action: 'Merge line heights that are almost the same', owner: 'Designer', effort: 'Small', reason: 'Consistency' },
  'too-many-font-sizes': { action: 'Settle on a smaller set of text sizes', owner: 'Designer', effort: 'Medium', reason: 'Consistency' },
  'too-many-fonts': { action: 'Use fewer typefaces', owner: 'Designer', effort: 'Small', reason: 'Consistency' },
  'too-many-greys': { action: 'Use fewer shades of grey', owner: 'Designer', effort: 'Small', reason: 'Consistency' },
  'weak-csp': { action: 'Tighten the Content Security Policy', owner: 'Hosting or IT', effort: 'Medium', reason: 'Security' },
  'no-sitemap': { action: 'Publish a sitemap', effort: 'Quick', reason: 'Search' },
  'staging-links': { action: 'Point links at the live site, not staging', owner: 'Content editor', effort: 'Quick', reason: 'Trust' },
  // Lighthouse.
  'bootup-time': { action: 'Cut the JavaScript that runs as pages load', effort: 'Small', reason: 'Speed' },
  'mainthread-work-breakdown': { action: 'Cut the work the browser does as pages load', effort: 'Small', reason: 'Speed' },
  'cache-insight': { action: 'Let browsers keep files for longer', effort: 'Small', reason: 'Speed' },
  'uses-long-cache-ttl': { action: 'Let browsers keep files for longer', effort: 'Small', reason: 'Speed' },
  'font-display-insight': { action: 'Show text while web fonts load', effort: 'Small', reason: 'Speed' },
  'font-display': { action: 'Show text while web fonts load', effort: 'Small', reason: 'Speed' },
  'image-delivery-insight': { action: 'Resize and compress images', effort: 'Small', reason: 'Speed' },
  'uses-optimized-images': { action: 'Resize and compress images', effort: 'Small', reason: 'Speed' },
  'modern-image-formats': { action: 'Serve images in modern formats', effort: 'Small', reason: 'Speed' },
  'uses-responsive-images': { action: 'Resize and compress images', effort: 'Small', reason: 'Speed' },
  interactive: { action: 'Make pages respond to taps and clicks sooner', effort: 'Small', reason: 'Speed' },
  'max-potential-fid': { action: 'Make pages respond to taps and clicks sooner', effort: 'Small', reason: 'Speed' },
  'total-blocking-time': { action: 'Make pages respond to taps and clicks sooner', effort: 'Small', reason: 'Speed' },
  'largest-contentful-paint': { action: 'Show the main image or heading sooner', effort: 'Small', reason: 'Speed' },
  'lcp-discovery-insight': { action: 'Show the main image or heading sooner', effort: 'Small', reason: 'Speed' },
  'first-contentful-paint': { action: 'Show something on screen sooner', effort: 'Small', reason: 'Speed' },
  'speed-index': { action: 'Show something on screen sooner', effort: 'Small', reason: 'Speed' },
  'network-dependency-tree-insight': { action: 'Load fewer files one after another', effort: 'Small', reason: 'Speed' },
  'render-blocking-insight': { action: 'Stop scripts and styles blocking the page', effort: 'Small', reason: 'Speed' },
  'render-blocking-resources': { action: 'Stop scripts and styles blocking the page', effort: 'Small', reason: 'Speed' },
  'unminified-javascript': { action: 'Minify JavaScript', effort: 'Small', reason: 'Speed' },
  'unminified-css': { action: 'Minify CSS', effort: 'Small', reason: 'Speed' },
  'unused-css-rules': { action: 'Remove unused CSS', effort: 'Small', reason: 'Speed' },
  'unused-javascript': { action: 'Remove unused JavaScript', effort: 'Small', reason: 'Speed' },
  'legacy-javascript-insight': { action: 'Stop sending old-browser JavaScript to modern browsers', effort: 'Small', reason: 'Speed' },
  'unsized-images': { action: 'Give images a width and height', effort: 'Small', reason: 'Speed' },
  'bf-cache': { action: 'Let the back button reload pages instantly', effort: 'Small', reason: 'Speed' },
  'total-byte-weight': { action: 'Make pages lighter to download', effort: 'Small', reason: 'Speed' },
  redirects: { action: 'Remove extra redirects', effort: 'Small', reason: 'Speed' },
  'layout-shifts': { action: 'Stop the page jumping as it loads', effort: 'Small', reason: 'Speed' },
  'cls-culprits-insight': { action: 'Stop the page jumping as it loads', effort: 'Small', reason: 'Speed' },
  'cumulative-layout-shift': { action: 'Stop the page jumping as it loads', effort: 'Small', reason: 'Speed' },
  'server-response-time': { action: 'Make the server respond faster', effort: 'Small', reason: 'Speed' },
  'uses-text-compression': { action: 'Compress text files', effort: 'Small', reason: 'Speed' },
  'dom-size': { action: 'Simplify very large pages', effort: 'Small', reason: 'Speed' },
  'third-party-summary': { action: 'Cut slow outside scripts', effort: 'Small', reason: 'Speed' },
  // IBM rules with no axe equivalent.
  aria_navigation_label_unique: { action: 'Give each menu a different label', effort: 'Quick', reason: 'Screen reader users' },
  aria_form_label_unique: { action: 'Give each form a different label', effort: 'Quick', reason: 'Screen reader users' },
  aria_role_valid: { action: 'Remove invalid ARIA roles', effort: 'Quick', reason: 'Screen reader users' },
  skip_main_exists: { action: 'Mark the main content and add a skip link', effort: 'Quick', reason: 'Keyboard users' },
  input_checkboxes_grouped: { action: 'Group related checkboxes under a question', effort: 'Quick', reason: 'Screen reader users' },
  label_ref_valid: { action: 'Point labels at the right form fields', effort: 'Quick', reason: 'Screen reader users' },
};

/** Defaults by category, for rules without an entry. */
const BY_CATEGORY: Record<Category, { owner: Owner; reason: string }> = {
  A11Y: { owner: 'Developer', reason: 'Disabled visitors' },
  UX: { owner: 'Developer', reason: 'Visitors' },
  UI: { owner: 'Designer', reason: 'Consistency' },
  CONT: { owner: 'Content editor', reason: 'Search' },
  PERF: { owner: 'Developer', reason: 'Speed' },
  SEC: { owner: 'Hosting or IT', reason: 'Security' },
  TECH: { owner: 'Developer', reason: 'Reliability' },
  FUT: { owner: 'Developer', reason: 'Search and AI' },
};

/** Who an accessibility problem affects, from its WCAG criterion. */
const AFFECTS_BY_CRITERION: [RegExp, string[]][] = [
  [/^1\.1\./, ['Screen reader users']],
  [/^1\.2\./, ['Deaf and hard-of-hearing people']],
  [/^1\.3\./, ['Screen reader users']],
  [/^1\.4\.(3|6|11)$/, ['People with low vision', 'Anyone in bright light']],
  [/^1\.4\.(4|10|12)$/, ['People with low vision', 'People who zoom in']],
  [/^1\.4\./, ['People with low vision']],
  [/^2\.1\./, ['Keyboard users', 'Switch users']],
  [/^2\.4\.(3|7|11)$/, ['Keyboard users']],
  [/^2\.4\./, ['Screen reader users', 'Keyboard users']],
  [/^2\.5\.(5|8)$/, ['People with limited dexterity', 'Touch screen users']],
  [/^2\.5\.3$/, ['Voice control users']],
  [/^3\.1\./, ['Screen reader users']],
  [/^3\.3\./, ['Anyone filling in forms']],
  [/^4\.1\./, ['Screen reader users', 'Voice control users']],
];

export interface FixMeta {
  action: string;
  owner: Owner;
  effort: Effort;
  impact: Impact;
  reason: string;
  area: Area;
  /** Who it affects, for accessibility problems. */
  affects: string[];
  check: string | null;
  advisory: boolean;
  /** Higher comes first: severity × reach × confidence ÷ effort. */
  score: number;
}

const SEVERITY_WEIGHT: Record<Severity, number> = { Critical: 8, High: 4, Medium: 2, Low: 1 };
const EFFORT_WEIGHT: Record<Effort, number> = { Quick: 1, Small: 2, Medium: 4, Large: 8 };
const EFFORTS: Effort[] = ['Quick', 'Small', 'Medium', 'Large'];

type MetaTicket = Pick<
  Ticket,
  'ruleId' | 'engine' | 'category' | 'severity' | 'title' | 'locationsAffected' | 'wcagCriterion' | 'wcagLevel' | 'templateKey' | 'exampleSelector' | 'recommendation'
> & {
  occurrenceList?: { html: string }[];
};

/** Where a ticket's fix happens, from its title's location label and its element. */
export function areaOf(t: MetaTicket): Area {
  const label = /\(([^)]*)\)$/.exec(t.title)?.[1] ?? '';
  const html = t.occurrenceList?.[0]?.html ?? '';
  if (/^<(iframe|video|audio|object|embed)\b/i.test(html)) return 'Media and embeds';
  if (/site header|site navigation/.test(label)) return 'Site header and navigation';
  if (/site footer/.test(label)) return 'Site footer';
  if (/^form on|, form on/.test(label) || /^<(input|select|textarea|form|label)\b/i.test(html)) return 'Forms';
  if (label === 'site-wide' || ['SEC', 'PERF', 'FUT'].includes(t.category) || t.category === 'TECH') return 'Site-wide technical';
  if (t.category === 'CONT' || t.category === 'UX') return 'Content';
  return 'Page templates';
}

/** The meta for one ticket. `audited` is how many pages (or screens) were checked. */
export function fixMetaFor(t: MetaTicket, audited: number): FixMeta {
  const rule = RULES[t.ruleId] ?? RULES[AXE_EQUIVALENT[t.ruleId] ?? ''];
  const defaults = BY_CATEGORY[t.category];
  const owner = rule?.owner ?? defaults.owner;
  const advisory = isAdvisory(t);
  // Content fixed page by page grows with the pages; a component or setting is one fix however many pages show it.
  let effort: Effort = rule?.effort ?? 'Small';
  if (owner === 'Content editor' && !rule?.effort)
    effort = t.locationsAffected <= 3 ? 'Quick' : t.locationsAffected <= 20 ? 'Small' : t.locationsAffected <= 60 ? 'Medium' : 'Large';
  const impact: Impact = advisory || t.severity === 'Low' ? 'Low' : t.severity === 'Medium' ? 'Medium' : 'High';
  const criteria = (t.wcagCriterion ?? '').split(/,\s*/).filter(Boolean);
  const affects = t.category === 'A11Y' ? [...new Set(criteria.flatMap((c) => AFFECTS_BY_CRITERION.find(([re]) => re.test(c))?.[1] ?? []))] : [];
  // Findings from the second engine, from a version number alone or from the AI are less certain.
  const confidence = t.engine === 'ollama' ? 0.5 : t.engine === 'ibm' ? 0.8 : t.ruleId === 'vulnerable-software' ? 0.6 : 1;
  const reach = 1 + Math.min(1, t.locationsAffected / Math.max(1, audited));
  return {
    action: rule?.action ?? (t.engine === 'html-validate' ? 'Correct invalid HTML in the page templates' : actionFrom(t)),
    owner,
    effort,
    impact,
    reason: rule?.reason ?? (affects[0] || defaults.reason),
    area: areaOf(t),
    affects,
    check: rule?.check ?? null,
    advisory,
    score: advisory ? 0 : (SEVERITY_WEIGHT[t.severity] * reach * confidence) / EFFORT_WEIGHT[effort],
  };
}

/** A fix as an action for rules without one: the recommendation's first sentence, if it's short and starts with a verb. */
function actionFrom(t: MetaTicket): string {
  // The first sentence, cut at its first comma or semicolon so it stays short.
  const first = t.recommendation
    .split(/(?<=\.)\s/)[0]
    .replace(/\.$/, '')
    .split(/[,;:]\s/)[0];
  const verbs =
    /^(Add|Give|Make|Use|Set|Remove|Fix|Check|Change|Update|Replace|Move|Write|Turn|Stop|Let|Mark|Label|Show|Keep|Avoid|Reduce|Compress|Serve|Load|Publish|Review|Increase|Shorten|Confirm|Ask|Upgrade|Wrap|Define|Limit|Generate|Put|Merge|Delete|Enable|Disable|Include|Provide|Rewrite|Lower|Raise|Group|Split|Host)\b/;
  if (first.split(/\s+/).length <= 12 && verbs.test(first)) return first;
  return `Fix: ${t.title.replace(/ \([^)]*\)$/, '').replace(/^./, (c) => c.toLowerCase())}`;
}

/** The bigger of two efforts. */
export const largerEffort = (a: Effort, b: Effort): Effort => (EFFORTS.indexOf(a) >= EFFORTS.indexOf(b) ? a : b);
