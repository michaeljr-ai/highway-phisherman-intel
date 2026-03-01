import { ALL_ENRICHERS } from "../enrichers/registry.js";

export type RequiredTool = {
  id: number;
  expectedName: string;
  aliases: string[];
};

const REQUIRED_TOOLS: RequiredTool[] = [
  { id: 1, expectedName: "Highway Identity Alert Database", aliases: ["Highway Identity Alert Database"] },
  { id: 2, expectedName: "FMCSA SAFER/Census API", aliases: ["FMCSA SAFER/Census API"] },
  { id: 3, expectedName: "Shodan API", aliases: ["Shodan API"] },
  { id: 4, expectedName: "VirusTotal API", aliases: ["VirusTotal API"] },
  { id: 5, expectedName: "Hunter.io API", aliases: ["Hunter.io API"] },
  { id: 6, expectedName: "Holehe", aliases: ["Holehe"] },
  { id: 7, expectedName: "Sherlock", aliases: ["Sherlock"] },
  { id: 8, expectedName: "Maigret", aliases: ["Maigret"] },
  { id: 9, expectedName: "Blackbird", aliases: ["Blackbird"] },
  { id: 10, expectedName: "theHarvester", aliases: ["theHarvester"] },
  { id: 11, expectedName: "Socialscan", aliases: ["Socialscan"] },
  { id: 12, expectedName: "Nmap (authorized; active toggle)", aliases: ["Nmap (authorized; active toggle)"] },
  { id: 13, expectedName: "Nuclei (active toggle)", aliases: ["Nuclei (active toggle)"] },
  { id: 14, expectedName: "wafw00f", aliases: ["wafw00f"] },
  { id: 15, expectedName: "Subfinder", aliases: ["Subfinder"] },
  { id: 16, expectedName: "AbuseIPDB API", aliases: ["AbuseIPDB API"] },
  { id: 17, expectedName: "Scamalytics API", aliases: ["Scamalytics API"] },
  { id: 18, expectedName: "IPQualityScore (IPQS)", aliases: ["IPQualityScore (IPQS)"] },
  { id: 19, expectedName: "Veriphone API", aliases: ["Veriphone API"] },
  { id: 20, expectedName: "Greip API", aliases: ["Greip API"] },
  { id: 21, expectedName: "ipstack API", aliases: ["ipstack API"] },
  { id: 22, expectedName: "IPGeolocation API", aliases: ["IPGeolocation API"] },
  { id: 23, expectedName: "crt.sh", aliases: ["crt.sh"] },
  { id: 24, expectedName: "Censys", aliases: ["Censys"] },
  { id: 25, expectedName: "RDAP", aliases: ["RDAP"] },
  { id: 26, expectedName: "URLScan.io API", aliases: ["URLScan.io API"] },
  {
    id: 27,
    expectedName: "Wayback Machine / Internet Archive API",
    aliases: ["Wayback Machine / Internet Archive API"]
  },
  { id: 28, expectedName: "Host.io API", aliases: ["Host.io API"] },
  { id: 29, expectedName: "Gravatar API", aliases: ["Gravatar API"] },
  { id: 30, expectedName: "GitHub API", aliases: ["GitHub API"] },
  { id: 31, expectedName: "StopForumSpam API", aliases: ["StopForumSpam API"] },
  { id: 32, expectedName: "BGP/ASN Lookup", aliases: ["BGP/ASN Lookup"] },
  { id: 33, expectedName: "OpenCorporates API", aliases: ["OpenCorporates API"] },
  { id: 34, expectedName: "SEC EDGAR", aliases: ["SEC EDGAR"] },
  { id: 35, expectedName: "India MCA / Zauba", aliases: ["India MCA / Zauba"] },
  {
    id: 36,
    expectedName: "Canada Corporations / Provincial Registries",
    aliases: ["Canada Corporations / Provincial Registries"]
  },
  { id: 37, expectedName: "NY DOS", aliases: ["NY DOS"] },
  { id: 38, expectedName: "Tor Check (Tor Project API)", aliases: ["Tor Check (Tor Project API)"] },
  {
    id: 39,
    expectedName: "Shodan Organization/SSL Search",
    aliases: ["Shodan Organization/SSL Search"]
  },
  { id: 40, expectedName: "DNS MX Record Lookup", aliases: ["DNS MX Record Lookup"] },
  {
    id: 41,
    expectedName: "DNS TXT/SPF/DMARC Analysis",
    aliases: ["DNS TXT/SPF/DMARC Analysis", "mx_spf_dmarc"]
  },
  { id: 42, expectedName: "Blacklist/Reputation Check APIs", aliases: ["Blacklist/Reputation Check APIs"] },
  {
    id: 43,
    expectedName: "Live Website Fetching (curl/wget safe mode)",
    aliases: ["Live Website Fetching (curl/wget safe mode)"]
  },
  { id: 44, expectedName: "EyeWitness (active toggle)", aliases: ["EyeWitness (active toggle)"] },
  { id: 45, expectedName: "SpiderFoot (active toggle)", aliases: ["SpiderFoot (active toggle)"] },
  { id: 46, expectedName: "OSINT Framework", aliases: ["OSINT Framework"] },
  {
    id: 47,
    expectedName: "IP Geolocation (ipinfo/MaxMind/multi-source)",
    aliases: ["IP Geolocation (ipinfo/MaxMind/multi-source)"]
  },
  { id: 48, expectedName: "Reverse DNS / PTR Records", aliases: ["Reverse DNS / PTR Records"] },
  {
    id: 49,
    expectedName: "Phone OSINT (Numverify/custom lookups)",
    aliases: ["Phone OSINT (Numverify/custom lookups)"]
  },
  {
    id: 50,
    expectedName: "Python Graph-Theoretic Analysis Engine (custom)",
    aliases: ["Python Graph-Theoretic Analysis Engine (custom)"]
  },
  { id: 51, expectedName: "Rust Graph Engine (custom compiled)", aliases: ["Rust Graph Engine (custom compiled)"] },
  { id: 52, expectedName: "Full CSV Analysis Engine (custom)", aliases: ["Full CSV Analysis Engine (custom)"] },
  {
    id: 53,
    expectedName: "Visa/Immigration Fraud Methodology Research",
    aliases: ["Visa/Immigration Fraud Methodology Research"]
  },
  {
    id: 54,
    expectedName: "BMO Equipment Financing Court Records",
    aliases: ["BMO Equipment Financing Court Records"]
  },
  {
    id: 55,
    expectedName: "FMCSA IP Cross-Referencing (Highway internal)",
    aliases: ["FMCSA IP Cross-Referencing (Highway internal)"]
  }
];

export type ToolCoverageSnapshot = {
  requiredCount: number;
  implementedCount: number;
  missingRequired: string[];
};

export function getRequiredTools(): RequiredTool[] {
  return REQUIRED_TOOLS.map((tool) => ({ ...tool, aliases: [...tool.aliases] }));
}

export function getToolCoverageSnapshot(): ToolCoverageSnapshot {
  const implemented = new Set(ALL_ENRICHERS.map((adapter) => adapter.tool_name));
  const missingRequired = REQUIRED_TOOLS.filter(
    (tool) => !tool.aliases.some((alias) => implemented.has(alias))
  ).map((tool) => `${tool.id}. ${tool.expectedName}`);

  return {
    requiredCount: REQUIRED_TOOLS.length,
    implementedCount: ALL_ENRICHERS.length,
    missingRequired
  };
}
