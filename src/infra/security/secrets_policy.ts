import { AppConfig } from "../../core/types.js";

const hardwareBackedProviders = new Set(["cloudflare", "fly", "hsm"]);

export function assertSecurityPolicy(config: AppConfig): void {
  if (config.appEnv !== "production") {
    if (config.security.privateMode && !config.security.ownerAccessToken) {
      throw new Error("Security policy violation: PRIVATE_MODE=true but OWNER_ACCESS_TOKEN is unset.");
    }
    return;
  }

  if (!hardwareBackedProviders.has(config.security.secretsProvider)) {
    throw new Error(
      "Production policy violation: SECRETS_PROVIDER must be one of cloudflare|fly|hsm for hardware-backed secrets."
    );
  }

  if (
    config.security.rbacEnabled &&
    config.security.requireRoleKeys &&
    Object.keys(config.security.roleKeys).length === 0
  ) {
    throw new Error("Production policy violation: RBAC enabled but RBAC_ROLE_KEYS_JSON is empty.");
  }

  if (config.security.privateMode && !config.security.ownerAccessToken) {
    throw new Error("Production policy violation: PRIVATE_MODE=true but OWNER_ACCESS_TOKEN is unset.");
  }

  if (config.security.zeroTrustRequired && !config.cloudflare.zeroTrustAudience) {
    throw new Error("Production policy violation: ZERO_TRUST_REQUIRED=true but CLOUDFLARE_ZERO_TRUST_AUD is unset.");
  }
}
