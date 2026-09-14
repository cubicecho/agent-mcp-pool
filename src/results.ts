/**
 * What this reads off one content block. Structural rather than the SDK's union: three of MCP's
 * block types carry text, and each of them keeps it somewhere else.
 */
interface ContentBlock {
  type?: string;
  /** An `image` or `audio` block's base64 payload, and what it is. */
  data?: string;
  mimeType?: string;
  /** A `text` block's own text. */
  text?: string;
  /** A `resource_link`'s target, and what names it. */
  uri?: string;
  name?: string;
  description?: string;
  /** An embedded `resource`, text or blob — only the text arm has a `text`. */
  resource?: { text?: string; uri?: string; blob?: string; mimeType?: string };
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
 * @returns The blocks' text joined by newlines, trimmed; what has none appears as a placeholder
 *   naming its type, mime type and size, `[image image/png, 42 KB omitted]`. A server that
 *   answered with structured output and no content at all — what a server with an `outputSchema`
 *   tends to do — gets that structure as JSON rather than nothing. Where the text blocks are only
 *   that structure pretty-printed, the compact JSON is returned instead, when it is shorter.
 */
export function resultText(result: {
  content?: unknown;
  structuredContent?: unknown;
  [key: string]: unknown;
}): string {
  const content = Array.isArray(result.content) ? result.content : [];
  const text = content.map(blockText).join("\n").trim();
  const { structuredContent } = result;
  const structured =
    structuredContent === undefined || structuredContent === null
      ? ""
      : (JSON.stringify(structuredContent) ?? "");
  // Structured output is an answer the server did send, and `call()` turns an empty string into
  // "(no output)" — which is the same loss as a dropped block, one layer up.
  if (text === "") return structured;
  // The spec asks a server with structured output to mirror it in a text block, and most do it
  // with `JSON.stringify(value, null, 2)`: the same answer, in indentation a small window pays for.
  if (structured !== "" && structured.length < text.length && mirrors(text, structured)) {
    return structured;
  }
  return text;
}

/** Whether `text` is `structured` re-serialised, and so says nothing the compact form does not. */
function mirrors(text: string, structured: string): boolean {
  try {
    return JSON.stringify(JSON.parse(text)) === structured;
  } catch {
    return false;
  }
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
      return binaryText(block.type ?? "unknown", block.mimeType, block.data);
  }
}

/**
 * A placeholder for what has no text: the type, and the mime type and size where the block says.
 *
 * `[image content]` told a text-only model it got something and nothing about what. The mime
 * type and size are what let it say "a 2 MB PNG" rather than guess, and cost a few tokens.
 */
function binaryText(type: string, mimeType: string | undefined, base64: string | undefined) {
  const parts = [
    mimeType,
    typeof base64 === "string" ? `${formatBytes(base64Bytes(base64))} omitted` : "",
  ].filter((part) => part);
  return parts.length > 0 ? `[${type} ${parts.join(", ")}]` : `[${type} content]`;
}

/** The decoded size of a base64 string, without decoding it. */
function base64Bytes(base64: string): number {
  const length = base64.replace(/\s/g, "").length;
  const padding = base64.endsWith("==") ? 2 : base64.endsWith("=") ? 1 : 0;
  return Math.max(0, Math.floor((length * 3) / 4) - padding);
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} ${bytes === 1 ? "byte" : "bytes"}`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
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
  if (typeof resource?.blob === "string") {
    return binaryText(
      resource.uri ? `resource ${resource.uri}` : "resource",
      resource.mimeType,
      resource.blob,
    );
  }
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

/**
 * Text cut to fit a character budget, keeping its head and its tail.
 *
 * One tool result can be larger than a local model's whole context window, and a server that
 * returns a 200 KB file does not know the reader has 8K tokens. The head is where most answers
 * start and the tail is where a log ends or an error is reported, so both are kept: two thirds
 * of the budget from the start, a third from the end, and a marker between them that says how
 * much is missing, so the model can ask for less rather than conclude it saw everything.
 *
 * @param text What to cut.
 * @param maxChars The budget, marker included. Absent, zero or negative means no cap.
 * @returns `text` unchanged when it fits; otherwise at most `maxChars` characters, never splitting
 *   a surrogate pair, with `[truncated: kept N of M chars]` on its own line between head and tail.
 */
export function truncateText(text: string, maxChars?: number | null): string {
  if (maxChars == null || maxChars <= 0 || text.length <= maxChars) return text;
  const total = text.length;
  // Sized for the widest `kept`, which cannot have more digits than `total`.
  const overhead = `\n[truncated: kept ${total} of ${total} chars]\n`.length;
  const kept = maxChars - overhead;
  // A budget smaller than its own marker has no room to say anything; cut it plainly instead.
  if (kept <= 0) return safeSlice(text, 0, maxChars);
  let headEnd = Math.ceil((kept * 2) / 3);
  let tailStart = total - (kept - headEnd);
  if (isHighSurrogate(text.charCodeAt(headEnd - 1))) headEnd--;
  if (tailStart < total && isLowSurrogate(text.charCodeAt(tailStart))) tailStart++;
  const head = text.slice(0, headEnd);
  const tail = text.slice(tailStart);
  return `${head}\n[truncated: kept ${head.length + tail.length} of ${total} chars]\n${tail}`;
}

const isHighSurrogate = (code: number) => code >= 0xd800 && code <= 0xdbff;
const isLowSurrogate = (code: number) => code >= 0xdc00 && code <= 0xdfff;

/** `text.slice(start, end)` without ending on half a surrogate pair. */
function safeSlice(text: string, start: number, end: number): string {
  return text.slice(start, isHighSurrogate(text.charCodeAt(end - 1)) ? end - 1 : end);
}
