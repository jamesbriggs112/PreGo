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
  'keyboard-trap': {
    title: 'Keyboard focus gets trapped',
    description: 'Once keyboard focus reaches this element, pressing Tab doesn’t move it on.',
    whyItMatters: 'People who use a keyboard or switch device instead of a mouse get stuck and can’t reach anything else on the page.',
    recommendation: 'Let Tab and Shift+Tab move focus out of the element. If it’s a widget that uses arrow keys inside, make sure Tab still leaves it.',
    effort: 'Small',
  },
  'focus-not-visible': {
    title: 'Keyboard focus is invisible',
    description: 'When this element has keyboard focus, nothing about its appearance changes.',
    whyItMatters: 'Keyboard users can’t see where they are on the page, so they can’t tell what pressing Enter will do.',
    recommendation: 'Don’t remove focus outlines. If the design needs a different style, use :focus-visible to show a clear outline or ring with at least 3:1 contrast.',
    effort: 'Small',
  },
  reflow: {
    title: 'Content needs sideways scrolling on narrow screens',
    description: 'At 320 pixels wide (a phone, or a desktop zoomed to 400%), this element is wider than the screen and the page scrolls sideways.',
    whyItMatters: 'People who zoom in to read have to scroll back and forth along every line, which is slow and easy to get lost in.',
    recommendation: 'Let the element shrink and wrap: use max-width: 100% for images and media, and avoid fixed pixel widths on containers.',
    effort: 'Medium',
  },
  'zoom-text-clipped': {
    title: 'Text is cut off when zoomed',
    description: 'At 200% zoom, text in this element no longer fits and part of it is hidden.',
    whyItMatters: 'People with low vision who zoom the page lose part of the content without knowing it is there.',
    recommendation: 'Avoid fixed heights and overflow: hidden on boxes that contain text; let them grow with their content.',
    effort: 'Small',
  },
  'text-spacing': {
    title: 'Text is cut off with wider text spacing',
    description: 'When line, letter and word spacing are increased (as many readers with dyslexia do), text in this element is cut off.',
    whyItMatters: 'People who adjust text spacing to read more easily lose part of the content.',
    recommendation: 'Don’t fix the height of elements that contain text, and avoid overflow: hidden on them.',
    effort: 'Small',
  },
  'target-size-touch': {
    title: 'Touch targets are smaller than recommended',
    description: 'On a touchscreen, this control is smaller than 44 by 44 pixels.',
    whyItMatters: 'Small targets are hard to hit for people with limited dexterity, older visitors and anyone using a kiosk standing up.',
    recommendation: 'Make touch targets at least 44 by 44 pixels, using padding if the visible control should stay small.',
    effort: 'Small',
  },
  'skip-link-missing': {
    title: 'No “skip to content” link',
    description: 'Several links and controls come before the main content, and there is no link to skip past them.',
    whyItMatters: 'Keyboard and screen reader users must move through the whole header and navigation on every page before reaching the content.',
    recommendation: 'Add a “Skip to main content” link as the first focusable element, pointing at the main content’s ID. It can stay hidden until focused.',
    effort: 'Small',
  },
  'skip-link-broken': {
    title: 'The skip link goes nowhere',
    description: 'The first link looks like a skip link, but the place it points to doesn’t exist on the page.',
    whyItMatters: 'Keyboard users who use it stay at the top of the page.',
    recommendation: 'Give the main content the ID the skip link points to, and make sure that element can receive focus (tabindex="-1" if needed).',
    effort: 'Small',
  },
  'multiple-h1': {
    title: 'Page has more than one main heading',
    description: 'There is more than one level-one heading on the page.',
    whyItMatters: 'Screen reader users rely on a single main heading to understand what the page is about; several make the structure unclear.',
    recommendation: 'Keep one h1 that describes the page, and use h2 and lower for sections.',
    effort: 'Small',
  },
  'no-landmarks': {
    title: 'Page has no landmarks',
    description: 'The page has no header, navigation, main or footer landmarks.',
    whyItMatters: 'Screen reader users jump between landmarks to find their way around. Without them they have to read the whole page in order.',
    recommendation: 'Use <header>, <nav>, <main> and <footer> elements in the page template.',
    effort: 'Medium',
  },
  'duplicate-title': {
    title: 'Pages share the same title',
    description: 'Several different pages have exactly the same page title.',
    whyItMatters: 'Titles are the first thing a screen reader announces and what people see in tabs, history and search results. Identical titles make pages impossible to tell apart.',
    recommendation: 'Give every page a unique title that starts with what is specific to it, e.g. “Paintings | Our collection | Museum of Making”.',
    effort: 'Small',
  },
  'colour-near-duplicates': {
    title: 'Colours that are almost, but not quite, the same',
    description: 'Several colours are so close together that they look identical, which suggests they were picked by eye rather than from a palette.',
    whyItMatters: 'Near-duplicate colours make the interface look slightly inconsistent and make it harder to keep contrast and branding right when the design changes.',
    recommendation: 'Pick one value from the design system’s palette and use it everywhere, ideally through a shared CSS variable.',
    effort: 'Small',
  },
  'too-many-greys': {
    title: 'Too many shades of grey',
    description: 'The site uses more distinct greys than a typical design system needs.',
    whyItMatters: 'A sprawling grey palette is a sign styles have drifted. It makes text and borders look inconsistent and contrast hard to manage.',
    recommendation: 'Reduce greys to a small, named set (for example text, muted text, border, background) and replace the rest.',
    effort: 'Medium',
  },
  'too-many-fonts': {
    title: 'Too many typefaces',
    description: 'Text on the site is set in more typefaces than a consistent design usually uses.',
    whyItMatters: 'Mixing many typefaces looks unpolished and slows pages down with extra font files.',
    recommendation: 'Limit the site to its brand typefaces (usually one or two) and remove the others from the CSS.',
    effort: 'Small',
  },
  'font-size-near-duplicates': {
    title: 'Text sizes that are almost the same',
    description: 'Text sizes a pixel or less apart are in use, which usually means sizes were set one by one instead of from a type scale.',
    whyItMatters: 'Sizes that are nearly equal look like mistakes and make the hierarchy of headings and body text less clear.',
    recommendation: 'Use a defined type scale and replace the odd sizes with the nearest step.',
    effort: 'Small',
  },
  'too-many-font-sizes': {
    title: 'Too many text sizes',
    description: 'The site uses more distinct text sizes than a type scale normally has.',
    whyItMatters: 'Too many sizes blur the difference between headings, body text and captions.',
    recommendation: 'Define a type scale of six to eight sizes and map every style onto it.',
    effort: 'Medium',
  },
  'line-height-near-duplicates': {
    title: 'Line heights that differ by a hair',
    description: 'Line heights only fractionally different from each other are in use.',
    whyItMatters: 'Small, unintended differences make blocks of text look uneven next to each other.',
    recommendation: 'Use a small set of line heights from the design system (for example 1.2 for headings and 1.5 for body text).',
    effort: 'Small',
  },
  'spacing-near-duplicates': {
    title: 'Spacing values a pixel apart',
    description: 'Margins or padding a pixel apart (such as 15px and 16px) are in use.',
    whyItMatters: 'Off-by-one spacing makes layouts look subtly misaligned and is a sign spacing isn’t coming from a shared scale.',
    recommendation: 'Use a spacing scale (for example multiples of 4px) and replace odd values with the nearest step.',
    effort: 'Small',
  },
  'canvas-content': {
    title: 'Content drawn in a canvas needs manual review',
    description: 'A large part of the screen is drawn inside a <canvas> element (2D or WebGL). Automated accessibility checks cannot see anything drawn there.',
    whyItMatters: 'Screen reader users get nothing from canvas content unless it is described another way, and keyboard users may not be able to operate controls drawn in it. Automated checks can’t tell either way, so this needs a person to test it.',
    recommendation: 'Test the canvas by hand with a screen reader and a keyboard. Give it an accessible name, provide the same information and controls as real HTML (alongside or as fallback content), and make sure it respects reduced motion.',
    effort: 'Medium',
  },
  'journey-step-failed': {
    title: 'Journey could not be completed',
    description: 'A step of a recorded journey could not be replayed: the element it uses was missing, hidden or didn’t respond.',
    whyItMatters: 'If an automated replay can’t get through the journey, visitors may not be able to either. It can also mean the journey recording is out of date.',
    recommendation: 'Try the journey by hand. If it works, record it again; if it doesn’t, fix the step that fails.',
    effort: 'Medium',
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
