import { EnricherAdapter } from "../core/types.js";

import highwayIdentityAlert from "./highway_identity_alert.js";
import fmcsaSaferCensus from "./fmcsa_safer_census.js";
import shodan from "./shodan.js";
import virustotal from "./virustotal.js";
import hunter from "./hunter.js";
import holehe from "./holehe.js";
import sherlock from "./sherlock.js";
import maigret from "./maigret.js";
import blackbird from "./blackbird.js";
import theHarvester from "./theharvester.js";
import socialscan from "./socialscan.js";
import nmap from "./nmap.js";
import nuclei from "./nuclei.js";
import wafw00f from "./wafw00f.js";
import subfinder from "./subfinder.js";
import abuseipdb from "./abuseipdb.js";
import scamalytics from "./scamalytics.js";
import ipqs from "./ipqs.js";
import veriphone from "./veriphone.js";
import greip from "./greip.js";
import ipstack from "./ipstack.js";
import ipgeolocation from "./ipgeolocation.js";
import crtsh from "./crtsh.js";
import censys from "./censys.js";
import rdap from "./rdap.js";
import urlscan from "./urlscan.js";
import wayback from "./wayback.js";
import hostio from "./hostio.js";
import gravatar from "./gravatar.js";
import github from "./github.js";
import stopForumSpam from "./stopforumspam.js";
import bgpAsn from "./bgp_asn.js";
import openCorporates from "./opencorporates.js";
import secEdgar from "./sec_edgar.js";
import indiaMcaZauba from "./india_mca_zauba.js";
import canadaCorporations from "./canada_corporations.js";
import nyDos from "./ny_dos.js";
import torCheck from "./tor_check.js";
import shodanOrgSsl from "./shodan_org_ssl_search.js";
import dnsMxLookup from "./dns_mx_lookup.js";
import dnsTxtSpfDmarc from "./dns_txt_spf_dmarc.js";
import blacklistReputation from "./blacklist_reputation.js";
import liveWebsiteFetch from "./live_website_fetch.js";
import eyewitness from "./eyewitness.js";
import spiderfoot from "./spiderfoot.js";
import osintFrameworkReference from "./osint_framework_reference.js";
import ipGeolocationAggregation from "./ip_geolocation_aggregation.js";
import reverseDnsPtr from "./reverse_dns_ptr.js";
import phoneOsint from "./phone_osint.js";
import pythonGraphEngine from "./python_graph_engine.js";
import rustGraphEngine from "./rust_graph_engine.js";
import csvAnalysisEngine from "./csv_analysis_engine.js";
import visaMethodology from "./visa_immigration_methodology.js";
import bmoRecords from "./bmo_equipment_financing_court_records.js";
import fmcsaIpCrossReference from "./fmcsa_ip_cross_reference.js";
import dnsRecords from "./dns_records.js";

export interface WaveAdapter {
  wave: number;
  adapter: EnricherAdapter;
}

export const ALL_ENRICHERS: EnricherAdapter[] = [
  highwayIdentityAlert,
  fmcsaSaferCensus,
  shodan,
  virustotal,
  hunter,
  holehe,
  sherlock,
  maigret,
  blackbird,
  theHarvester,
  socialscan,
  nmap,
  nuclei,
  wafw00f,
  subfinder,
  abuseipdb,
  scamalytics,
  ipqs,
  veriphone,
  greip,
  ipstack,
  ipgeolocation,
  crtsh,
  censys,
  rdap,
  urlscan,
  wayback,
  hostio,
  gravatar,
  github,
  stopForumSpam,
  bgpAsn,
  openCorporates,
  secEdgar,
  indiaMcaZauba,
  canadaCorporations,
  nyDos,
  torCheck,
  shodanOrgSsl,
  dnsMxLookup,
  dnsTxtSpfDmarc,
  blacklistReputation,
  liveWebsiteFetch,
  eyewitness,
  spiderfoot,
  osintFrameworkReference,
  ipGeolocationAggregation,
  reverseDnsPtr,
  phoneOsint,
  pythonGraphEngine,
  rustGraphEngine,
  csvAnalysisEngine,
  visaMethodology,
  bmoRecords,
  fmcsaIpCrossReference,
  dnsRecords
];

export const ENRICHERS_BY_WAVE: WaveAdapter[] = [
  // Wave 1: Passive domain/email/URL enrichment
  { wave: 1, adapter: highwayIdentityAlert },
  { wave: 1, adapter: fmcsaSaferCensus },
  { wave: 1, adapter: rdap },
  { wave: 1, adapter: dnsRecords },
  { wave: 1, adapter: dnsMxLookup },
  { wave: 1, adapter: dnsTxtSpfDmarc },
  { wave: 1, adapter: subfinder },
  { wave: 1, adapter: theHarvester },
  { wave: 1, adapter: liveWebsiteFetch },
  { wave: 1, adapter: hostio },
  { wave: 1, adapter: gravatar },

  // Wave 2: Passive internet-wide correlation
  { wave: 2, adapter: crtsh },
  { wave: 2, adapter: censys },
  { wave: 2, adapter: shodan },
  { wave: 2, adapter: virustotal },
  { wave: 2, adapter: urlscan },
  { wave: 2, adapter: wayback },
  { wave: 2, adapter: bgpAsn },
  { wave: 2, adapter: torCheck },
  { wave: 2, adapter: shodanOrgSsl },
  { wave: 2, adapter: reverseDnsPtr },
  { wave: 2, adapter: blacklistReputation },

  // Wave 3: Email + username surface intel
  { wave: 3, adapter: hunter },
  { wave: 3, adapter: holehe },
  { wave: 3, adapter: sherlock },
  { wave: 3, adapter: maigret },
  { wave: 3, adapter: blackbird },
  { wave: 3, adapter: socialscan },
  { wave: 3, adapter: github },
  { wave: 3, adapter: stopForumSpam },

  // Wave 3/2 risk sources
  { wave: 3, adapter: abuseipdb },
  { wave: 3, adapter: scamalytics },
  { wave: 3, adapter: ipqs },
  { wave: 3, adapter: greip },
  { wave: 3, adapter: ipstack },
  { wave: 3, adapter: ipgeolocation },
  { wave: 3, adapter: ipGeolocationAggregation },
  { wave: 3, adapter: veriphone },
  { wave: 3, adapter: phoneOsint },

  // Wave 4: Optional active recon
  { wave: 4, adapter: wafw00f },
  { wave: 4, adapter: nmap },
  { wave: 4, adapter: nuclei },
  { wave: 4, adapter: eyewitness },
  { wave: 4, adapter: spiderfoot },

  // Wave 5: Fusion & auxiliary adapters
  { wave: 5, adapter: osintFrameworkReference },
  { wave: 5, adapter: pythonGraphEngine },
  { wave: 5, adapter: rustGraphEngine },
  { wave: 5, adapter: openCorporates },
  { wave: 5, adapter: secEdgar },
  { wave: 5, adapter: indiaMcaZauba },
  { wave: 5, adapter: canadaCorporations },
  { wave: 5, adapter: nyDos },
  { wave: 5, adapter: csvAnalysisEngine },
  { wave: 5, adapter: visaMethodology },
  { wave: 5, adapter: bmoRecords },
  { wave: 5, adapter: fmcsaIpCrossReference }
];

export const TOOL_COUNT = ALL_ENRICHERS.length;
