import { describe, expect, test } from "vitest";
import { getToolCoverageSnapshot } from "../src/core/tool_manifest.js";

describe("tool coverage", () => {
  test("all 55 required adapters are present", () => {
    const snapshot = getToolCoverageSnapshot();
    expect(snapshot.requiredCount).toBe(55);
    expect(snapshot.missingRequired).toEqual([]);
    expect(snapshot.implementedCount).toBeGreaterThanOrEqual(55);
  });
});
