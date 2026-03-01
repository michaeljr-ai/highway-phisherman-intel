import { promises as fs } from "node:fs";
import path from "node:path";
import { lookup as dnsLookup, resolve4, resolve6 } from "node:dns/promises";
import { EnricherAdapter, EnricherContext, EnricherRunResult, InputKind } from "../core/types.js";

export interface AdapterOptions {
  tool_name: string;
  inputs_required: InputKind[];
  can_run_from: InputKind[];
  defaultEnabled: boolean;
  collectionMethod: EnricherAdapter["collectionMethod"];
  run: (context: EnricherContext) => Promise<EnricherRunResult>;
  parse?: EnricherAdapter["parse"];
}

export function createAdapter(options: AdapterOptions): EnricherAdapter {
  return {
    tool_name: options.tool_name,
    inputs_required: options.inputs_required,
    can_run_from: options.can_run_from,
    defaultEnabled: options.defaultEnabled,
    collectionMethod: options.collectionMethod,
    run: options.run,
    parse: options.parse ?? ((raw) => ({ raw }))
  };
}

export function disabledRun(reason: string): Promise<EnricherRunResult> {
  return Promise.resolve({
    status: "disabled",
    statusReason: reason,
    raw: { message: reason },
    summary: reason
  });
}

export function notConfiguredRun(reason: string): Promise<EnricherRunResult> {
  return Promise.resolve({
    status: "not_configured",
    statusReason: reason,
    raw: { message: reason },
    summary: reason
  });
}

export function skippedRun(reason: string): Promise<EnricherRunResult> {
  return Promise.resolve({
    status: "skipped",
    statusReason: reason,
    raw: { message: reason },
    summary: reason
  });
}

export async function requireBinary(name: string): Promise<boolean> {
  try {
    const { access } = await import("node:fs/promises");
    const paths = (process.env.PATH ?? "").split(path.delimiter);
    for (const p of paths) {
      const full = path.join(p, name);
      try {
        await access(full);
        return true;
      } catch {
        continue;
      }
    }
    return false;
  } catch {
    return false;
  }
}

export function firstDomain(context: EnricherContext): string | undefined {
  if (context.input.primaryDomain) {
    return context.input.primaryDomain;
  }
  return context.scope.domains.values().next().value;
}

export function firstUrl(context: EnricherContext): string | undefined {
  return context.scope.urls.values().next().value;
}

export function firstEmail(context: EnricherContext): string | undefined {
  if (context.input.primaryEmail) {
    return context.input.primaryEmail;
  }
  return context.scope.emails.values().next().value;
}

export function listIps(context: EnricherContext): string[] {
  return Array.from(context.scope.ips);
}

export function listUsernames(context: EnricherContext): string[] {
  return Array.from(context.scope.usernames);
}

export function listPhones(context: EnricherContext): string[] {
  return Array.from(context.scope.phones);
}

export async function resolveDomainToIps(domain: string): Promise<string[]> {
  const ips = new Set<string>();
  try {
    const a = await resolve4(domain);
    a.forEach((ip) => ips.add(ip));
  } catch {
    // ignored
  }
  try {
    const aaaa = await resolve6(domain);
    aaaa.forEach((ip) => ips.add(ip));
  } catch {
    // ignored
  }
  try {
    const lookupRes = await dnsLookup(domain, { all: true });
    lookupRes.forEach((entry) => ips.add(entry.address));
  } catch {
    // ignored
  }
  return Array.from(ips);
}

export async function safeJsonFetch(context: EnricherContext, url: string, init?: RequestInit): Promise<unknown> {
  return context.utilities.fetchJson(url, {
    ...init,
    signal: AbortSignal.timeout(25_000)
  });
}

export async function safeTextFetch(context: EnricherContext, url: string, init?: RequestInit): Promise<string> {
  return context.utilities.fetchText(url, {
    ...init,
    signal: AbortSignal.timeout(25_000)
  });
}

export function hasApiKey(context: EnricherContext, keyName: keyof EnricherContext["config"]["apiKeys"]): boolean {
  return Boolean(context.config.apiKeys[keyName]);
}

export function getApiKey(context: EnricherContext, keyName: keyof EnricherContext["config"]["apiKeys"]): string {
  return context.config.apiKeys[keyName] ?? "";
}

export async function readJsonFile(filePath: string): Promise<unknown> {
  const data = await fs.readFile(filePath, "utf8");
  return JSON.parse(data);
}
