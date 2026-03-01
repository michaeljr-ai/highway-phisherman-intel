import { describe, expect, it } from "vitest";
import dnsTxtSpfDmarc from "../src/enrichers/dns_txt_spf_dmarc.js";

describe("adapter parsers", () => {
  it("parses SPF and DMARC signals", async () => {
    const parsed = await dnsTxtSpfDmarc.parse(
      {
        txt: ["v=spf1 include:_spf.google.com -all"],
        dmarc: ["v=DMARC1; p=none; rua=mailto:dmarc@example.com"]
      },
      {} as any
    );

    expect(parsed.spf).toContain("v=spf1");
    expect(parsed.dmarcPolicy).toBe("none");
    expect(parsed.weakPolicy).toBe(true);
  });
});
