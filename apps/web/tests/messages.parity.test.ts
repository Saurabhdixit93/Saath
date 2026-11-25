import { describe, expect, it } from "vitest";
import enMessages from "../messages/en.json";
import hiMessages from "../messages/hi.json";

function collectLeafKeys(obj: Record<string, unknown>, prefix = ""): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, val] of Object.entries(obj)) {
    const full = prefix ? `${prefix}.${key}` : key;
    if (typeof val === "string") {
      out[full] = val;
    } else if (val && typeof val === "object") {
      Object.assign(out, collectLeafKeys(val as Record<string, unknown>, full));
    }
  }
  return out;
}

function extractPlaceholders(text: string): string[] {
  return Array.from(text.matchAll(/\{([a-zA-Z0-9_]+)\}/g))
    .map((m) => m[1]!)
    .sort();
}

describe("en/hi message catalog parity", () => {
  it("has identical keys and matching ICU placeholders across en.json and hi.json", () => {
    const enLeaves = collectLeafKeys(enMessages);
    const hiLeaves = collectLeafKeys(hiMessages);

    expect(Object.keys(hiLeaves).sort()).toEqual(Object.keys(enLeaves).sort());

    for (const [key, enText] of Object.entries(enLeaves)) {
      const hiText = hiLeaves[key]!;
      expect(hiText.trim().length).toBeGreaterThan(0);
      expect(extractPlaceholders(hiText)).toEqual(extractPlaceholders(enText));
    }
  });
});
