import type { Category } from '../types.js';

/** Categories each check module covers, so summaries can say "Not checked" rather than a perfect score. */
export const MODULE_CATEGORIES: Record<string, Category[]> = { axe: ['A11Y'], 'state-map': ['UX'], journey: ['UX'] };

/** Categories covered by the modules a run used (from its stored settings). */
export function checkedCategories(settings: Record<string, unknown>): Set<Category> {
  const modules = (settings.modules as { id: string }[] | undefined) ?? [];
  return new Set(modules.flatMap((m) => MODULE_CATEGORIES[m.id] ?? []));
}
