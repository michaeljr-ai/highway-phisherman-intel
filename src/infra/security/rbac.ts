import type { NextFunction, Request, Response } from "express";
import { timingSafeEqual } from "node:crypto";
import { AppConfig } from "../../core/types.js";

export type AppRole = "viewer" | "analyst" | "admin";
export type AppPermission = "jobs:read" | "jobs:create" | "artifacts:read" | "health:read";

const rolePermissions: Record<AppRole, Set<AppPermission>> = {
  viewer: new Set(["jobs:read", "artifacts:read", "health:read"]),
  analyst: new Set(["jobs:read", "jobs:create", "artifacts:read", "health:read"]),
  admin: new Set(["jobs:read", "jobs:create", "artifacts:read", "health:read"])
};

function parseRole(input: string | undefined): AppRole | null {
  if (!input) return null;
  const normalized = input.toLowerCase();
  if (normalized === "viewer" || normalized === "analyst" || normalized === "admin") {
    return normalized;
  }
  return null;
}

function constantTimeEquals(a: string, b: string): boolean {
  const aBuf = Buffer.from(a);
  const bBuf = Buffer.from(b);
  if (aBuf.length !== bBuf.length) return false;
  return timingSafeEqual(aBuf, bBuf);
}

function resolveRequestRole(req: Request, config: AppConfig): AppRole {
  if (!config.security.rbacEnabled) {
    return "admin";
  }

  if (config.security.zeroTrustRequired) {
    const cfAccessJwt = req.header("cf-access-jwt-assertion");
    if (!cfAccessJwt) {
      return "viewer";
    }
  }

  const requestedRole = parseRole(req.header("x-role") ?? undefined) ?? "viewer";
  const configuredKey = config.security.roleKeys[requestedRole];
  const providedKey = req.header("x-api-key");

  if (config.security.requireRoleKeys) {
    if (!configuredKey || !providedKey || !constantTimeEquals(providedKey, configuredKey)) {
      return "viewer";
    }
    return requestedRole;
  }

  if (!configuredKey) {
    return requestedRole;
  }

  if (providedKey && constantTimeEquals(providedKey, configuredKey)) {
    return requestedRole;
  }

  return "viewer";
}

function hasPermission(role: AppRole, permission: AppPermission): boolean {
  return rolePermissions[role].has(permission);
}

export function requirePermission(config: AppConfig, permission: AppPermission) {
  return (req: Request, res: Response, next: NextFunction): void => {
    const role = resolveRequestRole(req, config);
    if (config.security.rbacEnabled) {
      res.setHeader("x-app-role", role);
    }

    if (!hasPermission(role, permission)) {
      res.status(403).json({
        error: "forbidden",
        message: `Role ${role} does not have ${permission}`
      });
      return;
    }

    next();
  };
}
