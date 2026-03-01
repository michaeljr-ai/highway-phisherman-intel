import { describe, expect, it } from "vitest";
import { buildGraph } from "../src/core/graph.js";

describe("buildGraph", () => {
  it("computes graph metrics", () => {
    const graph = buildGraph(
      [
        { id: "domain:example.com", type: "Domain", label: "example.com", tags: ["CONFIRMED"], evidenceIds: [], properties: {} },
        { id: "ip:1.1.1.1", type: "IP", label: "1.1.1.1", tags: ["ACTIVE"], evidenceIds: [], properties: {} },
        { id: "email:user@example.com", type: "Email", label: "user@example.com", tags: ["CONFIRMED"], evidenceIds: [], properties: {} }
      ],
      [
        {
          id: "e1",
          source: "domain:example.com",
          target: "ip:1.1.1.1",
          relation: "resolves_to",
          strength: 0.8,
          evidenceIds: []
        }
      ]
    );

    expect(graph.metrics.nodeCount).toBe(3);
    expect(graph.metrics.edgeCount).toBe(1);
    expect(graph.metrics.connectedComponents).toBe(2);
  });
});
