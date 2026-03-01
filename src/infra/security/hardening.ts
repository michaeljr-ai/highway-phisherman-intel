import { timingSafeEqual } from "node:crypto";
import type { NextFunction, Request, Response } from "express";
import { AppConfig } from "../../core/types.js";

type CounterWindow = {
  count: number;
  resetAt: number;
};

const globalWindow = new Map<string, CounterWindow>();
const sensitiveWindow = new Map<string, CounterWindow>();
const WINDOW_MS = 60_000;

function normalizeIp(ip: string): string {
  if (!ip) return "unknown";
  return ip.replace(/^::ffff:/, "");
}

function requestIp(req: Request): string {
  const forwarded = req.header("x-forwarded-for");
  if (forwarded) {
    const first = forwarded.split(",")[0]?.trim();
    if (first) return normalizeIp(first);
  }
  return normalizeIp(req.socket.remoteAddress ?? "unknown");
}

function constantTimeEquals(a: string, b: string): boolean {
  const aBuf = Buffer.from(a);
  const bBuf = Buffer.from(b);
  if (aBuf.length !== bBuf.length) return false;
  return timingSafeEqual(aBuf, bBuf);
}

function ipToInt(ip: string): number | null {
  const parts = ip.split(".");
  if (parts.length !== 4) return null;
  const octets = parts.map((part) => Number(part));
  if (octets.some((n) => Number.isNaN(n) || n < 0 || n > 255)) return null;
  return (
    ((octets[0] << 24) >>> 0) +
    ((octets[1] << 16) >>> 0) +
    ((octets[2] << 8) >>> 0) +
    (octets[3] >>> 0)
  ) >>> 0;
}

function inCidr(ip: string, cidr: string): boolean {
  const [range, bitsText] = cidr.split("/");
  const bits = Number(bitsText);
  if (!range || Number.isNaN(bits) || bits < 0 || bits > 32) {
    return false;
  }
  const ipInt = ipToInt(ip);
  const rangeInt = ipToInt(range);
  if (ipInt === null || rangeInt === null) return false;
  const mask = bits === 0 ? 0 : (0xffffffff << (32 - bits)) >>> 0;
  return (ipInt & mask) === (rangeInt & mask);
}

function isAllowedIp(ip: string, allowlist: string[]): boolean {
  if (allowlist.length === 0) return true;
  for (const entry of allowlist) {
    const trimmed = entry.trim();
    if (!trimmed) continue;
    if (trimmed.includes("/")) {
      if (inCidr(ip, trimmed)) return true;
      continue;
    }
    if (ip === trimmed) return true;
  }
  return false;
}

function hitWindow(map: Map<string, CounterWindow>, key: string, limit: number): boolean {
  const now = Date.now();
  const current = map.get(key);
  if (!current || now >= current.resetAt) {
    map.set(key, { count: 1, resetAt: now + WINDOW_MS });
    return true;
  }
  if (current.count >= limit) {
    return false;
  }
  current.count += 1;
  map.set(key, current);
  return true;
}

function ownerTokenFromRequest(req: Request): string | undefined {
  const bearer = req.header("authorization");
  if (bearer && /^Bearer\s+/i.test(bearer)) {
    return bearer.replace(/^Bearer\s+/i, "").trim();
  }
  const headerToken = req.header("x-owner-token");
  if (headerToken) {
    return headerToken;
  }

  const cookieHeader = req.header("cookie") ?? "";
  const cookieToken = cookieHeader
    .split(";")
    .map((part) => part.trim())
    .find((part) => part.startsWith("owner_token="))
    ?.slice("owner_token=".length);
  return cookieToken;
}

export function securityHeadersMiddleware() {
  return (_req: Request, res: Response, next: NextFunction): void => {
    res.setHeader("X-Frame-Options", "DENY");
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.setHeader("Referrer-Policy", "no-referrer");
    res.setHeader("X-Robots-Tag", "noindex, noarchive, nosnippet, noimageindex");
    res.setHeader("Permissions-Policy", "camera=(), microphone=(), geolocation=()");
    res.setHeader("X-XSS-Protection", "0");
    res.setHeader("Cache-Control", "no-store, max-age=0");
    res.setHeader(
      "Content-Security-Policy",
      "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'self'; form-action 'self'"
    );
    next();
  };
}

export function ownerOnlyMiddleware(config: AppConfig) {
  return (req: Request, res: Response, next: NextFunction): void => {
    if (!config.security.privateMode) {
      next();
      return;
    }

    const configuredToken = config.security.ownerAccessToken;
    if (!configuredToken) {
      res.status(503).json({ error: "private_mode_misconfigured" });
      return;
    }

    const queryToken = typeof req.query.owner_token === "string" ? req.query.owner_token : undefined;
    if (queryToken && constantTimeEquals(queryToken, configuredToken)) {
      const isSecure = config.appEnv !== "development";
      res.setHeader(
        "Set-Cookie",
        `owner_token=${queryToken}; HttpOnly; Path=/; SameSite=Strict${isSecure ? "; Secure" : ""}`
      );
    }

    const provided = ownerTokenFromRequest(req) ?? queryToken;
    if (!provided || !constantTimeEquals(provided, configuredToken)) {
      res.status(401).json({ error: "unauthorized" });
      return;
    }

    next();
  };
}

export function ipAllowlistMiddleware(config: AppConfig) {
  return (req: Request, res: Response, next: NextFunction): void => {
    const ip = requestIp(req);
    if (!isAllowedIp(ip, config.security.allowlistIps)) {
      res.status(403).json({ error: "ip_not_allowed" });
      return;
    }
    next();
  };
}

export function globalRateLimitMiddleware(config: AppConfig) {
  return (req: Request, res: Response, next: NextFunction): void => {
    const limit = Math.max(1, config.security.requestLimitPerMinute);
    const ip = requestIp(req);
    if (!hitWindow(globalWindow, ip, limit)) {
      res.status(429).json({ error: "rate_limited", window_seconds: 60, limit });
      return;
    }
    next();
  };
}

export function sensitiveRateLimitMiddleware(config: AppConfig) {
  return (req: Request, res: Response, next: NextFunction): void => {
    const limit = Math.max(1, config.security.sensitiveRequestLimitPerMinute);
    const ip = requestIp(req);
    if (!hitWindow(sensitiveWindow, ip, limit)) {
      res.status(429).json({ error: "sensitive_rate_limited", window_seconds: 60, limit });
      return;
    }
    next();
  };
}
