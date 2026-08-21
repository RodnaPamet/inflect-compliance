/**
 * A revoked consent stops, records, and does not take the batch with it.
 *
 * The failure this prevents is the quiet one: a job that fails for one user
 * every night forever, indistinguishable from noise until somebody investigates
 * or it drowns the metric that would have shown a real outage.
 *
 * So the assertions are about three separations that all look like pedantry
 * until one of them is missing:
 *
 *   revoked  vs  failed     — permanent and the user's to fix, vs a bug
 *   throttled vs revoked    — guaranteed to succeed later, vs never again
 *   one user vs the batch   — one person reconnecting, vs the feature stopping
 */
/**
 * Typed as the real function so `mock.calls[0][2]` — the user-facing reason —
 * is inspectable. `jest.fn(async () => {})` infers a zero-length parameter
 * tuple, and the assertion this file most needs is about the third argument.
 */
const revokeCalendarConnection = jest.fn<
    Promise<void>,
    [unknown, string, string]
>(async () => {});
const recordCalendarPushOutcome = jest.fn();
const recordCalendarConsentRevoked = jest.fn();

jest.mock('@/app-layer/usecases/user-calendar-connection', () => ({
    revokeCalendarConnection: (...a: unknown[]) =>
        revokeCalendarConnection(...(a as [unknown, string, string])),
}));
// Spread the real module and override only what this file asserts on. A factory
// that LISTS the functions is a snapshot of the module as it looked the day it
// was written: the next counter added upstream is `undefined` here, and calling
// undefined throws out of a caller contracted never to throw — so the red lands
// on an unrelated assertion in another file. The spread tracks the module by
// itself, and the exports nobody overrides stay real (a noop meter, no cost).
jest.mock('@/lib/observability/integration-metrics', () => ({
    ...jest.requireActual('@/lib/observability/integration-metrics'),
    recordCalendarPushOutcome: (...a: unknown[]) => recordCalendarPushOutcome(...a),
    recordCalendarConsentRevoked: (...a: unknown[]) => recordCalendarConsentRevoked(...a),
}));

import {
    runUserPushGuarded,
    isRevokedConsent,
    isThrottled,
    markConsentRevoked,
} from '@/app-layer/usecases/calendar-consent-health';
import {
    IntegrationAuthError,
    IntegrationRateLimitedError,
    IntegrationTerminalError,
} from '@/app-layer/integrations/http-resilience';
import { makeRequestContext } from '../helpers/make-context';

const ctx = makeRequestContext('EDITOR', { tenantId: 't1', userId: 'u1' });
const PROVIDER = 'google-calendar' as const;

beforeEach(() => jest.clearAllMocks());

describe('what counts as a withdrawn consent', () => {
    it('an IntegrationAuthError does — 401/403 and the 400 credential codes both arrive as one', () => {
        // #1985 made `400 invalid_grant` — which is exactly what a withdrawn
        // Google consent returns on refresh — raise IntegrationAuthError.
        // Before it, that reached the caller as a generic failure and the
        // connection kept its dead token and kept being scheduled.
        expect(isRevokedConsent(new IntegrationAuthError(401, 'https://x'))).toBe(true);
        expect(isRevokedConsent(new IntegrationAuthError(400, 'https://x'))).toBe(true);
    });

    it('a RATE LIMIT does NOT — it is the one failure guaranteed to succeed later', () => {
        // Treating a throttle as revocation disconnects the busiest tenants
        // first, and the user's remedy (reconnect) does nothing.
        expect(isRevokedConsent(new IntegrationRateLimitedError('https://x', 1000))).toBe(false);
        expect(isThrottled(new IntegrationRateLimitedError('https://x', 1000))).toBe(true);
    });

    it('a plain terminal error does NOT — a 404 is not a lost credential', () => {
        expect(isRevokedConsent(new IntegrationTerminalError(404, 'https://x'))).toBe(false);
    });

    it('an ordinary error does not', () => {
        expect(isRevokedConsent(new Error('socket hang up'))).toBe(false);
        expect(isRevokedConsent(undefined)).toBe(false);
    });
});

describe('a revocation is recorded and the connection stopped', () => {
    it('revokes the connection and counts it once', async () => {
        const out = await runUserPushGuarded(ctx, PROVIDER, async () => {
            throw new IntegrationAuthError(400, 'https://oauth2.googleapis.com/token');
        });
        expect(out).toBe('revoked');
        expect(revokeCalendarConnection).toHaveBeenCalledTimes(1);
        expect(recordCalendarConsentRevoked).toHaveBeenCalledWith({ provider: PROVIDER });
    });

    it('the reason shown to the user is a FIXED phrase, never the provider body', async () => {
        // A provider error can carry a request id, an email address or a tenant
        // name, and this string is rendered in the user's settings page.
        await markConsentRevoked(ctx, PROVIDER, new IntegrationAuthError(400, 'https://x?token=secret'));
        const reason = String(revokeCalendarConnection.mock.calls[0][2]);
        expect(reason).toMatch(/withdrawn at the provider/i);
        expect(reason).toMatch(/reconnect/i);
        expect(reason).not.toContain('secret');
        expect(reason).not.toContain('https://');
    });

    it('the revocation counter and the push counter are SEPARATE series', async () => {
        // If a revoked connection were ever re-scheduled, the push counter
        // would climb while the revocation counter stayed flat. That
        // divergence IS the "fails every night forever" state, made visible.
        await runUserPushGuarded(ctx, PROVIDER, async () => {
            throw new IntegrationAuthError(400, 'https://x');
        });
        expect(recordCalendarConsentRevoked).toHaveBeenCalledTimes(1);
        expect(recordCalendarPushOutcome).toHaveBeenCalledWith({ provider: PROVIDER, outcome: 'revoked' });
    });
});

describe('one user’s failure does not take the batch', () => {
    it.each([
        ['revoked', new IntegrationAuthError(400, 'https://x')],
        ['throttled', new IntegrationRateLimitedError('https://x', 1000)],
        ['failed', new Error('boom')],
    ])('a %s push RETURNS rather than throwing', async (expected, err) => {
        // The fan-out visits every connected user; a throw here is the
        // difference between "one person needs to reconnect" and "the calendar
        // feature stopped working tonight".
        await expect(runUserPushGuarded(ctx, PROVIDER, async () => { throw err; })).resolves.toBe(expected);
    });

    it('a throttle does NOT revoke the connection', async () => {
        await runUserPushGuarded(ctx, PROVIDER, async () => {
            throw new IntegrationRateLimitedError('https://x', 1000);
        });
        expect(revokeCalendarConnection).not.toHaveBeenCalled();
        expect(recordCalendarConsentRevoked).not.toHaveBeenCalled();
    });

    it('an unexpected error does NOT revoke either — it is a bug, not a lost consent', async () => {
        await runUserPushGuarded(ctx, PROVIDER, async () => { throw new Error('null is not an object'); });
        expect(revokeCalendarConnection).not.toHaveBeenCalled();
        expect(recordCalendarPushOutcome).toHaveBeenCalledWith({ provider: PROVIDER, outcome: 'failed' });
    });
});

describe('a successful run is still counted, and distinguishes work from no work', () => {
    it('reports pushed when something changed', async () => {
        await expect(runUserPushGuarded(ctx, PROVIDER, async () => ({ changed: true }))).resolves.toBe('pushed');
        expect(recordCalendarPushOutcome).toHaveBeenCalledWith({ provider: PROVIDER, outcome: 'pushed' });
    });

    it('reports nothing-to-do when the calendar was already correct', async () => {
        // A nightly run over an unchanged calendar should be the common case.
        // Counting it as 'pushed' would make the metric useless for spotting a
        // run that stopped doing anything.
        await expect(runUserPushGuarded(ctx, PROVIDER, async () => ({ changed: false }))).resolves.toBe('nothing-to-do');
        expect(recordCalendarPushOutcome).toHaveBeenCalledWith({ provider: PROVIDER, outcome: 'nothing-to-do' });
    });
});

describe('metric cardinality stays bounded', () => {
    it('no userId reaches a counter label', async () => {
        // One metric series per employee is how an observability change becomes
        // the outage — and per-user push means this surface has the most users
        // of any in the product.
        await runUserPushGuarded(ctx, PROVIDER, async () => ({ changed: true }));
        await runUserPushGuarded(ctx, PROVIDER, async () => { throw new IntegrationAuthError(400, 'https://x'); });
        for (const call of [...recordCalendarPushOutcome.mock.calls, ...recordCalendarConsentRevoked.mock.calls]) {
            expect(Object.keys(call[0] as object).sort()).not.toContain('userId');
            expect(JSON.stringify(call[0])).not.toContain('u1');
        }
    });
});
