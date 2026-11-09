// What a site is for and who it's for. Every site has purposes; personas and their tasks are tied to
// them, so later reports can weigh findings by what matters to the site. Kept per project: Prego
// suggests a starting point from an audit, and the auditor edits it or adds their own from the brief.

/** What a visitor can do on a page, recorded by the structure check. Counts and kinds only. */
export interface PageSignals {
  /** `tel:` links. */
  tel: number;
  /** `mailto:` links. */
  mailto: number;
  /** A phone number written in the page text. */
  phoneText: boolean;
  forms: ('contact' | 'search' | 'login' | 'newsletter' | 'other')[];
  /** The page's h1 and h2 headings, first few. */
  headings: string[];
  /** Links to other pages on the same site, outside the main navigation too (footers, sidebars). */
  links: { label: string; path: string }[];
}

export interface Purpose {
  id: string;
  title: string;
  description: string;
  /** The site visibly does this now (Prego found evidence, or the auditor says so). */
  current: boolean;
  /** The client wants the site to do this (from the brief). */
  intended: boolean;
  priority: 'primary' | 'secondary';
  /** What Prego saw that suggests it: navigation labels, pages, forms. */
  evidence: string[];
}

export type PersonaDevice = 'mobile' | 'desktop' | 'tablet' | 'any';

export interface Persona {
  id: string;
  name: string;
  /** Who they are and what they want, in a sentence or two. */
  summary: string;
  /** Their situation: where they are, how much time they have, what's around them. */
  context: string;
  device: PersonaDevice;
  /** Assistive technology or other access needs, if any. */
  accessNeeds: string;
  /** Staff or other people inside the organisation. */
  internal: boolean;
  purposeIds: string[];
}

/** How to tell a task is done: reaching a page, or finding contact details or a kind of form. */
export type TaskSuccess = { kind: 'page'; path: string } | { kind: 'contact' } | { kind: 'form'; form: PageSignals['forms'][number] } | { kind: 'described' };

export interface UserTask {
  id: string;
  personaId: string;
  /** What they're trying to do, in their words: "Find the phone number for the planning team". */
  goal: string;
  /** How a person would know they'd done it. */
  doneWhen: string;
  success: TaskSuccess;
}

export interface AudienceProfile {
  purposes: Purpose[];
  personas: Persona[];
  tasks: UserTask[];
  updatedAt: string;
}

/** A suggestion for a project, from an audit. */
export interface AudienceSuggestion {
  profile: AudienceProfile;
  /** `ai` when the local Ollama model wrote it, `reader` for Prego's built-in rules. */
  source: 'ai' | 'reader';
  /** Why the AI suggestion wasn't used, if it wasn't. */
  note?: string;
}
