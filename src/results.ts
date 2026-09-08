/**
 * What this reads off one content block. Structural rather than the SDK's union: three of MCP's
 * block types carry text, and each of them keeps it somewhere else.
 */
interface ContentBlock {
  type?: string;
  /** A `text` block's own text. */
  text?: string;
  /** A `resource_link`'s target, and what names it. */
  uri?: string;
  name?: string;
  description?: string;
  /** An embedded `resource`, text or blob — only the text arm has a `text`. */
  resource?: { text?: string; uri?: string };
}

/**
 * What a tool call is worth as a tool message.
 *
 * MCP answers with a list of content blocks; an agent loop has one string to put in a message
 * array. A block that came with text arrives as that text, wherever the block keeps it: a `text`
 * block, an embedded text `resource` — a file the server read, a row it fetched — and a
 * `resource_link`'s uri, which is the one field that lets a model follow the link. What genuinely
 * has no text is named rather than dropped, so a model that asked for a screenshot is told it got
 * one instead of being handed an empty result and left to conclude the call failed. A consumer
 * that wants the blocks themselves goes through `client()`.
 *
 * @param result A `tools/call` result. `content` is read, and `structuredContent` when the blocks
 *   come to nothing; a missing one of either is not an error.
 * @returns The blocks' text joined by newlines, trimmed; what has none appears as
 *   `[image content]`. A server that answered with structured output and no content at all — what
 *   a server with an `outputSchema` tends to do — gets that structure as JSON rather than nothing.
 */
export function resultText(result: {
  content?: unknown;
  structuredContent?: unknown;
  [key: string]: unknown;
}): string {
  const content = Array.isArray(result.content) ? result.content : [];
  const text = content.map(blockText).join("\n").trim();
  if (text !== "") return text;
  // Structured output is an answer the server did send, and `call()` turns an empty string into
  // "(no output)" — which is the same loss as a dropped block, one layer up.
  const { structuredContent } = result;
  if (structuredContent === undefined || structuredContent === null) return "";
  return JSON.stringify(structuredContent) ?? "";
}

/** One block flattened: its own text where it has any, and a name for it where it has none. */
function blockText(block: ContentBlock): string {
  switch (block.type) {
    case "text":
      return block.text ?? "";
    case "resource":
      return embeddedText(block.resource);
    case "resource_link":
      return linkText(block);
    default:
      return `[${block.type ?? "unknown"} content]`;
  }
}

/**
 * An embedded resource: the text arm's text, or the blob arm's uri.
 *
 * A server answering with a file it read returned text, and naming the block instead threw the
 * answer away — the model cannot ask for it again. A blob has nothing to unwrap, so the uri goes
 * in the placeholder: it is what a follow-up call needs.
 */
function embeddedText(resource: ContentBlock["resource"]): string {
  if (typeof resource?.text === "string") return resource.text;
  return resource?.uri ? `[resource ${resource.uri} content]` : "[resource content]";
}

/**
 * A link to a resource the server did not embed: the uri, and whatever the server called it.
 *
 * `[resource_link content]` told a model a link exists and withheld the only field that would let
 * it follow one.
 */
function linkText(block: ContentBlock): string {
  if (!block.uri) return "[resource_link content]";
  const named = [block.name, block.description].filter((part) => part?.trim());
  return named.length > 0
    ? `[resource_link ${block.uri} — ${named.join(": ")}]`
    : `[resource_link ${block.uri}]`;
}
