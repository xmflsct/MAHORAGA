/**
 * Robust JSON parser for LLM responses.
 *
 * LLMs (especially thinking models like Gemini 3 Pro) may return:
 * - Markdown-fenced code blocks wrapping JSON
 * - Truncated JSON (finish_reason: "length")
 * - Single-quoted property names
 * - Trailing commas
 * - Unquoted property names
 * - Preamble/postamble text around the JSON object
 *
 * This module attempts a best-effort parse and repair.
 */

/**
 * Attempt to parse JSON from an LLM response, applying repairs if needed.
 * Throws on completely unparseable content.
 */
export function safeParseLLMJson<T = unknown>(raw: string): T {
  // 1. Strip markdown code fences
  let cleaned = raw.replace(/```(?:json)?\n?/g, "").trim();

  // 2. Extract the first JSON object {...} or array [...]
  cleaned = extractJsonBlock(cleaned);

  // 3. Try direct parse first (fast path)
  try {
    return JSON.parse(cleaned) as T;
  } catch {
    // continue to repair
  }

  // 4. Apply repairs
  let repaired = cleaned;

  // 4a. Replace single quotes with double quotes (for JSON keys and string values)
  repaired = replaceSingleQuotes(repaired);

  // 4b. Fix unquoted property names: { key: -> { "key":
  repaired = repaired.replace(/([\{,]\s*)([a-zA-Z_][a-zA-Z0-9_]*)\s*:/g, '$1"$2":');

  // 4c. Remove trailing commas before } or ]
  repaired = repaired.replace(/,\s*([}\]])/g, "$1");

  // 4d. Try parse after basic repairs
  try {
    return JSON.parse(repaired) as T;
  } catch {
    // continue
  }

  // 4e. Try to close unterminated strings and objects/arrays
  repaired = closeUnterminatedJson(repaired);

  try {
    return JSON.parse(repaired) as T;
  } catch {
    // fall through
  }

  // 5. Last resort: throw with original content context
  throw new SyntaxError(
    `Failed to parse LLM JSON after repair attempts. Content starts with: ${raw.slice(0, 120)}`
  );
}

/**
 * Extract the outermost JSON object or array from a string that may
 * contain preamble/postamble text.
 */
function extractJsonBlock(text: string): string {
  // Find the first { or [
  const objStart = text.indexOf("{");
  const arrStart = text.indexOf("[");

  let start: number;
  let openChar: string;
  let closeChar: string;

  if (objStart === -1 && arrStart === -1) return text;
  if (objStart === -1) {
    start = arrStart;
    openChar = "[";
    closeChar = "]";
  } else if (arrStart === -1) {
    start = objStart;
    openChar = "{";
    closeChar = "}";
  } else {
    start = Math.min(objStart, arrStart);
    openChar = text[start]!;
    closeChar = openChar === "{" ? "}" : "]";
  }

  // Walk forward counting balanced braces/brackets to find the end
  let depth = 0;
  let inString = false;
  let isEscape = false;
  let end = start;

  for (let i = start; i < text.length; i++) {
    const ch = text[i];

    if (isEscape) {
      isEscape = false;
      continue;
    }
    if (ch === "\\") {
      isEscape = true;
      continue;
    }
    if (ch === '"') {
      inString = !inString;
      continue;
    }
    if (inString) continue;

    if (ch === openChar || ch === "{" || ch === "[") depth++;
    if (ch === closeChar || ch === "}" || ch === "]") {
      depth--;
      if (depth === 0) {
        end = i;
        return text.slice(start, end + 1);
      }
    }
  }

  // If we ran out of characters, return from start to end (truncated JSON)
  return text.slice(start);
}

/**
 * Attempt to close an unterminated JSON string/object/array so it can parse.
 * This handles the common case of `finish_reason: "length"` truncation.
 */
function closeUnterminatedJson(text: string): string {
  let result = text;

  // Track what needs closing
  const stack: string[] = [];
  let inString = false;
  let isEscape = false;

  for (let i = 0; i < result.length; i++) {
    const ch = result[i];

    if (isEscape) {
      isEscape = false;
      continue;
    }
    if (ch === "\\") {
      isEscape = true;
      continue;
    }
    if (ch === '"') {
      inString = !inString;
      continue;
    }
    if (inString) continue;

    if (ch === "{") stack.push("}");
    else if (ch === "[") stack.push("]");
    else if (ch === "}" || ch === "]") stack.pop();
  }

  // If we ended inside a string, close it
  if (inString) {
    result += '"';
  }

  // Remove any trailing comma after closing the string
  result = result.replace(/,\s*$/, "");

  // Close any open structures
  while (stack.length > 0) {
    result += stack.pop();
  }

  return result;
}

/**
 * Replace single quotes used as JSON delimiters with double quotes.
 * Handles both keys and values: {'key': 'value'} -> {"key": "value"}
 */
function replaceSingleQuotes(text: string): string {
  let result = "";
  let inDouble = false;
  let inSingle = false;
  let isEscape = false;

  for (let i = 0; i < text.length; i++) {
    const ch = text[i]!;

    if (isEscape) {
      isEscape = false;
      result += ch;
      continue;
    }
    if (ch === "\\") {
      isEscape = true;
      result += ch;
      continue;
    }

    if (ch === '"' && !inSingle) {
      inDouble = !inDouble;
      result += ch;
    } else if (ch === "'" && !inDouble) {
      inSingle = !inSingle;
      result += '"'; // replace single quote with double quote
    } else {
      result += ch;
    }
  }

  return result;
}
