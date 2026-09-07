/**
 * What went wrong, as a string.
 *
 * A `catch` binds `unknown` and every status here is a string, so this ternary was otherwise
 * repeated at each site. Copied from `@cubicecho/agent-core` rather than imported: it is one
 * expression, and depending on the framework for it would make this package need it.
 */
export const errorMessage = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);
