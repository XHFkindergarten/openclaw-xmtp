import { describe, it, expect } from "vitest";
import { ContentFilter } from "../src/domains/security/filter.js";

describe("ContentFilter – edge cases", () => {
  it("allows empty string", () => {
    const f = new ContentFilter();
    expect(f.check("").allowed).toBe(true);
  });

  it("blocklist uses substring match — 'bad' hits 'badminton'", () => {
    // Document current behavior: includes() is substring, not word-boundary.
    // A message containing "badminton" is rejected when "bad" is blocklisted.
    const f = new ContentFilter({ blocklist: ["bad"] });
    expect(f.check("I love badminton").allowed).toBe(false);
  });

  it("returns on first blocklist match without scanning the rest", () => {
    const f = new ContentFilter({ blocklist: ["alpha", "beta"] });
    const result = f.check("alpha and beta");
    expect(result.allowed).toBe(false);
    // reason references "blocked content", not the specific word
    expect(result.reason).toMatch(/blocked/);
  });

  it("blocklist entry that is the [non-text] sentinel rejects sandbox output", () => {
    // Demonstrates how filter and sandbox interact:
    // if "[non-text]" is blocklisted, all non-text messages are dropped.
    const f = new ContentFilter({ blocklist: ["[non-text]"] });
    expect(f.check("[non-text]").allowed).toBe(false);
  });

  it("Unicode / emoji content is counted by JS string length (code units)", () => {
    // "😀" is 2 code units in JS (surrogate pair).
    // maxLength=1 will reject it even though it's visually one character.
    const f = new ContentFilter({ maxLength: 1 });
    expect(f.check("😀").allowed).toBe(false); // length = 2
    expect(f.check("a").allowed).toBe(true);   // length = 1
  });

  it("blocklist word with leading/trailing spaces is matched literally", () => {
    // Setters do NOT trim words; " bad " requires " bad " in input to match.
    const f = new ContentFilter({ blocklist: [" bad "] });
    expect(f.check("bad").allowed).toBe(true);        // no surrounding spaces → no match
    expect(f.check("isbadword").allowed).toBe(true);  // no spaces → no match
    expect(f.check("is bad word").allowed).toBe(false); // " bad " present → match
  });

  it("setBlocklist with empty array clears previous blocklist", () => {
    const f = new ContentFilter({ blocklist: ["secret"] });
    f.setBlocklist([]);
    expect(f.check("secret").allowed).toBe(true);
  });

  it("maxLength=0 rejects any non-empty string", () => {
    const f = new ContentFilter({ maxLength: 0 });
    expect(f.check("").allowed).toBe(true);
    expect(f.check("a").allowed).toBe(false);
  });
});
