/**
 * A tenant admin's one-time authorisation of a calendar provider.
 *
 * Microsoft only. Google's model is per-user consent and needs no tenant-level
 * record — the asymmetry is the decision, not an omission.
 *
 * ═══ WHAT THIS ROW ANSWERS ═══
 *
 * "Should the settings page offer this user Connect, or tell them to ask their
 * administrator?" Without it the only way to know is to attempt a connect and
 * read the error, which makes every user in an unauthorised tenant run a failed
 * OAuth round trip to discover a fact the tenant already knows — and makes the
 * answer depend on a third party being reachable.
 *
 * ═══ WHAT IT DOES NOT ANSWER ═══
 *
 * Not "these users may connect". Microsoft's tenant-wide grant admits ALL users
 * unless the app requires assignment, so this records that the door is open,
 * not who walked through it. Per-user opt-in is `UserCalendarConnection`.
 *
 * @module usecases/tenant-calendar-consent
 */
import type { RequestContext } from '../types';
import { runInTenantContext } from '@/lib/db-context';
import { badRequest } from '@/lib/errors/types';
import { logEvent } from '../events/audit';
import { logger } from '@/lib/observability/logger';

/** Only Microsoft uses tenant-level consent. */
export const ADMIN_CONSENT_PROVIDERS = ['outlook-calendar'] as const;
export type AdminConsentProvider = (typeof ADMIN_CONSENT_PROVIDERS)[number];

export function requiresAdminConsent(provider: string): provider is AdminConsentProvider {
    return (ADMIN_CONSENT_PROVIDERS as readonly string[]).includes(provider);
}

export interface ConsentState {
    provider: AdminConsentProvider;
    granted: boolean;
    grantedAt: Date | null;
    revokedAt: Date | null;
    /** The Entra tenant we were consented in — subsequent authorize URLs need it. */
    externalTenantId: string | null;
}

/**
 * Record that an admin granted tenant-wide consent.
 *
 * Upserts on (tenantId, provider), so re-granting REPLACES. A second row would
 * mean two authorisations, one of which nothing revokes.
 *
 * Re-granting also clears `revokedAt` — re-authorising after a withdrawal is the
 * whole remedy, and leaving the stamp would keep showing an error already fixed.
 *
 * AUDITED, unlike the per-user connect. A tenant-wide authorisation admitting
 * every user in the tenant to a third-party calendar API is precisely the event
 * an access review needs to find, and `grantedByUserId` is NOT NULL so it always
 * has an author.
 */
export async function recordAdminConsent(
    ctx: RequestContext,
    input: { provider: AdminConsentProvider; externalTenantId: string | null },
): Promise<ConsentState> {
    if (!requiresAdminConsent(input.provider)) {
        throw badRequest(`${input.provider} does not use tenant-wide admin consent`);
    }

    return runInTenantContext(ctx, async (db) => {
        const row = await db.tenantCalendarConsent.upsert({
            where: { tenantId_provider: { tenantId: ctx.tenantId, provider: input.provider } },
            create: {
                tenantId: ctx.tenantId,
                provider: input.provider,
                externalTenantId: input.externalTenantId,
                grantedByUserId: ctx.userId,
            },
            update: {
                externalTenantId: input.externalTenantId,
                grantedByUserId: ctx.userId,
                grantedAt: new Date(),
                revokedAt: null,
                revokedReason: null,
            },
        });

        await logEvent(db, ctx, {
            action: 'CALENDAR_ADMIN_CONSENT_GRANTED',
            entityType: 'Tenant',
            entityId: ctx.tenantId,
            details: `Tenant-wide calendar consent granted for ${input.provider}`,
            // `access`, not `entity_lifecycle`. The row is incidental; the
            // EVENT is that a third party was authorised to reach every user in
            // this tenant. An access review filtering on that category is the
            // reader this exists for.
            detailsJson: {
                category: 'access',
                operation: 'grant',
                summary: `Tenant-wide calendar consent granted for ${input.provider}`,
            },
            metadata: { provider: input.provider, externalTenantId: input.externalTenantId },
        });

        logger.info('tenant calendar consent granted', {
            component: 'tenant-calendar-consent',
            tenantId: ctx.tenantId,
            provider: input.provider,
        });
        return toState(row);
    });
}

/**
 * Withdraw the tenant-wide authorisation.
 *
 * Does NOT touch individual UserCalendarConnection rows. Those hold tokens
 * that are now unrefreshable, and the push path already treats a failed refresh
 * as terminal — so they resolve themselves, per user, with a recorded reason
 * each. Bulk-revoking them here would produce one indistinguishable mass event
 * and lose the per-user "why".
 *
 * What it DOES stop is new connections: the settings page reads this row.
 */
export async function revokeAdminConsent(
    ctx: RequestContext,
    provider: AdminConsentProvider,
    reason: string,
): Promise<void> {
    await runInTenantContext(ctx, async (db) => {
        const res = await db.tenantCalendarConsent.updateMany({
            where: { tenantId: ctx.tenantId, provider, revokedAt: null },
            data: { revokedAt: new Date(), revokedReason: reason.slice(0, 200) },
        });
        if (res.count === 0) return;

        await logEvent(db, ctx, {
            action: 'CALENDAR_ADMIN_CONSENT_REVOKED',
            entityType: 'Tenant',
            entityId: ctx.tenantId,
            details: `Tenant-wide calendar consent withdrawn for ${provider}`,
            detailsJson: {
                category: 'access',
                operation: 'revoke',
                summary: `Tenant-wide calendar consent withdrawn for ${provider}`,
            },
            metadata: { provider, reason: reason.slice(0, 200) },
        });
    });
}

/**
 * What the settings surface needs to decide between "Connect" and "ask your
 * administrator".
 *
 * Returns a row per admin-consent provider, whether or not one exists — an
 * absent row is a real answer ("nobody has authorised this"), and making the
 * caller distinguish undefined from not-granted is how that answer gets lost.
 */
export async function getConsentStates(ctx: RequestContext): Promise<ConsentState[]> {
    return runInTenantContext(ctx, async (db) => {
        const rows = await db.tenantCalendarConsent.findMany({
            where: { tenantId: ctx.tenantId },
            take: ADMIN_CONSENT_PROVIDERS.length,
        });
        const byProvider = new Map(rows.map((r) => [r.provider, r]));
        return ADMIN_CONSENT_PROVIDERS.map((provider) => {
            const row = byProvider.get(provider);
            return row
                ? toState(row)
                : { provider, granted: false, grantedAt: null, revokedAt: null, externalTenantId: null };
        });
    });
}

function toState(row: {
    provider: string;
    grantedAt: Date;
    revokedAt: Date | null;
    externalTenantId: string | null;
}): ConsentState {
    return {
        provider: row.provider as AdminConsentProvider,
        // Granted means granted AND not since withdrawn. A caller checking only
        // `grantedAt` would offer Connect after a revocation.
        granted: row.revokedAt === null,
        grantedAt: row.grantedAt,
        revokedAt: row.revokedAt,
        externalTenantId: row.externalTenantId,
    };
}
