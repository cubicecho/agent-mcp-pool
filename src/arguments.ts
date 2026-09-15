/**
 * Arguments as a model wrote them, brought into line with the schema the server published.
 *
 * Local models get argument *types* wrong far more often than they get names wrong: `"5"` for a
 * number, `"true"` for a boolean, an object serialised into a string, `""` or `null` for a
 * parameter they meant to leave out. A server with a strict validator refuses each of those, and
 * the model reads a stack trace where a type hint would have done. So the pool repairs what is
 * unambiguous and names what is not, in words a model can act on.
 *
 * Deliberately small and dependency-free: no `$ref`, no `anyOf`, no formats. A schema construct
 * this does not read is left to the server, which validates it anyway. Only what the schema
 * states plainly (`type`, `properties`, `items`, `required`, a primitive `enum`) is touched.
 */

/** What `coerceArguments` returns. */
export interface CoercedArguments {
  /** The arguments to send: a new object, with the input left as it was. */
  args: Record<string, unknown>;
  /** One sentence per problem that coercion could not repair. Empty when the call can go. */
  problems: string[];
}

type Schema = Record<string, unknown>;

const isPlainObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const isSchema = (value: unknown): value is Schema => isPlainObject(value);

/** The longest a quoted value gets inside a problem, so a pasted file does not become the hint. */
const PREVIEW_CHARS = 40;

/** A value as a problem quotes it: JSON, cut short. */
function preview(value: unknown): string {
  if (value === undefined) return "nothing";
  const text = JSON.stringify(value) ?? String(value);
  return text.length > PREVIEW_CHARS ? `${text.slice(0, PREVIEW_CHARS - 1)}…` : text;
}

/** JSON, or `undefined` where the string is not JSON. */
function parseJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

/** The types a schema node declares, or none where it says nothing this pass can read. */
function typesOf(schema: Schema): string[] {
  if (typeof schema.type === "string") return [schema.type];
  if (Array.isArray(schema.type)) return schema.type.filter((t) => typeof t === "string");
  // A node with `properties` and no `type` is an object in every schema a server actually sends.
  if (isSchema(schema.properties)) return ["object"];
  return [];
}

function matches(value: unknown, type: string): boolean {
  switch (type) {
    case "string":
      return typeof value === "string";
    case "number":
      return typeof value === "number" && Number.isFinite(value);
    case "integer":
      return typeof value === "number" && Number.isInteger(value);
    case "boolean":
      return typeof value === "boolean";
    case "null":
      return value === null;
    case "array":
      return Array.isArray(value);
    case "object":
      return isPlainObject(value);
    default:
      // A type this pass does not know is not a type it can say the value fails.
      return true;
  }
}

/** `value` as `type`, where one reading is unambiguous; `undefined` where none is. */
function convert(value: unknown, type: string): { value: unknown } | undefined {
  if (typeof value === "string") {
    const text = value.trim();
    switch (type) {
      case "integer":
        return /^-?\d+$/.test(text) ? { value: Number(text) } : undefined;
      case "number":
        return text !== "" && Number.isFinite(Number(text)) ? { value: Number(text) } : undefined;
      case "boolean":
        if (/^true$/i.test(text)) return { value: true };
        if (/^false$/i.test(text)) return { value: false };
        return undefined;
      case "null":
        return text === "null" ? { value: null } : undefined;
      case "array": {
        const parsed = parseJson(text);
        return Array.isArray(parsed) ? { value: parsed } : undefined;
      }
      case "object": {
        const parsed = parseJson(text);
        return isPlainObject(parsed) ? { value: parsed } : undefined;
      }
      default:
        return undefined;
    }
  }
  if (type === "string" && (typeof value === "number" || typeof value === "boolean")) {
    return { value: String(value) };
  }
  return undefined;
}

/** How a path is written in a problem: `limit`, `filter.tags[2]`, or `arguments` at the root. */
const named = (path: string) => `\`${path || "arguments"}\``;

function walk(value: unknown, schema: unknown, path: string, problems: string[]): unknown {
  if (!isSchema(schema)) return value;
  const types = typesOf(schema);
  let current = value;
  if (types.length > 0 && !types.some((type) => matches(current, type))) {
    const converted = types.map((type) => convert(current, type)).find(Boolean);
    if (!converted) {
      problems.push(`${named(path)} must be ${article(types)}, got ${preview(current)}`);
      return current;
    }
    current = converted.value;
  }

  if (
    Array.isArray(schema.enum) &&
    schema.enum.every((option) => option === null || typeof option !== "object")
  ) {
    if (!schema.enum.includes(current as never)) {
      const options = schema.enum.map((option) => JSON.stringify(option)).join(", ");
      problems.push(`${named(path)} must be one of ${options}, got ${preview(current)}`);
    }
  }

  if (Array.isArray(current) && isSchema(schema.items)) {
    const items = schema.items;
    return current.map((item, index) => walk(item, items, `${path}[${index}]`, problems));
  }

  if (isPlainObject(current)) {
    const properties = isSchema(schema.properties) ? schema.properties : {};
    const required = new Set(
      Array.isArray(schema.required)
        ? schema.required.filter((key) => typeof key === "string")
        : [],
    );
    const out: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(current)) {
      const property = properties[key];
      const childPath = path ? `${path}.${key}` : key;
      // `""` and `null` for an optional parameter that can be neither is how a model says it is
      // leaving the parameter out. Sending them makes a strict server refuse a call it would have
      // run with the key absent.
      if (!required.has(key) && isSchema(property) && (item === "" || item === null)) {
        const propertyTypes = typesOf(property);
        const accepts = item === "" ? "string" : "null";
        if (propertyTypes.length > 0 && !propertyTypes.includes(accepts)) continue;
      }
      out[key] = walk(item, property, childPath, problems);
    }
    for (const key of required) {
      if (out[key] === undefined)
        problems.push(`missing required ${named(path ? `${path}.${key}` : key)}`);
    }
    return out;
  }

  return current;
}

/** `a number`, `an integer`, `a string or null`. */
function article(types: string[]): string {
  const first = types[0] ?? "";
  const lead = first === "null" ? "" : /^[aeiou]/.test(first) ? "an " : "a ";
  return `${lead}${types.join(" or ")}`;
}

/**
 * Repairs a model's arguments against a tool's input schema, and says what it could not repair.
 *
 * What is repaired, only where the schema declares the type: a string input parsed as a JSON
 * object; `"5"` to a number or integer, `"true"`/`"false"` to a boolean, `"null"` to null, a JSON
 * string to an array or object, and a number or boolean to a string; and `""` or `null` for an
 * optional property that can be neither, which is dropped as though the model had left it out.
 * Nothing is ever added, and a property the schema does not name passes through untouched.
 *
 * What is reported: a value that still has the wrong type, a value outside a primitive `enum`,
 * and a missing `required` property, at any depth `properties` and `items` reach.
 *
 * @param input The arguments as the model sent them. Null or undefined is `{}`.
 * @param schema The tool's `inputSchema`, as the server published it.
 * @returns The arguments to send and the problems left, each a short sentence naming the path.
 */
export function coerceArguments(input: unknown, schema: Record<string, unknown>): CoercedArguments {
  let value = input ?? {};
  if (typeof value === "string") {
    const text = value.trim();
    const parsed = text === "" ? {} : parseJson(text);
    if (!isPlainObject(parsed)) {
      return { args: {}, problems: [`arguments must be a JSON object, got ${preview(value)}`] };
    }
    value = parsed;
  }
  if (!isPlainObject(value)) {
    return { args: {}, problems: [`arguments must be an object, got ${preview(value)}`] };
  }
  const problems: string[] = [];
  // The root is an object whatever the schema says: MCP sends `arguments` as one.
  const args = walk(value, { ...schema, type: "object" }, "", problems) as Record<string, unknown>;
  return { args, problems };
}
