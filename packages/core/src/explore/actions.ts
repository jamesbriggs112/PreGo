import type { Page } from 'playwright';

export type ActionKind = 'click' | 'fill' | 'select';

/** Something a user can interact with on the current screen. */
export interface Action {
  /**
   * Stable identity within a screen: role, label and position among same-labelled actions, e.g.
   * `button|Zoom in|0`. Used to replay paths, so it mustn't depend on DOM details that change between
   * visits.
   */
  key: string;
  kind: ActionKind;
  role: string;
  /** Accessible-ish name: what a user would call it. */
  label: string;
  /** Unique CSS selector on the screen as it is now. */
  selector: string;
  tag: string;
  /** For links: the resolved address. */
  href?: string;
  /** Input type for form fields (text, email, checkbox...). */
  inputType?: string;
  box: { x: number; y: number; width: number; height: number };
}

/**
 * List every interactive element on the screen: links, buttons, form fields, elements with ARIA
 * widget roles, focusable elements, elements with click handlers set as properties or attributes,
 * and elements that show a pointer cursor (which catches most JavaScript-driven controls, since
 * listeners added with addEventListener can't be seen from the page).
 */
export async function discoverActions(page: Page): Promise<Action[]> {
  const raw = await page.evaluate(() => {
    const WIDGET_ROLES = ['button', 'link', 'menuitem', 'menuitemcheckbox', 'menuitemradio', 'tab', 'checkbox', 'radio', 'switch', 'option', 'treeitem', 'combobox', 'textbox', 'slider', 'spinbutton', 'searchbox'];
    const NATIVE = 'a[href], button, input:not([type="hidden"]), select, textarea, summary, [contenteditable="true"]';
    const ARIA = WIDGET_ROLES.map((r) => `[role="${r}"]`).join(',');
    const MAX_ELEMENTS = 5000;

    const isVisible = (el: Element) => {
      const rect = el.getBoundingClientRect();
      if (rect.width < 1 || rect.height < 1) return false;
      const style = getComputedStyle(el);
      if (style.visibility === 'hidden' || style.display === 'none' || Number(style.opacity) === 0) return false;
      return !el.closest('[inert], [aria-hidden="true"]');
    };
    const isDisabled = (el: Element) => (el as HTMLButtonElement).disabled === true || el.getAttribute('aria-disabled') === 'true';

    const candidates = new Set<Element>([...document.querySelectorAll(NATIVE), ...document.querySelectorAll(ARIA)]);
    for (const el of document.querySelectorAll('[onclick], [tabindex]')) {
      if (el.getAttribute('tabindex') !== '-1') candidates.add(el);
    }
    // Click handlers set as properties, and pointer cursors (only where the cursor starts, not on
    // every child that inherits it).
    const all = document.body ? [...document.body.querySelectorAll('*')].slice(0, MAX_ELEMENTS) : [];
    for (const el of all) {
      if (typeof (el as HTMLElement).onclick === 'function') candidates.add(el);
      else if (getComputedStyle(el).cursor === 'pointer' && (!el.parentElement || getComputedStyle(el.parentElement).cursor !== 'pointer')) candidates.add(el);
    }

    const nativeSet = new Set(document.querySelectorAll(NATIVE));
    const list = [...candidates].filter((el) => isVisible(el) && !isDisabled(el));
    // Drop elements nested inside another action (e.g. a <span> inside a <button>) unless they're
    // native controls in their own right.
    const kept = list.filter((el) => nativeSet.has(el) || !list.some((other) => other !== el && other.contains(el)));
    // Document order, so numbering of same-labelled actions is stable.
    kept.sort((a, b) => (a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING ? -1 : 1));

    const text = (s: string | null | undefined) => (s ?? '').replace(/\s+/g, ' ').trim();
    const labelOf = (el: Element): string => {
      const aria = el.getAttribute('aria-label');
      if (aria) return text(aria);
      const labelledBy = el.getAttribute('aria-labelledby');
      if (labelledBy) {
        const t = labelledBy.split(/\s+/).map((id) => document.getElementById(id)?.textContent).join(' ');
        if (text(t)) return text(t);
      }
      const labels = (el as HTMLInputElement).labels;
      if (labels?.length) return text([...labels].map((l) => l.textContent).join(' '));
      const inner = text((el as HTMLElement).innerText);
      if (inner) return inner.slice(0, 80);
      const img = el.querySelector('img[alt]');
      if (img) return text(img.getAttribute('alt'));
      return text(el.getAttribute('title') || (el as HTMLInputElement).value || el.getAttribute('placeholder') || el.getAttribute('name')) || el.tagName.toLowerCase();
    };
    const roleOf = (el: Element): string => {
      const explicit = el.getAttribute('role');
      if (explicit) return explicit;
      const tag = el.tagName.toLowerCase();
      if (tag === 'a') return 'link';
      if (tag === 'button' || tag === 'summary') return 'button';
      if (tag === 'select') return 'combobox';
      if (tag === 'textarea') return 'textbox';
      if (tag === 'input') {
        const type = (el as HTMLInputElement).type;
        if (['checkbox', 'radio'].includes(type)) return type;
        if (['button', 'submit', 'reset', 'image'].includes(type)) return 'button';
        if (type === 'range') return 'slider';
        return 'textbox';
      }
      return 'generic';
    };
    const kindOf = (el: Element, role: string): 'click' | 'fill' | 'select' => {
      if (el.tagName === 'SELECT') return 'select';
      if (role === 'textbox' || role === 'searchbox' || role === 'spinbutton' || el.getAttribute('contenteditable') === 'true') return 'fill';
      return 'click';
    };
    const cssPath = (el: Element): string => {
      if (el.id && document.querySelectorAll(`#${CSS.escape(el.id)}`).length === 1) return `#${CSS.escape(el.id)}`;
      const testId = el.getAttribute('data-testid');
      if (testId && document.querySelectorAll(`[data-testid="${CSS.escape(testId)}"]`).length === 1) return `[data-testid="${CSS.escape(testId)}"]`;
      const parts: string[] = [];
      let node: Element | null = el;
      while (node && node !== document.documentElement) {
        if (node.id && document.querySelectorAll(`#${CSS.escape(node.id)}`).length === 1) {
          parts.unshift(`#${CSS.escape(node.id)}`);
          break;
        }
        const tag = node.tagName.toLowerCase();
        const siblings = node.parentElement ? [...node.parentElement.children].filter((c) => c.tagName === node!.tagName) : [];
        parts.unshift(siblings.length > 1 ? `${tag}:nth-of-type(${siblings.indexOf(node) + 1})` : tag);
        node = node.parentElement;
      }
      return parts.join(' > ');
    };

    return kept.map((el) => {
      const role = roleOf(el);
      const rect = el.getBoundingClientRect();
      return {
        role,
        label: labelOf(el),
        selector: cssPath(el),
        tag: el.tagName.toLowerCase(),
        kind: kindOf(el, role),
        href: el instanceof HTMLAnchorElement && el.href ? el.href : undefined,
        inputType: el instanceof HTMLInputElement ? el.type : undefined,
        box: { x: Math.round(rect.x + scrollX), y: Math.round(rect.y + scrollY), width: Math.round(rect.width), height: Math.round(rect.height) },
      };
    });
  });

  // Number same-role, same-label actions in document order so keys stay unique and stable.
  const seen = new Map<string, number>();
  return raw.map((a) => {
    const base = `${a.role}|${a.label}`;
    const n = seen.get(base) ?? 0;
    seen.set(base, n + 1);
    return { ...a, key: `${base}|${n}` };
  });
}
