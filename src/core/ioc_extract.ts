import { EnricherOutput, ScopeState } from "./types.js";

const IPV4_RE = /\b(?:(?:25[0-5]|2[0-4]\d|1?\d?\d)\.){3}(?:25[0-5]|2[0-4]\d|1?\d?\d)\b/g;
const DOMAIN_RE = /\b(?:[a-zA-Z0-9-]+\.)+[a-zA-Z]{2,63}\b/g;
const URL_RE = /https?:\/\/[^\s"'<>]+/g;
const EMAIL_RE = /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,63}\b/g;
const PHONE_RE = /(?:\+?\d{1,3}[\s.-]?)?(?:\(?\d{2,4}\)?[\s.-]?)?\d{3}[\s.-]?\d{4}\b/g;

function unique(values: string[]): string[] {
  return Array.from(new Set(values.map((v) => v.trim()).filter(Boolean)));
}

export function extractIocsFromText(text: string): {
  ips: string[];
  domains: string[];
  urls: string[];
  emails: string[];
  phones: string[];
} {
  return {
    ips: unique(text.match(IPV4_RE) ?? []),
    domains: unique((text.match(DOMAIN_RE) ?? []).map((d) => d.toLowerCase())),
    urls: unique(text.match(URL_RE) ?? []),
    emails: unique((text.match(EMAIL_RE) ?? []).map((e) => e.toLowerCase())),
    phones: unique((text.match(PHONE_RE) ?? []).map((p) => p.trim()))
  };
}

export function deriveScopeFromFindings(scope: ScopeState, findings: EnricherOutput[]): ScopeState {
  for (const finding of findings) {
    for (const ip of finding.derived.ips) {
      scope.ips.add(ip);
    }
    for (const username of finding.derived.usernames) {
      scope.usernames.add(username);
    }
    for (const phone of finding.derived.phones) {
      scope.phones.add(phone);
    }
    for (const email of finding.derived.emails) {
      scope.emails.add(email.toLowerCase());
    }
    for (const domain of finding.derived.domains) {
      scope.domains.add(domain.toLowerCase());
    }
    for (const url of finding.derived.urls) {
      scope.urls.add(url);
    }
    for (const cert of finding.derived.certFingerprints) {
      scope.certFingerprints.add(cert);
    }

    const asText = JSON.stringify(finding.raw ?? finding.parsed);
    const extracted = extractIocsFromText(asText);

    extracted.ips.forEach((v) => scope.ips.add(v));
    extracted.domains.forEach((v) => scope.domains.add(v));
    extracted.urls.forEach((v) => scope.urls.add(v));
    extracted.emails.forEach((v) => scope.emails.add(v));

    // Phone numbers are only accepted if discovered in already retrieved content.
    // This function is only called after tools have produced artifacts.
    extracted.phones.forEach((v) => scope.phones.add(v));
  }

  return scope;
}
