import { expect, test } from "vitest";
import { resultText, truncateText } from "../src/results.ts";

/**
 * The flattening every tool result goes through on its way into a message array. Exercising these
 * shapes used to mean writing a server that returns them; most of them no fixture ever did.
 */
test("text blocks are joined in order", () => {
  expect(
    resultText({
      content: [
        { type: "text", text: "one" },
        { type: "text", text: "two" },
      ],
    }),
  ).toBe("one\ntwo");
});

test("a non-text block is named rather than dropped, with what it is and how big", () => {
  // A model handed nothing would conclude the call failed; told it got an image, it can say so.
  expect(resultText({ content: [{ type: "image", data: "aGk=", mimeType: "image/png" }] })).toBe(
    "[image image/png, 2 bytes omitted]",
  );
  expect(resultText({ content: [{ type: "resource", resource: {} }] })).toBe("[resource content]");
  expect(resultText({ content: [{ type: "audio", data: "aGk=" }] })).toBe(
    "[audio 2 bytes omitted]",
  );
  expect(resultText({ content: [{ type: "image" }] })).toBe("[image content]");
  expect(
    resultText({
      content: [{ type: "image", data: "A".repeat(4 * 1024 * 50), mimeType: "image/jpeg" }],
    }),
  ).toBe("[image image/jpeg, 150 KB omitted]");
  expect(
    resultText({
      content: [{ type: "audio", data: "A".repeat(4 * 1024 * 1024), mimeType: "audio/wav" }],
    }),
  ).toBe("[audio audio/wav, 3.0 MB omitted]");
  expect(resultText({ content: [{ type: "image", data: "YQ==" }] })).toBe("[image 1 byte omitted]");
});

/**
 * Naming a block is right for a screenshot and wrong for a file: an embedded text resource is an
 * answer the server did send, and `[resource content]` threw it away somewhere the model could
 * not ask for it again.
 */
test("an embedded text resource arrives as its text", () => {
  expect(
    resultText({
      content: [
        {
          type: "resource",
          resource: { uri: "file:///notes.md", mimeType: "text/markdown", text: "# notes" },
        },
      ],
    }),
  ).toBe("# notes");
});

test("an embedded blob keeps its uri in the placeholder", () => {
  // Nothing to unwrap, but the uri is what a follow-up call needs.
  expect(
    resultText({
      content: [{ type: "resource", resource: { uri: "file:///chart.png", blob: "aGk=" } }],
    }),
  ).toBe("[resource file:///chart.png 2 bytes omitted]");
  expect(
    resultText({
      content: [
        {
          type: "resource",
          resource: { uri: "file:///chart.png", blob: "aGk=", mimeType: "image/png" },
        },
      ],
    }),
  ).toBe("[resource file:///chart.png image/png, 2 bytes omitted]");
});

test("a resource link keeps the uri that makes it followable", () => {
  expect(resultText({ content: [{ type: "resource_link", uri: "file:///notes.md" }] })).toBe(
    "[resource_link file:///notes.md]",
  );
  expect(
    resultText({
      content: [
        {
          type: "resource_link",
          uri: "file:///notes.md",
          name: "notes",
          description: "the meeting notes",
        },
      ],
    }),
  ).toBe("[resource_link file:///notes.md — notes: the meeting notes]");
  // A link with nothing to follow is still accounted for rather than reported as an empty result.
  expect(resultText({ content: [{ type: "resource_link", name: "notes" }] })).toBe(
    "[resource_link content]",
  );
});

/**
 * A server with an `outputSchema` is allowed to answer with structure and no content at all, and
 * `call()` turns an empty string into "(no output)" — an answer the server did send, reported as
 * one it did not.
 */
test("structured output is read when the blocks come to nothing", () => {
  expect(resultText({ content: [], structuredContent: { rows: 2, ok: true } })).toBe(
    '{"rows":2,"ok":true}',
  );
  expect(resultText({ structuredContent: { rows: 2 } })).toBe('{"rows":2}');
  // Text wins where there is any: the blocks are what the server wrote for a reader.
  expect(
    resultText({ content: [{ type: "text", text: "two rows" }], structuredContent: { rows: 2 } }),
  ).toBe("two rows");
  expect(resultText({ content: [], structuredContent: null })).toBe("");
});

test("text that only mirrors the structured output is sent compact", () => {
  const structuredContent = { rows: [1, 2], ok: true };
  const pretty = JSON.stringify(structuredContent, null, 2);
  expect(resultText({ content: [{ type: "text", text: pretty }], structuredContent })).toBe(
    '{"rows":[1,2],"ok":true}',
  );
  // Different text is the server's own words for a reader, and wins.
  expect(
    resultText({ content: [{ type: "text", text: '{"rows": [1]}' }], structuredContent }),
  ).toBe('{"rows": [1]}');
});

test("truncateText keeps head and tail within the budget", () => {
  const text = `${"a".repeat(600)}${"z".repeat(400)}`;
  const cut = truncateText(text, 200);
  expect(cut.length).toBeLessThanOrEqual(200);
  expect(cut.startsWith("aaaa")).toBe(true);
  expect(cut.endsWith("zzzz")).toBe(true);
  const [head = "", marker = "", tail = ""] = cut.split("\n");
  const kept = Number(marker.match(/^\[truncated: kept (\d+) of 1000 chars\]$/)?.[1]);
  expect(head.length + tail.length).toBe(kept);
  // Two thirds of what is kept from the start.
  expect(head.length).toBe(Math.ceil((kept * 2) / 3));

  expect(truncateText("short", 200)).toBe("short");
  expect(truncateText(text, undefined)).toBe(text);
  expect(truncateText(text, 0)).toBe(text);
  expect(truncateText(text, null)).toBe(text);
  // Smaller than its own marker: cut plainly.
  expect(truncateText(text, 10)).toBe("aaaaaaaaaa");
});

test("truncateText never splits a surrogate pair", () => {
  const text = "😀".repeat(500);
  for (const max of [60, 61, 62, 63, 99, 100]) {
    const cut = truncateText(text, max);
    expect(cut.length).toBeLessThanOrEqual(max);
    expect(cut).not.toMatch(
      /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/,
    );
  }
});

test("a block with no type at all is still accounted for", () => {
  expect(resultText({ content: [{}] })).toBe("[unknown content]");
});

test("text and non-text keep their places relative to each other", () => {
  const content = [
    { type: "text", text: "here is the chart:" },
    { type: "image", data: "aGk=", mimeType: "image/png" },
    { type: "text", text: "and its caption" },
  ];
  expect(resultText({ content })).toBe(
    "here is the chart:\n[image image/png, 2 bytes omitted]\nand its caption",
  );
});

test("a text block with no text contributes an empty line rather than the word undefined", () => {
  expect(resultText({ content: [{ type: "text" }, { type: "text", text: "after" }] })).toBe(
    "after",
  );
});

/** The compatibility arm of the SDK's return type has no `content` at all. */
test("a result with no content is empty rather than a crash", () => {
  expect(resultText({})).toBe("");
  expect(resultText({ content: undefined })).toBe("");
  expect(resultText({ toolResult: "legacy" })).toBe("");
  // Not an array, so nothing to walk — a server sending something else gets the same answer.
  expect(resultText({ content: "just a string" })).toBe("");
});

test("surrounding whitespace is trimmed, so an empty result reads as empty", () => {
  expect(resultText({ content: [{ type: "text", text: "  padded  " }] })).toBe("padded");
  expect(resultText({ content: [{ type: "text", text: "   " }] })).toBe("");
});
