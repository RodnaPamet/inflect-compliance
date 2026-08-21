/**
 * The audit-context `source` labels that mean "this writer does NOT speak on
 * behalf of one tenant".
 *
 * One list, three readers, and getting it wrong is silent in every direction —
 * which is why it lives in a leaf module with no imports rather than as a
 * private `const` in whichever file needed it first.
 *
 * ## Who reads it
 *
 *   1. `db/encryption-middleware.ts` — a bypass source resolves to
 *      `NO_DEK_PAIR`, so writes fall back to the global KEK (`v1:`) and reads
 *      of a `v2:` ciphertext hit `NoTenantDekError('by-design')`, whose
 *      documented handling is to return **`null` in place of the field**.
 *   2. `db/rls-middleware.ts` — a bypass source silences the
 *      `missing_tenant_context` tripwire, on the grounds that a cross-tenant
 *      sweep legitimately has no tenant bound.
 *   3. `db-context.ts::runInTenantJobContext` — REFUSES these labels, because
 *      a helper whose entire purpose is to bind one tenant cannot also be
 *      declaring itself tenant-less.
 *
 * ## Why `'job'` is the dangerous one
 *
 * It is the label a background job reaches for by name. It is also the label
 * that turns the tenant DEK off. A job that is genuinely single-tenant — the
 * `tenantId` arrives on its payload, every query already filters by it — and
 * that labels itself `'job'` gets:
 *
 *   - encrypted reads silently replaced by `null`, including on fields Prisma
 *     types as non-nullable `string`; and
 *   - encrypted writes sealed under the global KEK, so the row's envelope
 *     disagrees with every other row in that tenant.
 *
 * This is not hypothetical. `app-layer/automation/tenant-dek-read.ts` exists
 * because the automation dispatchers hit the read half of it: the middleware
 * handed back raw `v2:` ciphertext for `AutomationRule.webhookSecretEncrypted`
 * and `executeAction` used those bytes as the outbound HMAC key. Every webhook
 * was signed with a key no consumer could hold, and the effective key was the
 * exact bytes sitting in the database — which is the one thing encrypting the
 * column was there to prevent.
 *
 * So: a single-tenant job wants a tenant context and a source of its OWN name
 * (`'av-rescan'`, `'automation'`, …). Only genuinely cross-tenant work —
 * seeds, all-tenant sweeps, infrastructure — belongs on this list. Adding a
 * fourth entry is an architectural decision, not a routine change.
 */

/** @see the module docblock — every entry here disables the per-tenant DEK. */
export const KEK_BYPASS_SOURCES: ReadonlySet<string> = new Set<string>([
    'seed',
    'job',
    'system',
]);

/**
 * Is this audit-context `source` one of the tenant-less labels?
 *
 * `undefined` is deliberately NOT a bypass: an absent source means nobody
 * declared anything, which is the case the tripwire exists to shout about.
 */
export function isKekBypassSource(source: string | undefined | null): boolean {
    return source != null && KEK_BYPASS_SOURCES.has(source);
}
