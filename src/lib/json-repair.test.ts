import { describe, expect, it } from "vitest";
import { safeParseLLMJson } from "./json-repair";

describe("safeParseLLMJson", () => {
  it("parses valid JSON directly", () => {
    const result = safeParseLLMJson<{ a: number }>('{"a": 1}');
    expect(result).toEqual({ a: 1 });
  });

  it("strips markdown code fences", () => {
    const input = '```json\n{"foo": "bar"}\n```';
    expect(safeParseLLMJson(input)).toEqual({ foo: "bar" });
  });

  it("strips code fences without language tag", () => {
    const input = '```\n{"foo": "bar"}\n```';
    expect(safeParseLLMJson(input)).toEqual({ foo: "bar" });
  });

  it("extracts JSON from preamble/postamble text", () => {
    const input = 'Here is the analysis:\n{"action": "BUY"}\nHope that helps!';
    expect(safeParseLLMJson(input)).toEqual({ action: "BUY" });
  });

  it("fixes single-quoted property names", () => {
    const input = "{'action': 'BUY', 'confidence': 0.9}";
    const result = safeParseLLMJson<{ action: string }>(input);
    expect(result.action).toBe("BUY");
  });

  it("removes trailing commas", () => {
    const input = '{"a": 1, "b": 2, }';
    expect(safeParseLLMJson(input)).toEqual({ a: 1, b: 2 });
  });

  it("removes trailing commas in arrays", () => {
    const input = '{"items": [1, 2, 3, ]}';
    expect(safeParseLLMJson(input)).toEqual({ items: [1, 2, 3] });
  });

  it("closes unterminated strings (truncated output)", () => {
    // Simulates finish_reason: "length" truncation mid-string
    const input = '{"action": "BUY", "reasoning": "The stock looks';
    const result = safeParseLLMJson<{ action: string; reasoning: string }>(input);
    expect(result.action).toBe("BUY");
    expect(result.reasoning).toBe("The stock looks");
  });

  it("closes unterminated objects (truncated output)", () => {
    const input = '{"recommendations": [{"action": "BUY",';
    const result = safeParseLLMJson<{ recommendations: Array<{ action: string }> }>(input);
    expect(result.recommendations).toBeDefined();
  });

  it("handles the real Gemini truncated response", () => {
    // Exact content from the Cloudflare AI Gateway log
    const input = '{\n  "recommendations": [\n    {\n      "action": "BUY",';
    const result = safeParseLLMJson<{ recommendations: Array<{ action: string }> }>(input);
    expect(result.recommendations).toBeInstanceOf(Array);
    expect(result.recommendations[0]?.action).toBe("BUY");
  });

  it("extracts JSON array", () => {
    const input = 'Result: [1, 2, 3]';
    expect(safeParseLLMJson(input)).toEqual([1, 2, 3]);
  });

  it("throws on completely unparseable content", () => {
    expect(() => safeParseLLMJson("This is just plain text with no JSON")).toThrow();
  });

  it("handles empty object", () => {
    expect(safeParseLLMJson("{}")).toEqual({});
  });

  it("handles nested objects correctly", () => {
    const input = '{"a": {"b": {"c": 1}}, "d": [1, 2]}';
    expect(safeParseLLMJson(input)).toEqual({ a: { b: { c: 1 } }, d: [1, 2] });
  });
});
