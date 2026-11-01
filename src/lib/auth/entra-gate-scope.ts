/**
 * The Microsoft Entra ID sign-in rules a session carries after sign-in (#4869).
 *
 * The group sync (`entra-group-sync.ts`) decides at sign-in, per workspace,
 * whether a Microsoft sign-in passes that workspace's group gate. A refusal
 * used to live only in the token's `memberships[]`, and the membership claims
 * are re-read from the database on a five-minute cadence — which put the
 * refused workspace straight back. So the refusal is now its own claim,
 * `entraGateDeniedTenantIds`: the re-read leaves those workspaces out, and the
 * DB-backed workspace gates (`getTenantCtx`, `getLegacyCtx`,
 * `getTenantServerContext`) refuse them, as they refuse an SSO-scoped session
 * outside its workspace. It lasts for the session; the next Microsoft sign-in
 * decides again.
 *
 * Pure, with no imports, so every gate can read it.
 */

/** The refusal every gate gives a workspace the Entra group gate refused at sign-in. */
export const ENTRA_GATE_REFUSAL =
    "This workspace's Microsoft Entra ID rules did not admit your sign-in. Ask an administrator of the workspace to check its group mappings and allowed domains.";

/** True when the Entra group gate refused this session the workspace at sign-in. */
export function isRefusedByEntraGate(
    deniedTenantIds: readonly string[] | null | undefined,
    tenantId: string,
): boolean {
    return Array.isArray(deniedTenantIds) && deniedTenantIds.includes(tenantId);
}

/** A domain as typed into the allowed list: trimmed, lower case, no leading `@`. */
export function normaliseAllowedDomain(domain: string): string {
    return domain.trim().toLowerCase().replace(/^@+/, '');
}

/**
 * Whether a sign-in's email is from one of a workspace's allowed domains.
 *
 * An empty list allows every domain. The match is the whole domain, case
 * insensitive, as the SSO providers' check is: `contoso.com` does not admit
 * `mail.contoso.com`. A sign-in with no email, or one with no domain, is not
 * from an allowed domain when there is a list.
 */
export function emailDomainAllowed(email: string | null | undefined, domains: readonly string[]): boolean {
    const allowed = domains.map(normaliseAllowedDomain).filter((d) => d.length > 0);
    if (allowed.length === 0) return true;
    const at = (email ?? '').lastIndexOf('@');
    if (at < 0) return false;
    const domain = (email ?? '').slice(at + 1).trim().toLowerCase();
    return domain.length > 0 && allowed.includes(domain);
}
