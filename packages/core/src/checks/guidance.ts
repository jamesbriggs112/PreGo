// Plain-English wording for rules, used in tickets and the Word report. The report is read by client
// project managers, so this avoids jargon; selectors and rule IDs go in the CSV instead.
// Rules without an entry fall back to the engine's own text.

export type Effort = 'Small' | 'Medium' | 'Large';

export interface RuleGuidance {
  /** Short statement of the problem. */
  title: string;
  description: string;
  whyItMatters: string;
  recommendation: string;
  effort: Effort;
}

const AXE: Record<string, RuleGuidance> = {
  'image-alt': {
    title: 'Images have no text alternative',
    description: 'Images are missing an alt attribute, so there is no text describing them.',
    whyItMatters: 'Screen reader users hear nothing, or the file name, instead of what the image shows. If the image is a link, they can’t tell where it goes.',
    recommendation: 'Add an alt attribute to every image. Describe what the image conveys, or use alt="" if it is purely decorative.',
    effort: 'Small',
  },
  'color-contrast': {
    title: 'Text does not stand out enough from its background',
    description: 'The contrast between text and background colours is below the WCAG minimum (4.5:1 for normal text, 3:1 for large text).',
    whyItMatters: 'People with low vision or colour blindness, and anyone reading on a phone in sunlight, may not be able to read this text.',
    recommendation: 'Darken the text or lighten the background until the contrast ratio meets 4.5:1 (3:1 for large text). Update the colour in the design system so every use is fixed.',
    effort: 'Small',
  },
  'color-contrast-enhanced': {
    title: 'Text does not meet enhanced contrast',
    description: 'The contrast between text and background is below the AAA level of 7:1.',
    whyItMatters: 'Higher contrast helps people with moderate low vision read comfortably.',
    recommendation: 'Increase contrast to 7:1 for body text where the design allows.',
    effort: 'Small',
  },
  label: {
    title: 'Form fields have no label',
    description: 'Form fields have no programmatic label. Placeholder text alone does not count, because it disappears when the user types.',
    whyItMatters: 'Screen reader users are not told what to enter, and voice control users can’t say the field’s name to select it.',
    recommendation: 'Give every field a visible <label> linked with for/id, or wrap the field in the label.',
    effort: 'Small',
  },
  'select-name': {
    title: 'Drop-down menus have no label',
    description: 'Select menus have no accessible name.',
    whyItMatters: 'Screen reader users hear "combo box" with no indication of what it is for.',
    recommendation: 'Add a visible <label> linked to the select with for/id.',
    effort: 'Small',
  },
  'html-has-lang': {
    title: 'Page language is not set',
    description: 'The <html> element has no lang attribute.',
    whyItMatters: 'Screen readers guess the language and may read the page with the wrong pronunciation. Browser translation also works less well.',
    recommendation: 'Add lang="en" (or the correct language code) to the <html> element in the page template.',
    effort: 'Small',
  },
  'html-lang-valid': {
    title: 'Page language code is not valid',
    description: 'The lang attribute on <html> is not a valid language code.',
    whyItMatters: 'Screen readers can’t pick the right voice and pronunciation.',
    recommendation: 'Use a valid BCP 47 code such as en, en-GB or cy.',
    effort: 'Small',
  },
  'heading-order': {
    title: 'Heading levels are skipped',
    description: 'Headings jump more than one level (for example from h1 to h3), so the page outline has gaps.',
    whyItMatters: 'Screen reader users navigate by headings. Skipped levels suggest missing sections and make the structure harder to follow.',
    recommendation: 'Use heading levels in order without skipping. Change the styling with CSS rather than picking a heading level for its size.',
    effort: 'Small',
  },
  'page-has-heading-one': {
    title: 'Page has no main heading',
    description: 'The page has no level-one heading.',
    whyItMatters: 'A main heading tells screen reader users what the page is about and gives them a starting point.',
    recommendation: 'Add a single h1 that describes the page’s purpose.',
    effort: 'Small',
  },
  'empty-heading': {
    title: 'Headings are empty',
    description: 'Heading elements contain no text a screen reader can read.',
    whyItMatters: 'Screen reader users hear "heading" with nothing after it, which is confusing when navigating by headings.',
    recommendation: 'Remove empty headings or give them meaningful text.',
    effort: 'Small',
  },
  'document-title': {
    title: 'Page has no title',
    description: 'The page has no <title>, or it is empty.',
    whyItMatters: 'The title is the first thing screen readers announce and what appears in browser tabs and search results.',
    recommendation: 'Give every page a unique, descriptive title.',
    effort: 'Small',
  },
  'link-name': {
    title: 'Links have no text',
    description: 'Links have no text a screen reader can read, often because they contain only an icon or image.',
    whyItMatters: 'Screen reader users can’t tell where the link goes.',
    recommendation: 'Add visible link text, or alt text on the image inside the link, or an aria-label.',
    effort: 'Small',
  },
  'button-name': {
    title: 'Buttons have no text',
    description: 'Buttons have no text a screen reader can read, often because they contain only an icon.',
    whyItMatters: 'Screen reader and voice control users can’t tell what the button does or activate it by name.',
    recommendation: 'Add visible text or an aria-label that describes the action.',
    effort: 'Small',
  },
  'input-button-name': {
    title: 'Input buttons have no text',
    description: 'Input buttons have no value or accessible name.',
    whyItMatters: 'Screen reader users can’t tell what the button does.',
    recommendation: 'Give the input a value attribute describing the action.',
    effort: 'Small',
  },
  'input-image-alt': {
    title: 'Image buttons have no text alternative',
    description: 'Image inputs have no alt text.',
    whyItMatters: 'Screen reader users can’t tell what the button does.',
    recommendation: 'Add alt text describing the action, such as alt="Search".',
    effort: 'Small',
  },
  region: {
    title: 'Some content sits outside the page landmarks',
    description: 'Content is not inside a landmark such as header, nav, main or footer.',
    whyItMatters: 'Screen reader users jump between landmarks to find content. Anything outside them is easy to miss.',
    recommendation: 'Wrap all content in the appropriate landmark elements in the page template.',
    effort: 'Medium',
  },
  'landmark-one-main': {
    title: 'Page has no main content landmark',
    description: 'The page has no <main> element (or role="main").',
    whyItMatters: 'Screen reader and keyboard users can’t jump straight to the main content.',
    recommendation: 'Wrap the page’s main content in a single <main> element.',
    effort: 'Small',
  },
  bypass: {
    title: 'No way to skip repeated content',
    description: 'The page has no skip link, heading or landmark that lets users bypass the navigation.',
    whyItMatters: 'Keyboard users must tab through every navigation link on every page before reaching the content.',
    recommendation: 'Add a "Skip to main content" link as the first focusable element, and use a <main> landmark.',
    effort: 'Small',
  },
  list: {
    title: 'Lists are not built correctly',
    description: 'A list element contains children other than list items.',
    whyItMatters: 'Screen readers announce the number of items in a list. Broken markup gives wrong counts or no list at all.',
    recommendation: 'Make sure <ul> and <ol> contain only <li> elements (or script/template).',
    effort: 'Small',
  },
  listitem: {
    title: 'List items are outside a list',
    description: 'List items are not inside a <ul> or <ol>.',
    whyItMatters: 'Screen readers can’t announce them as part of a list.',
    recommendation: 'Wrap list items in a <ul> or <ol>.',
    effort: 'Small',
  },
  'duplicate-id-aria': {
    title: 'IDs used by accessibility features are duplicated',
    description: 'Several elements share an ID that labels or describes something.',
    whyItMatters: 'Assistive technology may read the wrong label or description.',
    recommendation: 'Make every ID unique on the page.',
    effort: 'Small',
  },
  'frame-title': {
    title: 'Embedded frames have no title',
    description: 'Iframes have no title attribute.',
    whyItMatters: 'Screen reader users are not told what the embedded content is (a map, a video, a form).',
    recommendation: 'Add a short, descriptive title to each iframe.',
    effort: 'Small',
  },
  'meta-viewport': {
    title: 'Zooming is disabled on mobile',
    description: 'The viewport meta tag stops users zooming in.',
    whyItMatters: 'People with low vision rely on pinch-to-zoom to read text on phones.',
    recommendation: 'Remove user-scalable=no and maximum-scale values below 2 from the viewport meta tag.',
    effort: 'Small',
  },
  'aria-hidden-focus': {
    title: 'Hidden content can still receive keyboard focus',
    description: 'Elements hidden from screen readers with aria-hidden contain focusable items.',
    whyItMatters: 'Keyboard and screen reader users can land on something they’re told isn’t there.',
    recommendation: 'Make the content inside aria-hidden regions unfocusable (tabindex="-1" or inert), or stop hiding it.',
    effort: 'Medium',
  },
  'nested-interactive': {
    title: 'Interactive controls are nested inside each other',
    description: 'A control (such as a button) contains another control.',
    whyItMatters: 'Screen readers may not announce the inner control, and keyboard behaviour becomes unpredictable.',
    recommendation: 'Separate the controls so none is inside another.',
    effort: 'Medium',
  },
  'target-size': {
    title: 'Touch targets are too small',
    description: 'Interactive targets are smaller than 24 by 24 CSS pixels without enough spacing.',
    whyItMatters: 'People with tremors or limited dexterity, and anyone using a touchscreen, may tap the wrong thing.',
    recommendation: 'Make targets at least 24 by 24 pixels (44 by 44 is better on touchscreens and kiosks), or add spacing around them.',
    effort: 'Small',
  },
  'link-in-text-block': {
    title: 'Links in text rely on colour alone',
    description: 'Links inside paragraphs are distinguished from surrounding text only by colour.',
    whyItMatters: 'People who can’t distinguish the colours won’t see that the text is a link.',
    recommendation: 'Underline links in body text, or give them 3:1 contrast with surrounding text plus a non-colour cue on hover and focus.',
    effort: 'Small',
  },
  'scrollable-region-focusable': {
    title: 'Scrollable areas can’t be reached by keyboard',
    description: 'A scrolling region has no focusable content and can’t itself be focused.',
    whyItMatters: 'Keyboard users can’t scroll to read the hidden content.',
    recommendation: 'Add tabindex="0" and an accessible name to the scrollable region.',
    effort: 'Small',
  },
  'autocomplete-valid': {
    title: 'Form fields use an invalid autocomplete value',
    description: 'The autocomplete attribute has a value browsers don’t recognise.',
    whyItMatters: 'Browsers can’t fill in personal details automatically, which helps people with memory or motor impairments.',
    recommendation: 'Use a valid autocomplete token such as name, email or postal-code.',
    effort: 'Small',
  },
  'svg-img-alt': {
    title: 'SVG images have no text alternative',
    description: 'SVGs with role="img" have no accessible name.',
    whyItMatters: 'Screen reader users don’t know what the graphic shows.',
    recommendation: 'Add a <title> inside the SVG, or aria-label on it.',
    effort: 'Small',
  },
  'role-img-alt': {
    title: 'Elements marked as images have no text alternative',
    description: 'Elements with role="img" have no accessible name.',
    whyItMatters: 'Screen reader users don’t know what the image shows.',
    recommendation: 'Add an aria-label describing the image.',
    effort: 'Small',
  },
  'video-caption': {
    title: 'Videos have no captions',
    description: 'Video elements have no captions track.',
    whyItMatters: 'Deaf and hard-of-hearing visitors miss the spoken content, as does anyone watching with the sound off.',
    recommendation: 'Add a captions track (<track kind="captions">) for every video.',
    effort: 'Medium',
  },
};

/** Prego's own rules (state map, canvas detection). */
const PREGO: Record<string, RuleGuidance> = {
  'dead-end': {
    title: 'Screen has no way back or home',
    description: 'Once a visitor reaches this screen, nothing on it takes them anywhere else.',
    whyItMatters: 'Visitors get stuck. On a kiosk they have to wait for the idle timer or walk away, and the next visitor finds the interactive on the wrong screen.',
    recommendation: 'Add Back and Home buttons in the same place as on other screens.',
    effort: 'Small',
  },
  'no-op-action': {
    title: 'Button does nothing',
    description: 'Pressing this control doesn’t change anything on the screen.',
    whyItMatters: 'Visitors assume the interactive is broken and lose trust in it. Screen reader users get no feedback at all.',
    recommendation: 'Make the control do what its label says, or remove it. If it’s meant to be disabled, show that visually and mark it as disabled.',
    effort: 'Medium',
  },
  'deep-content': {
    title: 'Content is buried too deep',
    description: 'This screen takes more taps from the start than recommended to reach.',
    whyItMatters: 'Each extra step loses visitors, especially in a busy gallery where people give an interactive only a minute or two.',
    recommendation: 'Flatten the menu structure or add a shortcut to this content from a higher level.',
    effort: 'Large',
  },
  'inconsistent-navigation': {
    title: 'Navigation behaves inconsistently',
    description: 'A Home or Back button goes somewhere different here than it does on other screens.',
    whyItMatters: 'Visitors learn how navigation works from the first few screens. When it changes, they get lost and can’t predict where a button will take them.',
    recommendation: 'Make Home always go to the same screen, and Back always return to the screen the visitor came from.',
    effort: 'Small',
  },
};

const GENERIC_WHY =
  'This makes the interface harder or impossible to use for some people, including those using screen readers, keyboards or magnification.';

export function guidanceFor(engine: string, ruleId: string): RuleGuidance | undefined {
  if (engine === 'axe-core') return AXE[ruleId];
  if (engine === 'prego') return PREGO[ruleId];
  return undefined;
}

/** Guidance with fallbacks for rules that have no plain-English entry yet. */
export function guidanceWithFallback(
  engine: string,
  ruleId: string,
  fallback: { title: string; description: string; helpUrl: string | null },
): RuleGuidance {
  return (
    guidanceFor(engine, ruleId) ?? {
      title: fallback.title,
      description: fallback.description,
      whyItMatters: GENERIC_WHY,
      recommendation: fallback.helpUrl ? `Follow the guidance at ${fallback.helpUrl}.` : 'Review and fix the affected elements.',
      effort: 'Medium',
    }
  );
}
