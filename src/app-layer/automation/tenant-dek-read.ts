import { runWithAuditContext } from '@/lib/audit-context';

/**
 * The audit-context `source` the automation dispatchers read under.
 *
 * It must NOT be one of the encryption middleware's `BYPASS_SOURCES`
 * (`seed` / `job` / `system`). Those resolve to `NO_DEK_PAIR` by design —
 * they exist for genuinely cross-tenant work, which should fall back to the
 * global KEK rather than encrypt under one arbitrary tenant's DEK.
 *
 * These dispatchers are the opposite case. They are single-tenant: the
 * `tenantId` arrives on the job payload and every query already filters by
 * it. They want the tenant DEK. Labelling them `'job'` — which is the
 * natural-looking choice, since they *are* jobs — is what silently breaks
 * them.
 */
export const AUTOMATION_DISPATCH_SOURCE = 'automation';

/**
 * Run a tenant-scoped AutomationRule read with the tenant's DEK resolvable.
 *
 * ## Why this wrapper has to exist
 *
 * `AutomationRule.webhookSecretEncrypted` is in the Epic B manifest, so it
 * is stored as a `v2:` ciphertext under the tenant's own DEK. The encryption
 * middleware resolves that DEK from `getAuditContext()` — a module-level
 * stack in `@/lib/audit-context`, deliberately NOT AsyncLocalStorage,
 * because Prisma's middleware runs in a detached async context that loses
 * ALS state.
 *
 * `runJob` establishes a REQUEST context, which *is* AsyncLocalStorage
 * (`@/lib/observability/context`). Two different stores. So a job carrying a
 * perfectly good `tenantId` still leaves `getAuditContext()` undefined, the
 * DEK never resolves, the v2 decrypt throws, and the middleware's fail-open
 * catch returns the RAW CIPHERTEXT in place of the plaintext.
 *
 * `executeAction` then used that ciphertext as the HMAC key for
 * `X-Inflect-Signature`. Every outbound automation webhook was signed with a
 * key no consumer could possibly hold, and — because the effective key was
 * the exact bytes sitting in the database — encrypting the column bought
 * nothing against an attacker with DB read access, which is the one thing it
 * was there to do.
 *
 * ## Why the scope is the read only
 *
 * Widening the context over the action execution would change what the audit
 * middleware attributes for writes made inside it. That is a separate
 * decision with its own blast radius; decrypting the row needs only the read.
 */
export async function readRulesWithTenantDek<T>(
    tenantId: string,
    read: () => Promise<T>,
): Promise<T> {
    // `runWithAuditContext` is typed to return the callback's value OR a
    // promise of it (it pops the stack synchronously for sync callbacks and
    // via .finally for thenables). Awaiting collapses both to T.
    return await runWithAuditContext({ tenantId, source: AUTOMATION_DISPATCH_SOURCE }, read);
}
