/**
 * What a tool call is worth as a tool message.
 *
 * MCP answers with a list of content blocks; an agent loop has one string to put in a message
 * array. Everything that is not text is named rather than dropped, so a model that asked for a
 * screenshot is told it got one instead of being handed an empty result and left to conclude the
 * call failed. A consumer that wants the blocks themselves goes through `client()`.
 *
 * @param result A `tools/call` result. Only `content` is read, and a missing one is not an error.
 * @returns The text blocks joined by newlines, trimmed; non-text blocks appear as `[image content]`.
 */
export function resultText(result: { content?: unknown; [key: string]: unknown }): string {
  const content = Array.isArray(result.content) ? result.content : [];
  return content
    .map((block: { type?: string; text?: string }) =>
      block.type === "text" ? (block.text ?? "") : `[${block.type ?? "unknown"} content]`,
    )
    .join("\n")
    .trim();
}
