import { describe, expect, it } from "vitest";
import { normalizeInput } from "../src/core/normalize.js";

describe("normalizeInput", () => {
  it("normalizes domains", () => {
    const result = normalizeInput("Example.COM/path");
    expect(result.inputKind).toBe("domain");
    expect(result.normalizedValue).toBe("example.com");
    expect(result.flags.isValid).toBe(true);
  });

  it("normalizes URLs and extracts root domain", () => {
    const result = normalizeInput("https://sub.example.com/login?x=1");
    expect(result.inputKind).toBe("url");
    expect(result.hostname).toBe("sub.example.com");
    expect(result.rootDomain).toBe("example.com");
  });

  it("normalizes emails and derives usernames", () => {
    const result = normalizeInput("User.Name+tag@Example.com");
    expect(result.inputKind).toBe("email");
    expect(result.email?.domain).toBe("example.com");
    expect((result.email?.derivedUsernames ?? []).length).toBeGreaterThan(0);
  });
});
