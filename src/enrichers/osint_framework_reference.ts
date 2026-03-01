import { createAdapter } from "./_factory.js";

export default createAdapter({
  tool_name: "OSINT Framework",
  inputs_required: ["domain"],
  can_run_from: ["domain", "url", "email"],
  defaultEnabled: true,
  collectionMethod: "derived",
  async run() {
    return {
      status: "ok",
      raw: {
        methodsReference: [
          { category: "Domain Intelligence", tools: ["RDAP", "DNS", "crt.sh", "Shodan", "Censys", "VirusTotal"] },
          { category: "URL Behavior", tools: ["URLScan", "Wayback", "Live Fetch"] },
          { category: "Identity Surface", tools: ["Hunter", "Holehe", "Sherlock", "Maigret", "Blackbird", "Socialscan", "GitHub"] },
          { category: "Reputation", tools: ["AbuseIPDB", "IPQS", "Scamalytics", "Blocklists"] }
        ]
      },
      summary: "Methods reference mapped from OSINT Framework categories"
    };
  },
  parse(raw) {
    return {
      methodsReference: (raw as any)?.methodsReference ?? []
    };
  }
});
