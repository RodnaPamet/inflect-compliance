/**
 * A user's consent to push their own compliance deadlines to their own calendar.
 *
 * ═══ WHY THE TOKEN IS ENCRYPTED HERE AND NOT BY THE MANIFEST ═══
 *
 * `encryptField` / `decryptField` are called EXPLICITLY at this layer, and
 * `UserCalendarConnection` is deliberately absent from `ENCRYPTED_FIELDS`.
 * That follows `IntegrationConnection`, whose own note in the manifest explains
 * the split: a credential does not live in a manifest-managed column, it goes
 * through a dedicated `*Encrypted` field written and read by its usecase.
 *
 * The whole OAuth payload is ONE ciphertext blob rather than three columns, so
 * a partial write cannot leave a refresh token stranded without the expiry that
 * says when to use it — the state that looks connected and silently never
 * refreshes.
 *
 * ═══ REVOKE KEEPS THE ROW ═══
 *
 * `revokeConnection` nulls the token and stamps `revokedAt`; it does not
 * delete. Two reasons, and the second is the one that bites:
 *
 *   - the settings surface can say "reconnect" rather than showing a blank
 *     slate that looks like the feature was never set up;
 *   - the row is the only local record that events were EVER pushed under this
 *     connection. Deleting it strands whatever is already sitting in the user's
 *     personal calendar, with nothing left to name it. C4's cleanup reads this
 *     row, so DISCONNECT MUST DELETE THE REMOTE EVENTS FIRST and drop the token
 *     after — the reverse order leaves events in a calendar we can no longer
 *     reach.
 *
 * @module usecases/user-calendar-connection
 */
import type { RequestContext } from '../types';
import { runInTenantContext } from '@/lib/db-context';
import { encryptField, decryptField } from '@/lib/security/encryption';
import { badRequest, notFound } from '@/lib/errors/types';
import { logger } from '@/lib/observability/logger';

/** The providers a user may connect. */
export const CALENDAR_PROVIDERS = ['google-calendar', 'outlook-calendar'] as const;
export type CalendarProviderId = (typeof CALENDAR_PROVIDERS)[number];

export function isCalendarProviderId(id: string): id is CalendarProviderId {
    return (CALENDAR_PROVIDERS as readonly string[]).includes(id);
}

/** The decrypted shape stored in `tokenEncrypted`. */
export interface CalendarTokenPayload {
    accessToken: string;
    refreshToken: string;
    /** Unix seconds. */
    expiresAt: number;
}

export interface CalendarConnectionSummary {
    id: string;
    provider: CalendarProviderId;
    connectedAt: Date;
    revokedAt: Date | null;
    revokedReason: string | null;
    lastPushedAt: Date | null;
    scopesGranted: string[];
}

/**
 * Store (or replace) a user's consent.
 *
 * Keyed on (tenantId, userId, provider) via upsert, so re-consenting REPLACES
 * rather than accumulating. A second row for the same triple would mean two
 * tokens, one of which nothing refreshes and nothing revokes.
 *
 * Re-consent also clears `revokedAt` and `revokedReason` — reconnecting after a
 * revocation is the entire remedy the settings surface offers, and leaving the
 * stamp set would keep showing the user an error they have already fixed.
 */
export async function saveCalendarConnection(
    ctx: RequestContext,
    input: {
        provider: CalendarProviderId;
        token: CalendarTokenPayload;
        scopesGranted: string[];
    },
): Promise<CalendarConnectionSummary> {
    if (!isCalendarProviderId(input.provider)) {
        throw badRequest(`Unknown calendar provider: ${input.provider}`);
    }
    if (!input.token.refreshToken) {
        // Without one the connection works until the first expiry and then dies
        // silently overnight. Fail at consent, where the user is present and
        // can re-run it, rather than at 04:00 in a job nobody is watching.
        throw badRequest('Calendar consent did not return a refresh token — reconnect and grant offline access');
    }

    const tokenEncrypted = encryptField(JSON.stringify(input.token));

    return runInTenantContext(ctx, async (db) => {
        const row = await db.userCalendarConnection.upsert({
            where: {
                tenantId_userId_provider: {
                    tenantId: ctx.tenantId,
                    userId: ctx.userId,
                    provider: input.provider,
                },
            },
            create: {
                tenantId: ctx.tenantId,
                userId: ctx.userId,
                provider: input.provider,
                tokenEncrypted,
                scopesGranted: input.scopesGranted,
            },
            update: {
                tokenEncrypted,
                scopesGranted: input.scopesGranted,
                revokedAt: null,
                revokedReason: null,
            },
        });
        logger.info('calendar connection saved', {
            component: 'user-calendar-connection',
            tenantId: ctx.tenantId,
            provider: input.provider,
            // NEVER the token, the scopes' values, or the user's email.
            scopeCount: input.scopesGranted.length,
        });
        return toSummary(row);
    });
}

/**
 * Read a connection's decrypted token for a push run.
 *
 * Returns null for a revoked connection rather than throwing, because the push
 * fan-out visits many users and one revoked token must not abort the batch.
 */
export async function readCalendarToken(
    ctx: RequestContext,
    provider: CalendarProviderId,
): Promise<{ connectionId: string; token: CalendarTokenPayload } | null> {
    return runInTenantContext(ctx, async (db) => {
        const row = await db.userCalendarConnection.findUnique({
            where: {
                tenantId_userId_provider: { tenantId: ctx.tenantId, userId: ctx.userId, provider },
            },
            select: { id: true, tokenEncrypted: true, revokedAt: true },
        });
        if (!row || row.revokedAt) return null;
        return { connectionId: row.id, token: JSON.parse(decryptField(row.tokenEncrypted)) as CalendarTokenPayload };
    });
}

/** Persist a rotated token after a refresh, without touching anything else. */
export async function updateCalendarToken(
    ctx: RequestContext,
    provider: CalendarProviderId,
    token: CalendarTokenPayload,
): Promise<void> {
    await runInTenantContext(ctx, async (db) => {
        // updateMany, not update: a revoked-in-the-meantime connection should
        // silently match nothing rather than resurrect itself with a fresh
        // token because a refresh was already in flight.
        await db.userCalendarConnection.updateMany({
            where: { tenantId: ctx.tenantId, userId: ctx.userId, provider, revokedAt: null },
            data: { tokenEncrypted: encryptField(JSON.stringify(token)) },
        });
    });
}

/**
 * Mark a connection revoked and DESTROY the stored token.
 *
 * The token is overwritten with an empty string rather than left in place: once
 * consent is gone the ciphertext is a credential we can no longer use and no
 * longer need, and keeping it only widens what a database compromise yields.
 *
 * The ROW survives — see the module note. Callers doing a user-initiated
 * disconnect must delete the pushed remote events BEFORE calling this.
 */
export async function revokeCalendarConnection(
    ctx: RequestContext,
    provider: CalendarProviderId,
    reason: string,
): Promise<void> {
    await runInTenantContext(ctx, async (db) => {
        const res = await db.userCalendarConnection.updateMany({
            where: { tenantId: ctx.tenantId, userId: ctx.userId, provider },
            data: { revokedAt: new Date(), revokedReason: reason.slice(0, 200), tokenEncrypted: '' },
        });
        if (res.count === 0) throw notFound('No calendar connection to revoke');
        logger.info('calendar connection revoked', {
            component: 'user-calendar-connection',
            tenantId: ctx.tenantId,
            provider,
            reason: reason.slice(0, 200),
        });
    });
}

/** What the settings surface shows. Never includes the token. */
export async function listCalendarConnections(
    ctx: RequestContext,
): Promise<CalendarConnectionSummary[]> {
    return runInTenantContext(ctx, async (db) => {
        const rows = await db.userCalendarConnection.findMany({
            where: { tenantId: ctx.tenantId, userId: ctx.userId },
            orderBy: { provider: 'asc' },
            take: CALENDAR_PROVIDERS.length,
        });
        return rows.map(toSummary);
    });
}

function toSummary(row: {
    id: string;
    provider: string;
    connectedAt: Date;
    revokedAt: Date | null;
    revokedReason: string | null;
    lastPushedAt: Date | null;
    scopesGranted: string[];
}): CalendarConnectionSummary {
    return {
        id: row.id,
        provider: row.provider as CalendarProviderId,
        connectedAt: row.connectedAt,
        revokedAt: row.revokedAt,
        revokedReason: row.revokedReason,
        lastPushedAt: row.lastPushedAt,
        scopesGranted: row.scopesGranted,
    };
}
