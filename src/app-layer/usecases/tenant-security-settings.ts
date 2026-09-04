import { RequestContext } from '../types';
import { runInTenantContext } from '@/lib/db-context';
import { logEvent } from '../events/audit';
import { badRequest, forbidden } from '@/lib/errors/types';
import { checkWebhookUrl } from '@/app-layer/automation/webhook-safety';
import type { AiGuardMode, AiResidency } from '@prisma/client';

/**
 * Tenant security settings — the WRITE path.
 *
 * ── Why this file exists ────────────────────────────────────────────
 *
 * `TenantSecuritySettings` had exactly ONE writer in the whole repo
 * (`mfa.ts:97`), and it writes only `mfaPolicy` + `sessionMaxAgeMinutes`.
 * Every OTHER field on the model had a live consumer and no way to set it:
 *
 *   maxConcurrentSessions       ← src/lib/security/session-tracker.ts (Epic C.3)
 *   auditStreamUrl / …Secret…   ← src/app-layer/events/audit-stream.ts (Epic C.4)
 *   aiGuardMode                 ← src/app-layer/ai/guard/index.ts
 *   aiResidency / aiLocal*      ← src/app-layer/usecases/risk-suggestions.ts
 *   mfaFailClosed               ← src/auth.ts (fail-closed MFA enforcement)
 *
 * These are shipped, tested features that could not be switched on through
 * the product. Audit-event streaming is the clearest case: the buffer, HMAC
 * signing, retry with idempotency key and OTel metrics all exist and all
 * short-circuit on `if (!settings?.auditStreamUrl …)`.
 *
 * `mfaPolicy` and `sessionMaxAgeMinutes` are deliberately NOT writable here —
 * they already have an owner in `updateTenantMfaPolicy`, and two writers for
 * one field is how settings pages start clobbering each other.
 *
 * ── Patch semantics are load-bearing ────────────────────────────────
 *
 * Only keys PRESENT in the patch are written; `null` explicitly clears. This
 * is not ergonomics, it is correctness: `updateTenantMfaPolicy` upserts the
 * SAME ROW and its update block writes `sessionMaxAgeMinutes: input.… ?? null`
 * unconditionally. A second writer that sent a full row would silently reset
 * whatever the other one owns. Sending only what changed keeps the two
 * writers non-interfering.
 */

/** Reads are admin-only — the row carries an HMAC secret and session policy. */
function assertCanManageSecuritySettings(ctx: RequestContext) {
    if (!ctx.appPermissions.admin.manage) {
        throw forbidden('Only ADMIN or OWNER can manage tenant security settings');
    }
}

export interface TenantSecurityConfig {
    maxConcurrentSessions: number | null;
    auditStreamUrl: string | null;
    /**
     * The secret itself is NEVER returned. Callers only need to know whether
     * one is configured — the audit streamer refuses to deliver without it,
     * so its presence is the meaningful signal.
     */
    hasAuditStreamSecret: boolean;
    aiGuardMode: AiGuardMode;
    aiResidency: AiResidency;
    aiLocalBaseUrl: string | null;
    aiLocalModel: string | null;
    mfaFailClosed: boolean;
    /**
     * Epic Agentic — refuse `/api/mcp` traffic from a credential not bound to
     * an ACTIVE registered agent.
     *
     * Reported as TRUE when the row is absent, matching what the gate itself
     * does. A settings page that showed "off" for a tenant the gate is
     * enforcing would be worse than no page.
     */
    requireRegisteredAgent: boolean;
}

export interface TenantSecurityConfigPatch {
    maxConcurrentSessions?: number | null;
    auditStreamUrl?: string | null;
    auditStreamSecret?: string | null;
    aiGuardMode?: AiGuardMode;
    aiResidency?: AiResidency;
    aiLocalBaseUrl?: string | null;
    aiLocalModel?: string | null;
    mfaFailClosed?: boolean;
    requireRegisteredAgent?: boolean;
}

const MAX_CONCURRENT_SESSIONS_CEILING = 100;
const MIN_AUDIT_STREAM_SECRET_LENGTH = 16;

export async function getTenantSecurityConfig(
    ctx: RequestContext,
): Promise<TenantSecurityConfig> {
    assertCanManageSecuritySettings(ctx);

    return runInTenantContext(ctx, async (db) => {
        const row = await db.tenantSecuritySettings.findUnique({
            where: { tenantId: ctx.tenantId },
            select: {
                maxConcurrentSessions: true,
                auditStreamUrl: true,
                auditStreamSecretEncrypted: true,
                aiGuardMode: true,
                aiResidency: true,
                aiLocalBaseUrl: true,
                aiLocalModel: true,
                mfaFailClosed: true,
                requireRegisteredAgent: true,
            },
        });

        return {
            maxConcurrentSessions: row?.maxConcurrentSessions ?? null,
            auditStreamUrl: row?.auditStreamUrl ?? null,
            hasAuditStreamSecret: Boolean(row?.auditStreamSecretEncrypted),
            aiGuardMode: row?.aiGuardMode ?? ('BALANCED' as AiGuardMode),
            aiResidency: row?.aiResidency ?? ('EXTERNAL' as AiResidency),
            aiLocalBaseUrl: row?.aiLocalBaseUrl ?? null,
            aiLocalModel: row?.aiLocalModel ?? null,
            mfaFailClosed: row?.mfaFailClosed ?? false,
            // Absent row reads as ENFORCING — the same rule the gate applies,
            // stated in one more place because a settings page disagreeing with
            // the gate is how an operator turns off something already off and
            // believes the opposite.
            requireRegisteredAgent: row?.requireRegisteredAgent ?? true,
        };
    });
}

/**
 * Validate a tenant-supplied audit-stream endpoint at WRITE time.
 *
 * Delivery already runs through `safeFetch` (`audit-stream.ts:178`), which is
 * the authoritative guard — it re-resolves DNS and pins the connection. This
 * check is deliberately additive, for two reasons:
 *
 *   1. An operator typing an internal URL should get an error in the settings
 *      form, not a silent stream of failed deliveries hours later.
 *   2. It keeps unsafe values out of the database entirely, so the stored row
 *      is not itself a description of the internal network.
 *
 * The STRUCTURAL check (`checkWebhookUrl`) is used rather than
 * `assertPublicAddress` because the latter performs DNS resolution, and a
 * settings write should not fail because the operator's endpoint happens to
 * be briefly unresolvable. Delivery re-checks DNS every time regardless.
 */
function assertUsableAuditStreamUrl(rawUrl: string) {
    const verdict = checkWebhookUrl(rawUrl);
    if (!verdict.ok) {
        throw badRequest(
            `Audit stream URL rejected: ${verdict.reason ?? 'not a permitted destination'}`,
        );
    }
}

export async function updateTenantSecurityConfig(
    ctx: RequestContext,
    patch: TenantSecurityConfigPatch,
): Promise<TenantSecurityConfig> {
    assertCanManageSecuritySettings(ctx);

    const data: Record<string, unknown> = {};
    const changed: string[] = [];

    if (patch.maxConcurrentSessions !== undefined) {
        const v = patch.maxConcurrentSessions;
        if (v !== null) {
            // The lower bound of 1 is load-bearing, not decoration. The reader
            // in `session-tracker.ts` gates on `maxConcurrent > 0`, so a stored
            // 0 or -1 falls into the SAME branch as null and reads as
            // UNLIMITED. An admin typing 0 to mean "block additional sessions"
            // would get the exact opposite of what they asked for, silently.
            // Rejecting it here is the only place that can say so.
            if (!Number.isInteger(v) || v < 1 || v > MAX_CONCURRENT_SESSIONS_CEILING) {
                throw badRequest(
                    `maxConcurrentSessions must be an integer between 1 and ${MAX_CONCURRENT_SESSIONS_CEILING}, or null for unlimited. ` +
                    '0 is not accepted: the session tracker reads any value below 1 as unlimited.',
                );
            }
        }
        data.maxConcurrentSessions = v;
        changed.push('maxConcurrentSessions');
    }

    if (patch.auditStreamUrl !== undefined) {
        if (patch.auditStreamUrl !== null) assertUsableAuditStreamUrl(patch.auditStreamUrl);
        data.auditStreamUrl = patch.auditStreamUrl;
        changed.push('auditStreamUrl');
    }

    if (patch.auditStreamSecret !== undefined) {
        const s = patch.auditStreamSecret;
        if (s !== null && s.length < MIN_AUDIT_STREAM_SECRET_LENGTH) {
            throw badRequest(
                `auditStreamSecret must be at least ${MIN_AUDIT_STREAM_SECRET_LENGTH} characters`,
            );
        }
        // Written as PLAINTEXT. `auditStreamSecretEncrypted` is listed in the
        // Epic B manifest (encrypted-fields.ts:125), so the Prisma middleware
        // encrypts on write and decrypts on read. Encrypting here would
        // double-encrypt and the streamer's HMAC would silently sign with the
        // wrong key — the failure mode would be a SIEM rejecting every batch.
        data.auditStreamSecretEncrypted = s;
        changed.push('auditStreamSecret');
    }

    for (const key of ['aiGuardMode', 'aiResidency', 'mfaFailClosed', 'requireRegisteredAgent'] as const) {
        if (patch[key] !== undefined) {
            data[key] = patch[key];
            changed.push(key);
        }
    }

    for (const key of ['aiLocalBaseUrl', 'aiLocalModel'] as const) {
        if (patch[key] !== undefined) {
            data[key] = patch[key];
            changed.push(key);
        }
    }

    if (changed.length === 0) {
        throw badRequest('No settings supplied');
    }

    // LOCAL_ONLY residency with no gateway configured would send every AI call
    // to a provider the tenant just declared off-limits, or fail at call time.
    // Cross-field checks belong here rather than in the Zod schema because the
    // patch may set only ONE side and the other has to come from the stored row.
    return runInTenantContext(ctx, async (db) => {
        const before = await db.tenantSecuritySettings.findUnique({
            where: { tenantId: ctx.tenantId },
            select: {
                aiResidency: true,
                aiLocalBaseUrl: true,
                auditStreamUrl: true,
                auditStreamSecretEncrypted: true,
            },
        });

        // Audit streaming needs BOTH halves. `audit-stream.ts:137` bails unless
        // `auditStreamUrl` AND `auditStreamSecretEncrypted` are set, and the
        // buffered batch is then dropped — so configuring a URL with no secret
        // produces a settings page that says streaming is on while events are
        // silently discarded. Refusing the half-configuration is the only
        // moment we can tell the operator.
        const nextUrl =
            patch.auditStreamUrl !== undefined ? patch.auditStreamUrl : (before?.auditStreamUrl ?? null);
        const nextSecret =
            patch.auditStreamSecret !== undefined
                ? patch.auditStreamSecret
                : (before?.auditStreamSecretEncrypted ?? null);
        if (nextUrl && !nextSecret) {
            throw badRequest(
                'auditStreamUrl requires auditStreamSecret — the streamer refuses to deliver unsigned batches, so a URL without a secret would silently discard every event',
            );
        }

        const nextResidency = (patch.aiResidency ?? before?.aiResidency ?? 'EXTERNAL') as AiResidency;
        const nextLocalBase =
            patch.aiLocalBaseUrl !== undefined ? patch.aiLocalBaseUrl : (before?.aiLocalBaseUrl ?? null);
        if (nextResidency === 'LOCAL_ONLY' && !nextLocalBase) {
            throw badRequest(
                'aiResidency=LOCAL_ONLY requires aiLocalBaseUrl to be set (here or already stored)',
            );
        }

        await db.tenantSecuritySettings.upsert({
            where: { tenantId: ctx.tenantId },
            // The create branch carries ONLY the supplied fields. Everything
            // else falls to its schema default — notably `mfaPolicy`, which
            // this usecase must never author.
            create: { tenantId: ctx.tenantId, ...data },
            update: data,
        });

        await logEvent(db, ctx, {
            action: 'SECURITY_SETTINGS_UPDATED',
            entityType: 'TenantSecuritySettings',
            entityId: ctx.tenantId,
            details: `Updated tenant security settings: ${changed.join(', ')}`,
            detailsJson: {
                // `entity_lifecycle` because the enum in
                // json-columns.schemas.ts:28-35 has no `configuration` member.
                // This is not a cosmetic choice: `validateAuditDetailsJson`
                // THROWS on an unknown category, and this `logEvent` is awaited
                // inside the `runInTenantContext` transaction — so a bad
                // category would roll the settings write back and return 400 on
                // a perfectly valid request. Deliberately NOT wrapped in
                // `.catch()`: a security-config change must audit or fail
                // loudly. `AUDIT_DETAILS_JSON` below is asserted against the
                // real validator in the unit test for exactly this reason.
                category: 'entity_lifecycle',
                entityName: 'TenantSecuritySettings',
                operation: 'updated',
                // FIELD NAMES ONLY. One of these fields is an HMAC secret and
                // another is an internal endpoint; the audit trail records THAT
                // they changed, never what to.
                changedFields: changed,
            },
        });

        const row = await db.tenantSecuritySettings.findUnique({
            where: { tenantId: ctx.tenantId },
            select: {
                maxConcurrentSessions: true,
                auditStreamUrl: true,
                auditStreamSecretEncrypted: true,
                aiGuardMode: true,
                aiResidency: true,
                aiLocalBaseUrl: true,
                aiLocalModel: true,
                mfaFailClosed: true,
                requireRegisteredAgent: true,
            },
        });

        return {
            maxConcurrentSessions: row?.maxConcurrentSessions ?? null,
            auditStreamUrl: row?.auditStreamUrl ?? null,
            hasAuditStreamSecret: Boolean(row?.auditStreamSecretEncrypted),
            aiGuardMode: row?.aiGuardMode ?? ('BALANCED' as AiGuardMode),
            aiResidency: row?.aiResidency ?? ('EXTERNAL' as AiResidency),
            aiLocalBaseUrl: row?.aiLocalBaseUrl ?? null,
            aiLocalModel: row?.aiLocalModel ?? null,
            mfaFailClosed: row?.mfaFailClosed ?? false,
            // Absent row reads as ENFORCING — the same rule the gate applies,
            // stated in one more place because a settings page disagreeing with
            // the gate is how an operator turns off something already off and
            // believes the opposite.
            requireRegisteredAgent: row?.requireRegisteredAgent ?? true,
        };
    });
}
