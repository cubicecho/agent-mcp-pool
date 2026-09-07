/**
 * What went wrong, as a string.
 *
 * A `catch` binds `unknown`, and every status this package reports is a string, so the same
 * three-branch ternary was otherwise written at each site that had to say what happened.
 *
 * Duplicated from `@cubicecho/agent-core` rather than imported: it is one expression, and
 * depending on the whole framework for it would make this package unusable without it.
 */
export const errorMessage = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);
