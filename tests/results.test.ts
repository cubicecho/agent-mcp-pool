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
