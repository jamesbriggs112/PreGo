import type { Category } from '../types.js';
import { checkDefinitions } from './registry.js';

/** Modules added by discovery rather than chosen (they aren't in the registry). */
const DISCOVERY_MODULES: Record<string, Category[]> = { 'state-map': ['UX'], journey: ['UX'] };

/** Categories each check module covers, so summaries can say "Not checked" rather than a perfect score. */
export function moduleCategories(id: string): Category[] {
  return checkDefinitions().find((d) => d.id === id)?.categories ?? DISCOVERY_MODULES[id] ?? [];
}

/** Categories covered by the modules a run used (from its stored settings). */
export function checkedCategories(settings: Record<string, unknown>): Set<Category> {
  const modules = (settings.modules as { id: string }[] | undefined) ?? [];
  return new Set(modules.flatMap((m) => moduleCategories(m.id)));
}
