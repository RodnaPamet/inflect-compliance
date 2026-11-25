/**
 * A user's consent to push their own compliance deadlines to their own calendar.
 *
 * ═══ THE TOKEN IS ENCRYPTED BY THE MANIFEST, UNDER THE TENANT'S OWN KEY ═══
 *
 * `UserCalendarConnection.tokenEncrypted` is in `ENCRYPTED_FIELDS`, so the
 * Prisma encryption extension writes it as a `v2:` ciphertext under the
 * tenant's DEK and decrypts it on read. This module hands it PLAINTEXT JSON and
 * reads plaintext JSON back; it never calls `encryptField` itself.
 *
 * It used to. Until #5937 the usecase called `encryptField` explicitly, which
 * is the GLOBAL key (`v1:`), and the model was absent from the manifest, so
 * neither rotation sweep saw the column: a master-KEK rotation followed by
 * retiring `DATA_ENCRYPTION_KEY_PREVIOUS` would have left every stored calendar
 * token undecryptable, and a tenant-DEK rotation never touched it at all. Being
 * in the manifest is what puts it in both sweeps (`jobs/key-rotation.ts`
 * re-encrypts `v1:` values, `jobs/tenant-dek-rotation.ts` re-encrypts `v2:`).
 *
 * Rows written before the move are `v1:` and keep reading: the extension
 * dispatches per value on the envelope prefix. Each is rewritten `v2:` the next
 * time it is WRITTEN — a reconnect, or the push's first token refresh, which an
 * hour-long access token makes the first push run. No backfill is needed for
 * correctness, and until then a `v1:` row is still covered by the master-KEK
 * sweep. See docs/calendar-push-design.md.
 *
 * A READ must run where the tenant's DEK resolves: inside `runInTenantContext`
 * (a request) or `runInTenantJobContext` (a job, with a non-bypass source).
 * Under a bypass source the extension cannot decrypt a `v2:` value, and this
 * module refuses the ciphertext it would be handed rather than parse it.
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
import { runInTenantContext, runInTenantJobContext, type PrismaTx } from '@/lib/db-context';
import { isEncryptedValue } from '@/lib/security/encryption';
import { badRequest, notFound, InternalError } from '@/lib/errors/types';
import { logger } from '@/lib/observability/logger';
import { logEvent } from '../events/audit';

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
    /**
     * Set while a disconnect is still removing pushed events (#5937 step 2):
     * the token is kept until they are gone or the retry window closes.
     */
    disconnectRequestedAt: Date | null;
    /**
     * Events Inflect pushed under this connection that are still recorded as
     * in the person's calendar. On a live connection that is just what has
     * been pushed. On a revoked or disconnecting one it is what a disconnect
     * could not (yet) remove — the events the person may have to delete by
     * hand, which the Connect control (step 4) tells them about.
     */
    undeletedEventCount: number;
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
): Promise<Omit<CalendarConnectionSummary, 'undeletedEventCount'>> {
    if (!isCalendarProviderId(input.provider)) {
        throw badRequest(`Unknown calendar provider: ${input.provider}`);
    }
    if (!input.token.refreshToken) {
        // Without one the connection works until the first expiry and then dies
        // silently overnight. Fail at consent, where the user is present and
        // can re-run it, rather than at 04:00 in a job nobody is watching.
        throw badRequest('Calendar consent did not return a refresh token — reconnect and grant offline access');
    }

    // Plaintext here; the encryption extension seals it under the tenant DEK on
    // the write (see the module note). The column name predates the move.
    const tokenEncrypted = JSON.stringify(input.token);

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
                // A reconnect ends a disconnect that was still removing events:
                // the person wants the calendar back, and the next push
                // reconciles whatever is left against the mapping table.
                disconnectRequestedAt: null,
            },
        });
        logger.info('calendar connection saved', {
            component: 'user-calendar-connection',
            tenantId: ctx.tenantId,
            provider: input.provider,
            // NEVER the token, the scopes' values, or the user's email.
            scopeCount: input.scopesGranted.length,
        });
        await logEvent(db, ctx, {
            action: 'CALENDAR_CONNECTED',
            entityType: 'UserCalendarConnection',
            entityId: row.id,
            details: `Personal calendar connected (${input.provider})`,
            detailsJson: {
                category: 'access',
                operation: 'grant',
                summary: `Personal calendar connected (${input.provider})`,
            },
            // The provider and how many scopes were granted. Never the token,
            // the code, or the scope values.
            metadata: { provider: input.provider, scopeCount: input.scopesGranted.length },
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
        return { connectionId: row.id, token: parseStoredToken(row.tokenEncrypted) };
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
            // Plaintext; sealed `v2:` by the extension. This is also the write
            // that moves a pre-#5937 `v1:` row onto the tenant key.
            data: { tokenEncrypted: JSON.stringify(token) },
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
        const count = await revokeIn(db, { tenantId: ctx.tenantId, userId: ctx.userId, provider }, reason);
        if (count === 0) throw notFound('No calendar connection to revoke');
    });
}

/** The one write that revokes: token destroyed, row kept, disconnect state cleared. */
async function revokeIn(db: PrismaTx, identity: CalendarConnectionIdentity, reason: string): Promise<number> {
    const res = await db.userCalendarConnection.updateMany({
        where: { tenantId: identity.tenantId, userId: identity.userId, provider: identity.provider },
        data: {
            revokedAt: new Date(),
            revokedReason: reason.slice(0, 200),
            tokenEncrypted: '',
            disconnectRequestedAt: null,
        },
    });
    if (res.count > 0) {
        logger.info('calendar connection revoked', {
            component: 'user-calendar-connection',
            tenantId: identity.tenantId,
            provider: identity.provider,
            reason: reason.slice(0, 200),
        });
    }
    return res.count;
}

// ─── The push path (#5937 step 2) ─────────────────────────────────────

/** One person's connection to one provider, as the push job names it. */
export interface CalendarConnectionIdentity {
    tenantId: string;
    userId: string;
    provider: CalendarProviderId;
}

/** The push job's own name: never a KEK-bypass label, so the tenant DEK resolves. */
export const CALENDAR_PUSH_JOB_SOURCE = 'calendar-push';

/**
 * Where a push-path read or write runs. The nightly job has no request, so it
 * binds the tenant with `runInTenantJobContext` under its OWN name — a bypass
 * label (`'job'`) would turn the tenant DEK off and the token read would come
 * back as ciphertext, which `parseStoredToken` refuses. A disconnect arrives in
 * a request and runs in the person's own `runInTenantContext`.
 */
export type CalendarTenantRun = <T>(callback: (db: PrismaTx) => Promise<T>) => Promise<T>;

export function calendarJobRun(tenantId: string): CalendarTenantRun {
    return (callback) => runInTenantJobContext({ tenantId, source: CALENDAR_PUSH_JOB_SOURCE }, callback);
}

export function calendarRequestRun(ctx: RequestContext): CalendarTenantRun {
    return (callback) => runInTenantContext(ctx, callback);
}

/**
 * A live connection's token, its disconnect state, and — for Microsoft — the
 * directory its token was issued in. Null for a revoked or absent connection.
 *
 * The directory is the workspace's recorded admin consent
 * (`TenantCalendarConsent.externalTenantId`), the authority the connect flow
 * sent the person to. A refresh must go to the SAME authority; sending it to
 * the deployment's own directory would be refused as `invalid_grant` and read
 * as a withdrawn consent. It is read whether or not Inflect's record of the
 * consent has since been withdrawn: whether Microsoft still honours the grant
 * is Microsoft's answer, and a refused refresh revokes the connection.
 */
export async function readCalendarConnectionForPush(
    run: CalendarTenantRun,
    identity: CalendarConnectionIdentity,
): Promise<{
    connectionId: string;
    token: CalendarTokenPayload;
    disconnectRequestedAt: Date | null;
    entraTenantId: string | undefined;
} | null> {
    return run(async (db) => {
        const row = await db.userCalendarConnection.findUnique({
            where: {
                tenantId_userId_provider: {
                    tenantId: identity.tenantId,
                    userId: identity.userId,
                    provider: identity.provider,
                },
            },
            select: { id: true, tokenEncrypted: true, revokedAt: true, disconnectRequestedAt: true },
        });
        if (!row || row.revokedAt) return null;
        let entraTenantId: string | undefined;
        if (identity.provider === 'outlook-calendar') {
            const consent = await db.tenantCalendarConsent.findUnique({
                where: { tenantId_provider: { tenantId: identity.tenantId, provider: identity.provider } },
                select: { externalTenantId: true },
            });
            entraTenantId = consent?.externalTenantId ?? undefined;
        }
        return {
            connectionId: row.id,
            token: parseStoredToken(row.tokenEncrypted),
            disconnectRequestedAt: row.disconnectRequestedAt,
            entraTenantId,
        };
    });
}

/**
 * Persist a rotated token. Called by `resolveCalendarAccessToken` BEFORE the
 * new token is used, because Microsoft invalidates the refresh token it
 * replaced. A connection revoked in the meantime matches nothing.
 */
export async function persistCalendarTokenForPush(
    run: CalendarTenantRun,
    identity: CalendarConnectionIdentity,
    token: CalendarTokenPayload,
): Promise<void> {
    await run(async (db) => {
        await db.userCalendarConnection.updateMany({
            where: { tenantId: identity.tenantId, userId: identity.userId, provider: identity.provider, revokedAt: null },
            data: { tokenEncrypted: JSON.stringify(token) },
        });
    });
}

/** Revoke from the push path. Silent when the connection is already gone. */
export async function revokeCalendarConnectionForPush(
    run: CalendarTenantRun,
    identity: CalendarConnectionIdentity,
    reason: string,
): Promise<void> {
    await run((db) => revokeIn(db, identity, reason));
}

/** Stamp a completed push. */
export async function stampCalendarPushed(
    run: CalendarTenantRun,
    identity: CalendarConnectionIdentity,
    at: Date,
): Promise<void> {
    await run(async (db) => {
        await db.userCalendarConnection.updateMany({
            where: { tenantId: identity.tenantId, userId: identity.userId, provider: identity.provider, revokedAt: null },
            data: { lastPushedAt: at },
        });
    });
}

/**
 * Mark a connection as disconnecting: the person asked to disconnect and some
 * pushed events are still in their calendar. The token is KEPT so the nightly
 * run can finish the removals. An earlier stamp is kept, so the retry window
 * is measured from the first request, not the last.
 */
export async function markCalendarDisconnecting(
    run: CalendarTenantRun,
    identity: CalendarConnectionIdentity,
    at: Date,
): Promise<void> {
    await run(async (db) => {
        await db.userCalendarConnection.updateMany({
            where: {
                tenantId: identity.tenantId,
                userId: identity.userId,
                provider: identity.provider,
                revokedAt: null,
                disconnectRequestedAt: null,
            },
            data: { disconnectRequestedAt: at },
        });
    });
}

/**
 * The outcomes the callback sends the person back with, as `?calendar=<outcome>`
 * on `/t/<slug>/calendar`. A closed set, so the Connect control (step 4) can
 * word each one and nothing else reaches the URL — a provider's own error code
 * or description is never reflected.
 */
export const CALENDAR_CONNECT_OUTCOMES = [
    'connected',
    /** The person declined at the provider (`error=access_denied`). */
    'connect_declined',
    /** The provider answered with any other error. */
    'provider_error',
    /** Microsoft: the tenant-wide admin consent was withdrawn mid-flow. */
    'consent_withdrawn',
    /**
     * Microsoft: Entra answered that the organisation has not consented (the
     * admin consent Inflect recorded was removed in the Entra portal, or never
     * reached this directory). The remedy is the administrator's.
     */
    'consent_required',
    /** The exchange succeeded but issued no refresh token. */
    'no_refresh_token',
    /** The flow cookie was absent, forged, expired, or for another state/person. */
    'flow_invalid',
    /** The code exchange or the save failed. */
    'connect_failed',
] as const;
export type CalendarConnectOutcome = (typeof CALENDAR_CONNECT_OUTCOMES)[number];

/**
 * Record a connect that did not complete, for a callback that resolved a
 * tenant context. Audited and logged with the OUTCOME and the provider's error
 * CODE only: never the authorization code, a token, the verifier, or the
 * provider's `error_description`, which is prose that can carry an email
 * address or a directory name.
 */
export async function recordCalendarConnectFailure(
    ctx: RequestContext,
    input: { provider: CalendarProviderId; outcome: Exclude<CalendarConnectOutcome, 'connected'>; providerErrorCode?: string | null },
): Promise<void> {
    // The provider's code is OAuth's own vocabulary (`access_denied`,
    // `invalid_scope`, …); anything outside its shape is dropped, not stored.
    const providerErrorCode =
        input.providerErrorCode && /^[a-z_]{1,64}$/.test(input.providerErrorCode) ? input.providerErrorCode : undefined;
    logger.warn('calendar connect did not complete', {
        component: 'user-calendar-connection',
        tenantId: ctx.tenantId,
        provider: input.provider,
        outcome: input.outcome,
        providerErrorCode,
    });
    await runInTenantContext(ctx, async (db) => {
        await logEvent(db, ctx, {
            action: 'CALENDAR_CONNECT_FAILED',
            // No connection row exists for a connect that never completed, so
            // the subject is the person who tried.
            entityType: 'User',
            entityId: ctx.userId,
            details: `Personal calendar connect did not complete (${input.provider}: ${input.outcome})`,
            detailsJson: {
                category: 'access',
                operation: 'grant_failed',
                summary: `Personal calendar connect did not complete (${input.provider}: ${input.outcome})`,
                reason: input.outcome,
            },
            metadata: { provider: input.provider, outcome: input.outcome, providerErrorCode },
        });
    });
}

/**
 * The stored payload, or a refusal. A value still carrying an envelope prefix
 * is a ciphertext the extension could not decrypt (no DEK in this context) —
 * parsing it would throw an error quoting it, and using it would be worse.
 */
function parseStoredToken(stored: string): CalendarTokenPayload {
    if (!stored || isEncryptedValue(stored)) {
        throw new InternalError('calendar token could not be decrypted in this context');
    }
    return JSON.parse(stored) as CalendarTokenPayload;
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
        const counts = await db.userCalendarEventMapping.groupBy({
            by: ['provider'],
            where: { tenantId: ctx.tenantId, userId: ctx.userId, NOT: { remoteEventId: '' } },
            _count: { _all: true },
        });
        const byProvider = new Map(counts.map((c) => [c.provider, c._count._all]));
        return rows.map((row) => ({ ...toSummary(row), undeletedEventCount: byProvider.get(row.provider) ?? 0 }));
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
    disconnectRequestedAt?: Date | null;
}): Omit<CalendarConnectionSummary, 'undeletedEventCount'> {
    return {
        id: row.id,
        provider: row.provider as CalendarProviderId,
        connectedAt: row.connectedAt,
        revokedAt: row.revokedAt,
        revokedReason: row.revokedReason,
        lastPushedAt: row.lastPushedAt,
        scopesGranted: row.scopesGranted,
        disconnectRequestedAt: row.disconnectRequestedAt ?? null,
    };
}
