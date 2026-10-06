/**
 * Questions about a value that arrived untyped — a row out of a form, a model's arguments, a
 * tool's output.
 *
 * Imports nothing, and has to stay that way: both browser entries reach it, so a `node:` module
 * here fails their bundle. Each of these was written out once per module that needed it, and the
 * copies had already drifted in how they spelled the same test.
 */

/** Whether a value is an object with keys — not `null`, and not an array. */
export const isPlainObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/**
 * JSON, or `undefined` where the string is not JSON.
 *
 * `undefined` is not a JSON value, so it can only mean the parse failed.
 */
export function parseJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

/** Whether a value is an integer no smaller than `min`. */
export const wholeNumber = (value: unknown, min: number) =>
  typeof value === "number" && Number.isInteger(value) && value >= min;

/**
 * An object without the keys it holds `undefined` under, for spreading into a result.
 *
 * What a server did not send is absent from what the pool reports, rather than present and
 * `undefined`: the two read differently to `in`, to `Object.keys` and to a deep equality.
 */
export function defined<T extends Record<string, unknown>>(
  fields: T,
): { [K in keyof T]?: Exclude<T[K], undefined> } {
  return Object.fromEntries(Object.entries(fields).filter(([, value]) => value !== undefined)) as {
    [K in keyof T]?: Exclude<T[K], undefined>;
  };
}
