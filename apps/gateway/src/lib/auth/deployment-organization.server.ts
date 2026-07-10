const ENV_GATEWAY_ORG_ID = "FICTA_GATEWAY_ORG_ID";

/**
 * A proxy's permanent registry is process-global, so a hosted Gateway must bind the deployment to one
 * WorkOS organization. This prevents two workspace admins from alternately replacing the same managed
 * registry file while both believe their own registry is active.
 */
export function deploymentOrganizationId(env: NodeJS.ProcessEnv = process.env): string {
  const id = env[ENV_GATEWAY_ORG_ID]?.trim();
  if (!id) {
    throw new Error(`${ENV_GATEWAY_ORG_ID} is required when AUTH_PROVIDER=workos (one organization per deployment)`);
  }
  if (!/^org_[A-Za-z0-9]{1,196}$/.test(id)) {
    throw new Error(`${ENV_GATEWAY_ORG_ID} is invalid (expected a WorkOS org_... identifier)`);
  }
  return id;
}
