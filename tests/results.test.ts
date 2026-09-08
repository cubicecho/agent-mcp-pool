import { expect, test } from "vitest";
import { resultText } from "../src/results.ts";

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

test("a non-text block is named rather than dropped", () => {
  // A model handed nothing would conclude the call failed; told it got an image, it can say so.
  expect(resultText({ content: [{ type: "image", data: "aGk=", mimeType: "image/png" }] })).toBe(
    "[image content]",
  );
  expect(resultText({ content: [{ type: "resource", resource: {} }] })).toBe("[resource content]");
  expect(resultText({ content: [{ type: "audio", data: "aGk=" }] })).toBe("[audio content]");
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
  ).toBe("[resource file:///chart.png content]");
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

test("a block with no type at all is still accounted for", () => {
  expect(resultText({ content: [{}] })).toBe("[unknown content]");
});

test("text and non-text keep their places relative to each other", () => {
  const content = [
    { type: "text", text: "here is the chart:" },
    { type: "image", data: "aGk=", mimeType: "image/png" },
    { type: "text", text: "and its caption" },
  ];
  expect(resultText({ content })).toBe("here is the chart:\n[image content]\nand its caption");
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
