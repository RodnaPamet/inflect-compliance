/**
 * Revoked consent is TERMINAL, not a job that fails every night forever.
 *
 * A user can withdraw consent from Google or Microsoft at any time, and neither
 * tells us. We find out only when a refresh fails.
 *
 * ═══ THE FAILURE MODE THIS EXISTS TO PREVENT ═══
 *
 * The quiet one. One user's push fails at 04:00, every night, indefinitely —
 * indistinguishable from noise until either somebody investigates or it drowns
 * the metric that would have shown a real outage. Nothing is broken enough to
 * page anyone and nothing is working.
 *
 * So a revocation is recognised, recorded on the connection, and STOPS being
 * scheduled. The user sees "reconnect" in their settings; we see a counter move
 * once rather than a failure every night.
 *
 * ═══ THIS IS WIRING, NOT MECHANISM ═══
 *
 * The terminal-failure chain already exists end to end and is not rebuilt here:
 *
 *   fetchOAuthToken   400 + invalid_grant / invalid_client / unauthorized_client
 *                     → IntegrationAuthError            (oauth-token-fetch, #1985)
 *   resilientFetch    401 / 403 → IntegrationAuthError
 *   shouldBypassQueueRetry(err)  → true for any IntegrationTerminalError
 *   executor-registry            → noRetry, recordQueueRetryBypass
 *   worker                       → UnrecoverableError
 *
 * A withdrawn consent surfaces as `400 invalid_grant` on refresh, which is
 * exactly what #1985 taught the layer to classify. Before it, that reached the
 * caller as a generic failure and `markAuthFailure` — which checks only for
 * `IntegrationAuthError` — silently returned false. The connection kept its dead
 * token and kept being scheduled. That is the bug this depends on being fixed,
 * so it is stated rather than assumed.
 *
 * ═══ WHY NOT connection-health.ts ═══
 *
 * `markAuthFailure` / `clearAuthFailure` are the right SHAPE and the wrong CODE.
 * They hardcode `db.integrationConnection.updateMany`, the columns they write
 * (`authFailedAt`, `authFailureReason`) exist on exactly one model, and their
 * metric is labelled by provider only — so per-user marks would be
 * indistinguishable in the series. Reused as a pattern, not as a function.
 *
 * @module usecases/calendar-consent-health
 */
import type { RequestContext } from '../types';
import { IntegrationAuthError, IntegrationRateLimitedError } from '../integrations/http-resilience';
import { revokeCalendarConnection, type CalendarProviderId } from './user-calendar-connection';
import {
    recordCalendarConsentRevoked,
    recordCalendarPushOutcome,
} from '@/lib/observability/integration-metrics';
import { logger } from '@/lib/observability/logger';

/** What one user's push run concluded. */
export type PushOutcome = 'pushed' | 'nothing-to-do' | 'revoked' | 'throttled' | 'failed';

/**
 * Is this error a withdrawn consent — i.e. permanently unfixable by retrying?
 *
 * NARROW ON PURPOSE. Only `IntegrationAuthError`, which the layer raises for
 * 401/403 and for the three RFC 6749 §5.2 credential codes on a 400. Widening
 * it to "any failure that looks auth-ish" would mark a connection revoked
 * because a provider had a bad afternoon, and the user's remedy for that —
 * reconnecting — does nothing, so they do it, it appears to work, and it breaks
 * again the same way.
 *
 * A rate limit is deliberately NOT terminal: it is the one failure that is
 * guaranteed to succeed later, and treating it as revocation would disconnect
 * the heaviest users first.
 */
export function isRevokedConsent(err: unknown): err is IntegrationAuthError {
    return err instanceof IntegrationAuthError;
}

/** Is this a throttle we should back off from rather than fail on? */
export function isThrottled(err: unknown): err is IntegrationRateLimitedError {
    return err instanceof IntegrationRateLimitedError;
}

/**
 * Record a withdrawn consent and stop scheduling this connection.
 *
 * Reuses `revokeCalendarConnection`, so the token is destroyed and the row
 * survives — the row being the only record that events were pushed under it,
 * which C4's cleanup still needs.
 *
 * The reason is a FIXED phrase, never the provider's body. A provider error can
 * carry a request id, an email address, or a tenant name, and this string is
 * rendered in the user's settings page.
 */
export async function markConsentRevoked(
    ctx: RequestContext,
    provider: CalendarProviderId,
    err: unknown,
): Promise<void> {
    const detail = err instanceof IntegrationAuthError ? `HTTP ${err.status}` : 'unknown';
    await revokeCalendarConnection(ctx, provider, `Access was withdrawn at the provider (${detail}). Reconnect to resume.`);
    recordCalendarConsentRevoked({ provider });
    logger.warn('calendar consent revoked — connection will not be scheduled again until reconnected', {
        component: 'calendar-consent-health',
        tenantId: ctx.tenantId,
        provider,
        detail,
    });
}

/**
 * Run one user's push, converting a revocation into a terminal, recorded state.
 *
 * ISOLATES THE FAILURE. Returns an outcome instead of throwing, because the
 * fan-out visits every connected user in the tenant and one revoked token must
 * not abort the batch for everybody else. That is the difference between "one
 * person needs to reconnect" and "the calendar feature stopped working
 * tonight".
 *
 * The one thing it deliberately does NOT swallow is an unexpected error: those
 * still return 'failed', which the caller counts and the queue can retry.
 * Swallowing everything would make a broken push indistinguishable from a quiet
 * one — the same conflation C3's outcome type exists to prevent.
 */
export async function runUserPushGuarded(
    ctx: RequestContext,
    provider: CalendarProviderId,
    push: () => Promise<{ changed: boolean }>,
): Promise<PushOutcome> {
    try {
        const { changed } = await push();
        const outcome: PushOutcome = changed ? 'pushed' : 'nothing-to-do';
        recordCalendarPushOutcome({ provider, outcome });
        return outcome;
    } catch (err) {
        if (isRevokedConsent(err)) {
            await markConsentRevoked(ctx, provider, err);
            recordCalendarPushOutcome({ provider, outcome: 'revoked' });
            return 'revoked';
        }
        if (isThrottled(err)) {
            // Not a failure of this connection and not the user's problem. The
            // next scheduled run picks it up; marking it revoked would
            // disconnect exactly the busiest tenants.
            recordCalendarPushOutcome({ provider, outcome: 'throttled' });
            logger.warn('calendar push throttled by the provider', {
                component: 'calendar-consent-health',
                tenantId: ctx.tenantId,
                provider,
            });
            return 'throttled';
        }
        recordCalendarPushOutcome({ provider, outcome: 'failed' });
        logger.error('calendar push failed', {
            component: 'calendar-consent-health',
            tenantId: ctx.tenantId,
            provider,
            err: err instanceof Error ? err : new Error(String(err)),
        });
        return 'failed';
    }
}
