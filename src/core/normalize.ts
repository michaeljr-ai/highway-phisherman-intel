import crypto from "node:crypto";
import punycode from "node:punycode";
import { InvestigationInput, NormalizedInput } from "./types.js";

const DOMAIN_RE = /^(?=.{1,253}$)(?!-)[a-zA-Z0-9-]{1,63}(?<!-)(\.(?!-)[a-zA-Z0-9-]{1,63}(?<!-))+$/;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const SUSPICIOUS_TLDS = new Set([
  "zip",
  "mov",
  "xyz",
  "top",
  "click",
  "gq",
  "work",
  "country",
  "stream",
  "cam"
]);

export function generateCaseId(seedInputs: string[]): string {
  const hash = crypto
    .createHash("sha256")
    .update(seedInputs.join("|"))
    .digest("hex")
    .slice(0, 10)
    .toUpperCase();
  const now = new Date();
  const date = `${now.getUTCFullYear()}${String(now.getUTCMonth() + 1).padStart(2, "0")}${String(now.getUTCDate()).padStart(2, "0")}`;
  return `CASE-${date}-${hash}`;
}

function getRootDomain(hostname: string): string {
  const parts = hostname.toLowerCase().split(".").filter(Boolean);
  if (parts.length <= 2) {
    return hostname.toLowerCase();
  }
  const knownSecondLevel = new Set(["co.uk", "org.uk", "gov.uk", "ac.uk", "com.au", "co.in"]);
  const tail = `${parts[parts.length - 2]}.${parts[parts.length - 1]}`;
  if (knownSecondLevel.has(tail) && parts.length >= 3) {
    return `${parts[parts.length - 3]}.${tail}`;
  }
  return `${parts[parts.length - 2]}.${parts[parts.length - 1]}`;
}

function isPunycodeDomain(value: string): boolean {
  return value.includes("xn--");
}

function maybeHomoglyph(value: string): boolean {
  for (const ch of value) {
    if (ch.charCodeAt(0) > 127) {
      return true;
    }
  }
  return false;
}

function suspiciousTld(domain: string | undefined): boolean {
  if (!domain || !domain.includes(".")) {
    return false;
  }
  const tld = domain.split(".").pop()?.toLowerCase();
  return Boolean(tld && SUSPICIOUS_TLDS.has(tld));
}

function deriveUsernames(localPart: string): string[] {
  const base = localPart.trim();
  const candidates = new Set<string>([base]);
  const cleaned = base.replace(/[^a-zA-Z0-9_.-]/g, "");
  if (cleaned) {
    candidates.add(cleaned);
  }
  const noSeparators = cleaned.replace(/[._-]/g, "");
  if (noSeparators.length >= 3) {
    candidates.add(noSeparators);
  }
  const parts = cleaned.split(/[._-]/).filter(Boolean);
  if (parts.length >= 2) {
    candidates.add(`${parts[0]}${parts[parts.length - 1]}`);
    candidates.add(`${parts[0]}.${parts[parts.length - 1]}`);
  }
  return Array.from(candidates).slice(0, 8);
}

function normalizeDomainInput(input: string): NormalizedInput {
  const raw = input.trim().toLowerCase();
  const sanitized = raw.replace(/^https?:\/\//i, "").split("/")[0];
  const ascii = punycode.toASCII(sanitized);
  const valid = DOMAIN_RE.test(ascii);
  const rootDomain = valid ? getRootDomain(ascii) : undefined;
  return {
    original: input,
    inputKind: "domain",
    normalizedValue: ascii,
    hostname: ascii,
    rootDomain,
    flags: {
      isPunycode: isPunycodeDomain(ascii),
      possibleHomoglyph: maybeHomoglyph(sanitized),
      suspiciousTld: suspiciousTld(rootDomain ?? ascii),
      isValid: valid,
      validationError: valid ? undefined : "Invalid domain format"
    }
  };
}

function normalizeUrlInput(input: string): NormalizedInput {
  try {
    const url = new URL(input.trim());
    const hostname = punycode.toASCII(url.hostname.toLowerCase());
    const rootDomain = getRootDomain(hostname);
    return {
      original: input,
      inputKind: "url",
      normalizedValue: url.toString(),
      observedUrl: url.toString(),
      hostname,
      rootDomain,
      flags: {
        isPunycode: isPunycodeDomain(hostname),
        possibleHomoglyph: maybeHomoglyph(url.hostname),
        suspiciousTld: suspiciousTld(rootDomain),
        isValid: true
      }
    };
  } catch {
    return {
      original: input,
      inputKind: "url",
      normalizedValue: input,
      flags: {
        isPunycode: false,
        possibleHomoglyph: false,
        suspiciousTld: false,
        isValid: false,
        validationError: "Invalid URL"
      }
    };
  }
}

function normalizeEmailInput(input: string): NormalizedInput {
  const raw = input.trim();
  const valid = EMAIL_RE.test(raw);
  const [localPartRaw = "", domainRaw = ""] = raw.split("@");
  const domain = punycode.toASCII(domainRaw.toLowerCase());
  const canonical = `${localPartRaw}@${domain}`;
  const md5 = crypto.createHash("md5").update(canonical.trim().toLowerCase()).digest("hex");
  const rootDomain = getRootDomain(domain);

  return {
    original: input,
    inputKind: "email",
    normalizedValue: canonical,
    rootDomain,
    email: {
      localPart: localPartRaw,
      domain,
      canonical,
      gravatarMd5: md5,
      derivedUsernames: deriveUsernames(localPartRaw)
    },
    flags: {
      isPunycode: isPunycodeDomain(domain),
      possibleHomoglyph: maybeHomoglyph(domainRaw),
      suspiciousTld: suspiciousTld(rootDomain),
      isValid: valid,
      validationError: valid ? undefined : "Invalid email format"
    }
  };
}

export function normalizeInput(input: string): NormalizedInput {
  const trimmed = input.trim();
  if (trimmed.includes("@") && !trimmed.startsWith("http://") && !trimmed.startsWith("https://")) {
    return normalizeEmailInput(trimmed);
  }
  if (trimmed.startsWith("http://") || trimmed.startsWith("https://")) {
    return normalizeUrlInput(trimmed);
  }
  return normalizeDomainInput(trimmed);
}

export function createInvestigationInput(rawInputs: string[], tlp: string): InvestigationInput {
  const normalizedInputs = rawInputs.map(normalizeInput);
  const caseId = generateCaseId(rawInputs);
  const startedAtUtc = new Date().toISOString();

  const observedUrls = normalizedInputs
    .filter((item) => item.inputKind === "url" && item.flags.isValid)
    .map((item) => item.observedUrl as string);

  const primaryDomain =
    normalizedInputs.find((item) => item.rootDomain)?.rootDomain ??
    normalizedInputs.find((item) => item.inputKind === "domain")?.normalizedValue;

  const primaryEmail = normalizedInputs.find((item) => item.inputKind === "email" && item.email)?.email?.canonical;

  return {
    rawInputs,
    normalizedInputs,
    observedUrls,
    primaryDomain,
    primaryEmail,
    caseId,
    tlp,
    startedAtUtc
  };
}
