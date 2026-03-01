import { describe, expect, it } from "vitest";
import { extractIocsFromText } from "../src/core/ioc_extract.js";

describe("extractIocsFromText", () => {
  it("extracts IOC primitives", () => {
    const sample = `Visit https://example.com/login and contact user@example.com from 8.8.8.8 or +1 212-555-0199`;
    const iocs = extractIocsFromText(sample);

    expect(iocs.urls).toContain("https://example.com/login");
    expect(iocs.emails).toContain("user@example.com");
    expect(iocs.ips).toContain("8.8.8.8");
    expect(iocs.phones.length).toBeGreaterThan(0);
  });
});
