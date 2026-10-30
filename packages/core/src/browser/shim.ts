/**
 * When Prego runs under tsx (dev mode), esbuild wraps named functions in a `__name()` helper. Functions
 * passed to `page.evaluate` are serialised into the browser, where that helper doesn't exist. This init
 * script defines a no-op version in every page. It's harmless in compiled builds.
 */
export const EVALUATE_SHIM = 'globalThis.__name ??= (fn) => fn;';
