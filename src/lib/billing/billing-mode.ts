/**
 * SAAS vs SELFHOSTED, in one place.
 *
 * Split out of `entitlements.ts` (#3328) rather than copied. The egress
 * allowlist needs the same answer, and `entitlements.ts` reaches
 * `runInTenantContext` -> Prisma, which is far too much to pull into the
 * SSRF guard: `webhook-safety.ts` imports `node:dns` and `undici` and
 * nothing else, and it runs in the worker. The alternative — re-deriving
 * `!process.env.STRIPE_SECRET_KEY` in a second place — is the drift this
 * repo keeps paying for, where two copies of one rule stop agreeing and
 * nothing fails.
 *
 * `entitlements.ts` re-exports both names, so every existing caller is
 * unchanged.
 */
export type BillingMode = 'SAAS' | 'SELFHOSTED';

/**
 * Read once at module load — billing mode does not change at runtime
 * (you'd have to restart the process to flip it).
 */
const BILLING_MODE: BillingMode = process.env.STRIPE_SECRET_KEY ? 'SAAS' : 'SELFHOSTED';

export function getBillingMode(): BillingMode {
    return BILLING_MODE;
}
