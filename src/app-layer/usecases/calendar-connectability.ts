/**
 * Whether a person can connect each calendar provider, and why not (#5937
 * step 4).
 *
 * ═══ ONE RULE, ASKED BY THE READ AND BY THE CONNECT ═══
 *
 * The Connect control on `/calendar` offers a provider only where the server
 * would accept the connect, so the rule lives here and both callers ask it:
 * `GET /calendar/connections` reports it per provider, and
 * `POST /calendar/connect` refuses with it. A page that computed it itself, or
 * a connect route with its own copy, would drift into offering a button the
 * server refuses — or refusing a button the page offers.
 *
 * The refusals, in the order they are asked:
 *
 *   NOT_CONFIGURED             this deployment has no OAuth client for the
 *                              provider (blank, or still the `.env` template's
 *                              placeholder). A connect would send the person to
 *                              the provider with no client id and a provider
 *                              error page. Asked first: nothing a workspace
 *                              admin does fixes it.
 *   ADMIN_CONSENT_NOT_GRANTED  Microsoft: no administrator of this workspace has
 *                              authorised calendar access for the organisation.
 *   ADMIN_CONSENT_WITHDRAWN    Microsoft: one did, and it has been withdrawn.
 *
 * Google has no organisation-wide step (owner decision 2026-11-25, the consent
 * model in docs/calendar-push-design.md): each person consents for
 * themselves, so a configured Google client is always connectable.
 *
 * The read never says anything about a person's CONNECTION — that is
 * `listCalendarConnections`. A live Outlook connection whose organisation
 * consent was withdrawn reads `connectable: false` here; the control says
 * what that means for the connection.
 *
 * @module usecases/calendar-connectability
 */
import { env } from '@/env';
import type { RequestContext } from '../types';
import { forbidden, ConflictError } from '@/lib/errors/types';
import {
    CALENDAR_PROVIDERS,
    type CalendarConnectionSummary,
    type CalendarProviderId,
} from './user-calendar-connection';
import { DISCONNECTED_REASON, DISCONNECTED_WITH_REMAINDER_REASON } from './calendar-push-person';
import { getConsentStates, requiresAdminConsent } from './tenant-calendar-consent';

export const CALENDAR_CONNECT_REFUSALS = [
    'NOT_CONFIGURED',
    'ADMIN_CONSENT_NOT_GRANTED',
    'ADMIN_CONSENT_WITHDRAWN',
] as const;
export type CalendarConnectRefusal = (typeof CALENDAR_CONNECT_REFUSALS)[number];

export interface CalendarProviderConnectability {
    provider: CalendarProviderId;
    connectable: boolean;
    /** Null exactly when `connectable` is true. */
    refusal: CalendarConnectRefusal | null;
}

/**
 * A template value is not a configured client. `.env.example`,
 * `.env.production.example` and `deploy/.env.prod.example` ship
 * `your-…` / `REPLACE_ME…` placeholders, and the env schema only asks for a
 * non-empty string, so a deployment that copied a template boots with one.
 */
function isUsableCredential(value: string | undefined | null): boolean {
    const v = (value ?? '').trim();
    if (v === '') return false;
    return !/^(your-|replace_me)/i.test(v);
}

/** This deployment holds an OAuth client (id AND secret) for the provider. */
export function calendarClientConfigured(provider: CalendarProviderId): boolean {
    if (provider === 'google-calendar') {
        return isUsableCredential(env.GOOGLE_CLIENT_ID) && isUsableCredential(env.GOOGLE_CLIENT_SECRET);
    }
    return isUsableCredential(env.MICROSOFT_CLIENT_ID) && isUsableCredential(env.MICROSOFT_CLIENT_SECRET);
}

interface ConsentLike {
    provider: string;
    granted: boolean;
    revokedAt: Date | null;
    externalTenantId: string | null;
}

function refusalFor(
    provider: CalendarProviderId,
    consents: readonly ConsentLike[],
): { refusal: CalendarConnectRefusal | null; externalTenantId: string | null } {
    if (!calendarClientConfigured(provider)) return { refusal: 'NOT_CONFIGURED', externalTenantId: null };
    if (!requiresAdminConsent(provider)) return { refusal: null, externalTenantId: null };
    const state = consents.find((c) => c.provider === provider);
    if (!state || !state.granted) {
        return {
            refusal: state?.revokedAt ? 'ADMIN_CONSENT_WITHDRAWN' : 'ADMIN_CONSENT_NOT_GRANTED',
            externalTenantId: null,
        };
    }
    return { refusal: null, externalTenantId: state.externalTenantId };
}

/** Per provider, in `CALENDAR_PROVIDERS` order. */
export async function readCalendarConnectability(
    ctx: RequestContext,
): Promise<CalendarProviderConnectability[]> {
    const needsConsent = CALENDAR_PROVIDERS.some((p) => requiresAdminConsent(p) && calendarClientConfigured(p));
    const consents = needsConsent ? await getConsentStates(ctx) : [];
    return CALENDAR_PROVIDERS.map((provider) => {
        const { refusal } = refusalFor(provider, consents);
        return { provider, connectable: refusal === null, refusal };
    });
}

/**
 * For the connect route: throws the refusal, or returns the directory a
 * Microsoft connect must be sent to (the one the organisation consent was
 * granted in — guessing again would send the person to an authority where the
 * grant does not exist).
 *
 * The thrown error carries `details.reason`, the refusal code, so the control
 * can word it in the person's language rather than show the server's English
 * sentence.
 */
export async function assertCalendarConnectable(
    ctx: RequestContext,
    provider: CalendarProviderId,
): Promise<{ entraTenantId: string | undefined }> {
    const consents =
        requiresAdminConsent(provider) && calendarClientConfigured(provider) ? await getConsentStates(ctx) : [];
    const { refusal, externalTenantId } = refusalFor(provider, consents);
    if (refusal === 'NOT_CONFIGURED') {
        throw new ConflictError('This calendar provider is not set up in this deployment.', {
            reason: refusal,
        });
    }
    if (refusal !== null) {
        // A refusal the person can act on: it names who has to act.
        throw forbidden('Your administrator has not yet authorised calendar access for this organisation.', {
            reason: refusal,
        });
    }
    return { entraTenantId: externalTenantId ?? undefined };
}

// ─── A connection's state, as the control words it ───────────────────

/**
 * `CONNECTED`      live; the nightly run pushes it.
 * `DISCONNECTING`  the person asked to disconnect and some pushed events are
 *                  still being removed (the token is kept until they are gone).
 * `DISCONNECTED`   the person disconnected it.
 * `STOPPED`        it ended without the person asking: the provider refused the
 *                  token (access withdrawn there), so "reconnect" is the remedy.
 *
 * Decided here rather than in the page because the only thing that tells the
 * last two apart is the stored revocation reason, which is the server's own
 * phrase — a page matching English text would break the day it is reworded.
 */
export const CALENDAR_CONNECTION_STATES = ['CONNECTED', 'DISCONNECTING', 'DISCONNECTED', 'STOPPED'] as const;
export type CalendarConnectionState = (typeof CALENDAR_CONNECTION_STATES)[number];

const DISCONNECTED_BY_PERSON: ReadonlySet<string> = new Set([DISCONNECTED_REASON, DISCONNECTED_WITH_REMAINDER_REASON]);

export function calendarConnectionStateOf(
    connection: Pick<CalendarConnectionSummary, 'revokedAt' | 'revokedReason' | 'disconnectRequestedAt'>,
): CalendarConnectionState {
    if (connection.revokedAt) {
        return connection.revokedReason && DISCONNECTED_BY_PERSON.has(connection.revokedReason)
            ? 'DISCONNECTED'
            : 'STOPPED';
    }
    return connection.disconnectRequestedAt ? 'DISCONNECTING' : 'CONNECTED';
}
