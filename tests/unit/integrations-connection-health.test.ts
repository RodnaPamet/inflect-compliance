/**
 * Credential health on the connection — and, mostly, clearing it.
 *
 * Setting a "credential revoked" flag is the easy half and nearly useless on
 * its own. A banner that survives the admin fixing the credential is worse than
 * no banner: it trains people to ignore the one signal that means someone must
 * act. So most of these assert the CLEARING and the NARROWNESS, not the setting.
 */
import { markAuthFailure, clearAuthFailure } from '@/app-layer/integrations/connection-health';
import {
    IntegrationAuthError,
    IntegrationTerminalError,
    IntegrationRateLimitedError,
} from '@/app-layer/integrations/http-resilience';
import { IntegrationTimeoutError } from '@/app-layer/integrations/bounded-fetch';

type Call = { where: Record<string, unknown>; data: Record<string, unknown> };

function fakeDb(count = 1) {
    const calls: Call[] = [];
    return {
        calls,
        db: {
            integrationConnection: {
                updateMany: jest.fn(async (args: Call) => {
                    calls.push(args);
                    return { count };
                }),
            },
        } as never,
    };
}

const CONN = 'conn_123';

describe('markAuthFailure', () => {
    it('marks the connection when the CREDENTIAL was rejected', async () => {
        const { db, calls } = fakeDb();
        const at = new Date('2026-08-17T09:00:00Z');

        const marked = await markAuthFailure(db, CONN, new IntegrationAuthError(401, 'https://okta/x'), at);

        expect(marked).toBe(true);
        expect(calls).toHaveLength(1);
        expect(calls[0].where).toEqual({ id: CONN });
        expect(calls[0].data.authFailedAt).toBe(at);
        expect(String(calls[0].data.authFailureReason)).toContain('401');
    });

    it.each([
        ['a 404 — a deleted group is not a bad credential', new IntegrationTerminalError(404, 'https://okta/g')],
        ['a throttle', new IntegrationRateLimitedError('https://okta/x', 90_000)],
        ['a timeout', new IntegrationTimeoutError('https://okta/x', 30_000)],
        ['an ordinary network fault', new TypeError('fetch failed')],
    ])('does NOT mark on %s', async (_label, err) => {
        // Every one of these would put a "credential revoked" banner in front of
        // an admin whose credential is fine. That is the false alarm that
        // teaches people to ignore the banner entirely.
        const { db, calls } = fakeDb();

        expect(await markAuthFailure(db, CONN, err)).toBe(false);
        expect(calls).toHaveLength(0);
    });

    it('truncates a hostile reason instead of writing unbounded text', async () => {
        const { db, calls } = fakeDb();
        const long = new IntegrationAuthError(403, `https://x/${'y'.repeat(5_000)}`);

        await markAuthFailure(db, CONN, long);

        expect(String(calls[0].data.authFailureReason).length).toBeLessThanOrEqual(500);
    });
});

describe('clearAuthFailure', () => {
    it('clears BOTH fields, so no orphan reason outlives the flag', async () => {
        const { db, calls } = fakeDb(1);

        expect(await clearAuthFailure(db, CONN)).toBe(true);
        expect(calls[0].data).toEqual({ authFailedAt: null, authFailureReason: null });
    });

    it('is predicated on there being something to clear', async () => {
        // `authFailedAt: { not: null }` keeps the common case (already healthy)
        // to a no-op UPDATE that writes no row — cheap enough that every success
        // path can call it unconditionally, which is what stops the banner
        // going stale.
        const { db, calls } = fakeDb(0);

        expect(await clearAuthFailure(db, CONN)).toBe(false);
        expect(calls[0].where).toEqual({ id: CONN, authFailedAt: { not: null } });
    });
});
